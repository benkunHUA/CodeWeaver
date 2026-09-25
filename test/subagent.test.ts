import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ContentBlock, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { AgentLoop, type ToolRoundReminder } from "../src/agent/AgentLoop.js";
import { Session } from "../src/agent/Session.js";
import { SilentToolPresenter, type ToolPresenter } from "../src/agent/ToolPresenter.js";
import { subagentPrompt, systemPrompt } from "../src/agent/systemPrompt.js";
import { HookBus, createDefaultHooks } from "../src/hooks/index.js";
import { DenyAllApprovalPrompt, createDefaultPermissionPipeline } from "../src/permission/index.js";
import { TODO_REMINDER_TEXT, TodoReminder, TodoStore } from "../src/planning/index.js";
import {
  ConsoleSubagentPresenter,
  SilentSubagentPresenter,
  SubagentRunner,
  SUBAGENT_MAX_TURNS,
  SUBAGENT_NO_SUMMARY,
  subagentTurnLimitMessage,
} from "../src/subagent/index.js";
import type { SubagentLauncher, SubagentPresenter, TaskInput } from "../src/subagent/index.js";
import { FileLockRegistry } from "../src/tools/core/FileLockRegistry.js";
import { Tool } from "../src/tools/core/Tool.js";
import { ToolContext } from "../src/tools/core/ToolContext.js";
import type { JsonSchemaObject } from "../src/tools/core/validate.js";
import { createDefaultTools } from "../src/tools/createDefaultTools.js";
import { TaskTool } from "../src/tools/TaskTool.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { createWorkspace } from "../src/workspace.js";
import type { Conversation, ModelClient, ModelRequest, ModelResponse } from "../src/types.js";

const text = (value: string): ContentBlock => ({
  type: "text", text: value, citations: null,
});
const readTool = (id: string, path: string): ContentBlock => ({
  type: "tool_use", id, name: "read_file", input: { path }, caller: { type: "direct" },
});
const writeTool = (id: string, path: string, content: string): ContentBlock => ({
  type: "tool_use", id, name: "write_file", input: { path, content }, caller: { type: "direct" },
});
const bashTool = (id: string, command: string): ContentBlock => ({
  type: "tool_use", id, name: "bash", input: { command }, caller: { type: "direct" },
});
const todoWriteTool = (id: string, content: string): ContentBlock => ({
  type: "tool_use",
  id,
  name: "todo_write",
  input: { todos: [{ content, status: "pending" }] },
  caller: { type: "direct" },
});
const taskTool = (id: string, prompt: string): ContentBlock => ({
  type: "tool_use", id, name: "task", input: { prompt }, caller: { type: "direct" },
});

/** Scripted fake client; it records every request and pops one response per call. */
function fakeClient(responses: ModelResponse[]) {
  const requests: ModelRequest[] = [];
  const client: ModelClient = {
    messages: {
      async create(request) {
        requests.push(structuredClone(request));
        const response = responses.shift();
        assert.ok(response, "Unexpected extra model turn");
        return response;
      },
    },
  };
  return { client, requests };
}

/** Registry composed the way `config.ts` does, with an optional session TodoStore. */
async function buildRegistry(
  root: string,
  options: {
    readonly overrides?: readonly Tool<unknown>[] | undefined;
    readonly todos?: TodoStore | undefined;
    readonly log?: ((message: string) => void) | undefined;
  } = {},
): Promise<ToolRegistry> {
  const workspace = await createWorkspace(root);
  const log = options.log ?? (() => {});
  const context = new ToolContext({
    workspace,
    locks: new FileLockRegistry(),
    logger: log,
    todos: options.todos,
  });
  const registry = new ToolRegistry({ context, logger: log });
  for (const instance of createDefaultTools({ overrides: options.overrides })) {
    registry.register(instance);
  }
  return registry;
}

/** Runner wired with the test model and the delegated system prompt. */
function buildRunner(options: {
  readonly client: ModelClient;
  readonly root: string;
  readonly registry: ToolRegistry;
  readonly presenter?: SubagentPresenter | undefined;
  readonly reminder?: ToolRoundReminder | undefined;
  readonly hooks?: HookBus | undefined;
  readonly maxTurns?: number | undefined;
}): SubagentRunner {
  return new SubagentRunner({
    client: options.client,
    model: "test-model",
    system: subagentPrompt(options.root),
    registry: options.registry,
    workspaceRoot: options.root,
    ...(options.presenter === undefined ? {} : { presenter: options.presenter }),
    ...(options.reminder === undefined ? {} : { reminder: options.reminder }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
  });
}

/** Presenter that records every call into a caller-owned event log. */
class RecordingSubagentPresenter implements SubagentPresenter {
  readonly #events: string[];

  constructor(events: string[]) {
    this.#events = events;
  }

  showStart(): void {
    this.#events.push("showStart");
  }

  showFinish(): void {
    this.#events.push("showFinish");
  }

  showStopped(): void {
    this.#events.push("showStopped");
  }

  showToolCall(name: string, _input: unknown): void {
    this.#events.push(`showToolCall:${name}`);
  }

  showResult(result: string, toolName: string): void {
    this.#events.push(`showResult:${toolName}:${result}`);
  }

  count(event: string): number {
    return this.#events.filter((entry) => entry === event).length;
  }
}

/**
 * A `bash` replacement injected through `createDefaultTools({ overrides })`.
 * It mirrors the built-in name/schema and reports whether it ever ran.
 */
class BashStubTool extends Tool<{ readonly command: string }> {
  readonly name = "bash";
  readonly description = "执行 shell 命令。";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  };

  readonly #handler: (input: { readonly command: string }) => Promise<string>;

  constructor(handler: (input: { readonly command: string }) => Promise<string>) {
    super();
    this.#handler = handler;
  }

  protected async run(input: { readonly command: string }): Promise<string> {
    if (typeof input.command !== "string") throw new Error("missing command");
    return this.#handler(input);
  }
}

/** The parent harness's `task` tool, delegating to whatever launcher it is given. */
class TaskStubTool extends Tool<TaskInput> {
  readonly name = "task";
  readonly description = "Run a subagent with a fresh conversation.";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { prompt: { type: "string" } },
    required: ["prompt"],
  };

  readonly #launcher: SubagentLauncher;

  constructor(launcher: SubagentLauncher) {
    super();
    this.#launcher = launcher;
  }

  protected async run(input: TaskInput): Promise<string> {
    return this.#launcher.run(input.prompt);
  }
}

/** Message content asserted to be a block array, so individual blocks are reachable. */
function blocksOf(message: Conversation[number] | undefined): ContentBlockParam[] {
  assert.ok(message, "expected an appended message");
  assert.ok(Array.isArray(message.content), "expected block content");
  return message.content;
}

/** Every string-bodied tool_result content in the conversation, in order. */
function toolResultContents(messages: Conversation): string[] {
  const contents: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_result" && typeof block.content === "string") {
        contents.push(block.content);
      }
    }
  }
  return contents;
}

test("returns only the final assistant text, joining every text block with a newline", async () => {
  const { client, requests } = fakeClient([
    { content: [readTool("r1", "a.txt")], stop_reason: "tool_use" },
    { content: [text("part one"), text("part two")], stop_reason: "end_turn" },
  ]);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-text-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const registry = await buildRegistry(root);
    const events: string[] = [];
    const presenter = new RecordingSubagentPresenter(events);
    const runner = buildRunner({ client, root, registry, presenter });

    const result = await runner.run("inspect a.txt");

    assert.equal(result, "part one\npart two");
    assert.equal(requests.length, 2);
    assert.equal(presenter.count("showFinish"), 1);
    assert.equal(presenter.count("showStopped"), 0);
    assert.deepEqual(events, [
      "showStart",
      "showToolCall:read_file",
      "showResult:read_file:alpha",
      "showFinish",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns the no-summary placeholder when the final turn carries no text block", async () => {
  const { client } = fakeClient([{ content: [], stop_reason: "end_turn" }]);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-empty-"));
  try {
    const registry = await buildRegistry(root);
    const events: string[] = [];
    const presenter = new RecordingSubagentPresenter(events);
    const runner = buildRunner({ client, root, registry, presenter });

    const result = await runner.run("say nothing");

    assert.equal(SUBAGENT_NO_SUMMARY, "(no summary)");
    assert.equal(result, SUBAGENT_NO_SUMMARY);
    assert.equal(presenter.count("showFinish"), 1);
    assert.equal(presenter.count("showStopped"), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maxTurns stops the subagent with the limit message and no showFinish", async () => {
  const { client, requests } = fakeClient([
    { content: [readTool("r1", "a.txt")], stop_reason: "tool_use" },
    { content: [readTool("r2", "a.txt")], stop_reason: "tool_use" },
    { content: [text("never reached")], stop_reason: "end_turn" },
  ]);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-limit-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const registry = await buildRegistry(root);
    const events: string[] = [];
    const presenter = new RecordingSubagentPresenter(events);
    const runner = buildRunner({ client, root, registry, presenter, maxTurns: 2 });

    const result = await runner.run("never finish");

    assert.equal(requests.length, 2, "the cap is checked before asking the model again");
    assert.equal(result, subagentTurnLimitMessage(2));
    assert.equal(result, "Subagent stopped after 2 turns without a final answer.");
    assert.equal(presenter.count("showStopped"), 1);
    assert.equal(presenter.count("showFinish"), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the default cap is 30 model requests before the same script stops", async () => {
  const responses: ModelResponse[] = [
    ...Array.from({ length: SUBAGENT_MAX_TURNS }, (_, index): ModelResponse => ({
      content: [readTool(`r${index}`, "a.txt")],
      stop_reason: "tool_use",
    })),
    { content: [text("never reached")], stop_reason: "end_turn" },
  ];
  const { client, requests } = fakeClient(responses);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-default-limit-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const registry = await buildRegistry(root);
    const runner = buildRunner({ client, root, registry, presenter: new SilentSubagentPresenter() });

    const result = await runner.run("never finish");

    assert.equal(SUBAGENT_MAX_TURNS, 30);
    assert.equal(requests.length, 30, "the subagent runs the full default budget");
    assert.equal(result, subagentTurnLimitMessage(SUBAGENT_MAX_TURNS));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the subagent never sees the parent conversation", async () => {
  const { client, requests } = fakeClient([
    { content: [text("child answer")], stop_reason: "end_turn" },
  ]);
  const parentHistory: Conversation = [
    { role: "user", content: "parent question" },
    { role: "assistant", content: [text("parent answer")] },
  ];
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-isolated-"));
  try {
    const registry = await buildRegistry(root);
    const runner = buildRunner({ client, root, registry, presenter: new SilentSubagentPresenter() });

    const result = await runner.run("subtask prompt");

    assert.equal(result, "child answer");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.messages, [{ role: "user", content: "subtask prompt" }]);
    assert.deepEqual(parentHistory, [
      { role: "user", content: "parent question" },
      { role: "assistant", content: [text("parent answer")] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each run() starts from a brand-new session", async () => {
  const { client, requests } = fakeClient([
    { content: [text("first answer")], stop_reason: "end_turn" },
    { content: [text("second answer")], stop_reason: "end_turn" },
  ]);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-fresh-"));
  try {
    const registry = await buildRegistry(root);
    const runner = buildRunner({ client, root, registry, presenter: new SilentSubagentPresenter() });

    assert.equal(await runner.run("first question"), "first answer");
    assert.equal(await runner.run("second question"), "second answer");

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]?.messages, [{ role: "user", content: "first question" }]);
    assert.deepEqual(
      requests[1]?.messages,
      [{ role: "user", content: "second question" }],
      "the second run must not carry the first run's prompt or answer",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subagent tools run through the injected registry workspace", async () => {
  const { client } = fakeClient([
    { content: [writeTool("w1", "out.txt", "pong")], stop_reason: "tool_use" },
    { content: [text("wrote out.txt")], stop_reason: "end_turn" },
  ]);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-write-"));
  try {
    const registry = await buildRegistry(root);
    const runner = buildRunner({ client, root, registry, presenter: new SilentSubagentPresenter() });

    const result = await runner.run("write out.txt");

    assert.equal(result, "wrote out.txt");
    assert.equal(await readFile(join(root, "out.txt"), "utf8"), "pong");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a subagent has no task tool, so it cannot delegate again", async () => {
  const { client, requests } = fakeClient([
    { content: [taskTool("t1", "nested")], stop_reason: "tool_use" },
    { content: [text("child done")], stop_reason: "end_turn" },
  ]);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-notask-"));
  try {
    const registry = await buildRegistry(root);
    const hooks = new HookBus();
    const observed: string[] = [];
    hooks.register("PostToolUse", ({ toolName, result }) => {
      observed.push(`${toolName}:${result}`);
    });
    const events: string[] = [];
    const presenter = new RecordingSubagentPresenter(events);
    const runner = buildRunner({ client, root, registry, hooks, presenter });

    const result = await runner.run("delegate further");

    assert.equal(registry.get("task"), undefined);
    assert.equal(registry.schemas().length, 8, "the child registry only has the eight base tools");
    assert.deepEqual(observed, ["task:Unknown: task"]);
    assert.equal(requests.length, 2);
    assert.equal(result, "child done");
    assert.equal(presenter.count("showStart"), 1, "no second-level subagent is started");
    assert.equal(presenter.count("showFinish"), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permission checks apply to subagent tool calls", async () => {
  const { client } = fakeClient([
    { content: [bashTool("b1", "sudo ls")], stop_reason: "tool_use" },
    { content: [text("child done")], stop_reason: "end_turn" },
  ]);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-permission-"));
  try {
    let bashRan = false;
    const registry = await buildRegistry(root, {
      overrides: [
        new BashStubTool(async () => {
          bashRan = true;
          return "SHOULD NOT RUN";
        }),
      ],
    });
    const hooks = createDefaultHooks({
      checker: createDefaultPermissionPipeline({
        workspaceRoot: root,
        approval: new DenyAllApprovalPrompt(),
      }),
      workspaceRoot: root,
      log: () => {},
    });
    // The Stop hook sees the child's own message list, so the tool_result that
    // the loop fed back to the subagent is observable here.
    const sessions: Conversation[] = [];
    hooks.register("Stop", ({ messages }) => {
      sessions.push(messages);
    });
    const events: string[] = [];
    const presenter = new RecordingSubagentPresenter(events);
    const runner = buildRunner({ client, root, registry, hooks, presenter });

    await runner.run("run sudo");

    assert.equal(bashRan, false, "a denied call must never reach the bash tool");
    assert.deepEqual(toolResultContents(sessions[0] ?? []), ["Permission denied."]);
    assert.ok(events.includes("showResult:bash:Permission denied."));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the subagent uses its own TodoStore, leaving the parent's list untouched", async () => {
  const { client } = fakeClient([
    { content: [todoWriteTool("t1", "child task")], stop_reason: "tool_use" },
    { content: [text("planned")], stop_reason: "end_turn" },
  ]);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-todos-"));
  try {
    const parentStore = new TodoStore();
    parentStore.update([{ content: "parent task", status: "pending" }]);
    const parentRegistry = await buildRegistry(root, { todos: parentStore });
    const childStore = new TodoStore();
    const childRegistry = await buildRegistry(root, { todos: childStore });
    assert.notEqual(parentRegistry.context.todos, childRegistry.context.todos);

    const runner = buildRunner({
      client,
      root,
      registry: childRegistry,
      presenter: new SilentSubagentPresenter(),
    });
    assert.equal(await runner.run("plan the subtask"), "planned");

    assert.deepEqual(parentStore.list.items, [{ content: "parent task", status: "pending" }]);
    assert.deepEqual(childStore.list.items, [{ content: "child task", status: "pending" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the subagent loop does not reset the parent's reminder counter", async () => {
  const { client, requests } = fakeClient([
    { content: [readTool("r1", "a.txt")], stop_reason: "tool_use" },
    { content: [readTool("r2", "a.txt")], stop_reason: "tool_use" },
    { content: [taskTool("t1", "subtask")], stop_reason: "tool_use" },
    { content: [text("sub result")], stop_reason: "end_turn" },
    { content: [text("done")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-reminder-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const hooks = new HookBus();
    const childRegistry = await buildRegistry(root);
    const childRunner = buildRunner({
      client,
      root,
      registry: childRegistry,
      hooks,
      reminder: new TodoReminder(),
      presenter: new SilentSubagentPresenter(),
    });
    const parentRegistry = await buildRegistry(root, { overrides: [new TaskStubTool(childRunner)] });
    const parentLoop = new AgentLoop({
      client,
      model: "test-model",
      system: subagentPrompt(root),
      registry: parentRegistry,
      workspaceRoot: root,
      hooks,
      reminder: new TodoReminder(),
      presenter: new SilentToolPresenter(),
    });

    await parentLoop.run(new Session(messages));

    // Rounds one and two ignore the todo tool; the third round delegates to a
    // subagent. Its loop calls beginRun() on its *own* reminder, so the parent
    // counter still reaches the threshold and this round carries the reminder.
    assert.equal(requests.length, 5, "four parent turns plus one child turn");
    assert.deepEqual(blocksOf(messages[6]), [
      { type: "tool_result", tool_use_id: "t1", content: "sub result" },
      { type: "text", text: TODO_REMINDER_TEXT },
    ]);
    assert.deepEqual(blocksOf(messages[2]), [
      { type: "tool_result", tool_use_id: "r1", content: "alpha" },
    ]);
    assert.deepEqual(blocksOf(messages[4]), [
      { type: "tool_result", tool_use_id: "r2", content: "alpha" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ConsoleSubagentPresenter prints the s06 wording verbatim", () => {
  const lines: string[] = [];
  const presenter = new ConsoleSubagentPresenter({ log: (line) => lines.push(line) });
  presenter.showStart();
  presenter.showToolCall("bash", { command: "printf hi" });
  presenter.showResult("alpha", "read_file");
  presenter.showFinish();
  presenter.showStopped();
  assert.deepEqual(lines, [
    "\n\x1b[35m[子智能体] 已启动\x1b[0m",
    "  \x1b[90m[子智能体] read_file: alpha\x1b[0m",
    "\x1b[35m[子智能体] 已完成\x1b[0m",
    "\x1b[35m[子智能体] 已停止（达到轮次上限）\x1b[0m",
  ]);
});

test("ConsoleSubagentPresenter truncates the result preview to 100 code points", () => {
  const lines: string[] = [];
  const presenter = new ConsoleSubagentPresenter({ log: (line) => lines.push(line) });
  presenter.showResult(`${"x".repeat(10)}${"🚀".repeat(120)}`, "bash");
  assert.deepEqual(lines, [
    `  \x1b[90m[子智能体] bash: ${"x".repeat(10)}${"🚀".repeat(90)}\x1b[0m`,
  ]);
});

test("SilentSubagentPresenter never writes anything", () => {
  const presenter = new SilentSubagentPresenter();
  const original = console.log;
  // A throwing replacement proves the presenter never reaches the logger.
  console.log = (() => {
    throw new Error("SilentSubagentPresenter must not log");
  }) as typeof console.log;
  try {
    assert.doesNotThrow(() => {
      presenter.showStart();
      presenter.showToolCall("bash", { command: "printf hi" });
      presenter.showResult("some result", "bash");
      presenter.showFinish();
      presenter.showStopped();
    });
  } finally {
    console.log = original;
  }
});

/** The eight base tools plus the real `task` tool, run against a fresh context. */
async function buildParentRegistry(
  root: string,
  launcher?: SubagentLauncher | undefined,
): Promise<ToolRegistry> {
  const workspace = await createWorkspace(root);
  const context = new ToolContext({
    workspace,
    locks: new FileLockRegistry(),
    subagents: launcher,
  });
  const registry = new ToolRegistry({ context });
  for (const tool of createDefaultTools({ overrides: [new TaskTool()] })) {
    registry.register(tool);
  }
  return registry;
}

test("the task tool schema is pinned verbatim", () => {
  assert.deepEqual(new TaskTool().toAnthropicSchema(), {
    name: "task",
    description: "把边界清晰的子任务委派给拥有全新上下文的子智能体，只返回其最终结论。",
    input_schema: {
      type: "object",
      properties: { prompt: { type: "string", minLength: 1 } },
      required: ["prompt"],
    },
  });
});

test("the task tool rejects a missing or empty prompt through the shared validator", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-task-schema-"));
  try {
    const registry = await buildParentRegistry(root);

    assert.equal(await registry.invoke("task", {}), "Error: Invalid input for task: prompt is required");
    assert.equal(
      await registry.invoke("task", { prompt: "" }),
      "Error: Invalid input for task: task.prompt must have at least 1 characters",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the task tool forwards the prompt to the context launcher and returns its answer", async () => {
  const calls: string[] = [];
  const launcher: SubagentLauncher = {
    async run(prompt) {
      calls.push(prompt);
      return "found: node 22";
    },
  };
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-task-delegate-"));
  try {
    const registry = await buildParentRegistry(root, launcher);

    assert.equal(await registry.invoke("task", { prompt: "find the framework" }), "found: node 22");
    assert.deepEqual(calls, ["find the framework"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the task tool fails closed when the context forbids delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-task-closed-"));
  try {
    const registry = await buildParentRegistry(root);

    assert.equal(
      await registry.invoke("task", { prompt: "do something" }),
      "Error: Subagent delegation is not available in this context",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createDefaultTools() still returns the eight base tools without task", () => {
  assert.deepEqual(
    createDefaultTools().map((tool) => tool.name),
    ["bash", "read_file", "write_file", "edit_file", "glob", "todo_write", "load_skill", "compact"],
  );
});

test("the parent registry delegates through a real SubagentRunner", async () => {
  const { client, requests } = fakeClient([
    { content: [text("child answer")], stop_reason: "end_turn" },
  ]);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-task-real-"));
  try {
    const childRegistry = await buildRegistry(root);
    const runner = buildRunner({
      client,
      root,
      registry: childRegistry,
      presenter: new SilentSubagentPresenter(),
    });
    const registry = await buildParentRegistry(root, runner);

    const result = await registry.invoke("task", { prompt: "find the framework" });

    assert.equal(result, "child answer");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.messages, [{ role: "user", content: "find the framework" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Parent-side presenter that records every call into a caller-owned event log. */
class RecordingToolPresenter implements ToolPresenter {
  readonly #events: string[];

  constructor(events: string[]) {
    this.#events = events;
  }

  showToolCall(name: string, _input: unknown): void {
    this.#events.push(`showToolCall:${name}`);
  }

  showResult(result: string, toolName: string): void {
    this.#events.push(`showResult:${toolName}:${result}`);
  }
}

/**
 * Parent/child wiring mirroring `src/config.ts`: one workspace and one lock
 * registry shared by both sides, a child context holding only the eight base
 * tools, and a parent context that adds the delegation port plus the real
 * `task` tool. Each side owns its own `TodoStore` and `TodoReminder`.
 */
async function buildWiredHarness(options: {
  readonly root: string;
  readonly client: ModelClient;
  readonly presenter?: SubagentPresenter | undefined;
  readonly parentPresenter?: ToolPresenter | undefined;
}): Promise<{
  readonly loop: AgentLoop;
  readonly childRegistry: ToolRegistry;
  readonly parentRegistry: ToolRegistry;
}> {
  const workspace = await createWorkspace(options.root);
  const locks = new FileLockRegistry();

  const childContext = new ToolContext({ workspace, locks, todos: new TodoStore() });
  const childRegistry = new ToolRegistry({ context: childContext });
  for (const tool of createDefaultTools()) childRegistry.register(tool);

  const subagents = new SubagentRunner({
    client: options.client,
    model: "test-model",
    system: subagentPrompt(options.root),
    registry: childRegistry,
    workspaceRoot: options.root,
    reminder: new TodoReminder(),
    maxTurns: SUBAGENT_MAX_TURNS,
    presenter: options.presenter,
  });

  const parentContext = new ToolContext({
    workspace,
    locks,
    todos: new TodoStore(),
    subagents,
  });
  const parentRegistry = new ToolRegistry({ context: parentContext });
  for (const tool of createDefaultTools()) parentRegistry.register(tool);
  parentRegistry.register(new TaskTool());

  const loop = new AgentLoop({
    client: options.client,
    model: "test-model",
    system: systemPrompt(options.root),
    registry: parentRegistry,
    workspaceRoot: options.root,
    reminder: new TodoReminder(),
    presenter: options.parentPresenter,
  });

  return { loop, childRegistry, parentRegistry };
}

test("the wired parent registry delegates end to end through a real SubagentRunner", async () => {
  const responses: ModelResponse[] = [
    { content: [taskTool("t1", "summarize a.txt")], stop_reason: "tool_use" },
    { content: [readTool("c1", "a.txt")], stop_reason: "tool_use" },
    { content: [text("child summary")], stop_reason: "end_turn" },
    { content: [text("parent final answer")], stop_reason: "end_turn" },
  ];
  const { client, requests } = fakeClient(responses);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-wired-e2e-"));
  const childEvents: string[] = [];
  const childPresenter = new RecordingSubagentPresenter(childEvents);
  try {
    await writeFile(join(root, "a.txt"), "CHILD-ONLY-FILE-CONTENT");
    const harness = await buildWiredHarness({
      root,
      client,
      presenter: childPresenter,
      parentPresenter: new SilentToolPresenter(),
    });
    assert.equal(harness.childRegistry.schemas().length, 8, "the child keeps the eight base tools");
    assert.equal(harness.parentRegistry.schemas().length, 9, "the parent adds the task tool");
    const messages: Conversation = [{ role: "user", content: "delegate the reading" }];

    await harness.loop.run(new Session(messages));

    assert.equal(requests.length, 4, "parent, child, child, parent");
    assert.equal(responses.length, 0, "the scripted queue is drained exactly once");
    // Exactly one tool_result in the parent history, carrying the child summary.
    assert.deepEqual(toolResultContents(messages), ["child summary"]);
    assert.deepEqual(blocksOf(messages[2]), [
      { type: "tool_result", tool_use_id: "t1", content: "child summary" },
    ]);
    assert.deepEqual(blocksOf(messages[3]), [text("parent final answer")]);
    // The child did read the file, yet nothing of its intermediate state leaks
    // into the parent conversation.
    assert.equal(childEvents.includes("showResult:read_file:CHILD-ONLY-FILE-CONTENT"), true);
    assert.equal(JSON.stringify(messages).includes("CHILD-ONLY-FILE-CONTENT"), false);
    assert.equal(childPresenter.count("showStart"), 1);
    assert.equal(childPresenter.count("showFinish"), 1);
    assert.equal(childPresenter.count("showStopped"), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the parent request carries systemPrompt while the child request carries subagentPrompt", async () => {
  const responses: ModelResponse[] = [
    { content: [taskTool("t1", "summarize a.txt")], stop_reason: "tool_use" },
    { content: [text("child summary")], stop_reason: "end_turn" },
    { content: [text("parent final answer")], stop_reason: "end_turn" },
  ];
  const { client, requests } = fakeClient(responses);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-wired-prompt-"));
  try {
    const harness = await buildWiredHarness({
      root,
      client,
      presenter: new SilentSubagentPresenter(),
      parentPresenter: new SilentToolPresenter(),
    });

    await harness.loop.run(new Session([{ role: "user", content: "delegate the reading" }]));

    assert.equal(requests.length, 3);
    assert.equal(responses.length, 0, "the scripted queue is drained exactly once");
    assert.deepEqual(
      requests.map((request) => request.system),
      [systemPrompt(root), subagentPrompt(root), systemPrompt(root)],
      "the two parent requests surround the single delegated child request",
    );
    assert.deepEqual(requests[0]?.messages, [{ role: "user", content: "delegate the reading" }]);
    assert.deepEqual(
      requests[1]?.messages,
      [{ role: "user", content: "summarize a.txt" }],
      "the child conversation starts from the delegated prompt alone",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the parent presenter only sees the task result, never the subagent's own tool results", async () => {
  const responses: ModelResponse[] = [
    { content: [taskTool("t1", "summarize a.txt")], stop_reason: "tool_use" },
    { content: [readTool("c1", "a.txt")], stop_reason: "tool_use" },
    { content: [text("child summary")], stop_reason: "end_turn" },
    { content: [text("parent final answer")], stop_reason: "end_turn" },
  ];
  const { client } = fakeClient(responses);
  const root = await mkdtemp(join(tmpdir(), "cw-subagent-wired-presenter-"));
  const parentEvents: string[] = [];
  try {
    await writeFile(join(root, "a.txt"), "CHILD-ONLY-FILE-CONTENT");
    const harness = await buildWiredHarness({
      root,
      client,
      presenter: new SilentSubagentPresenter(),
      parentPresenter: new RecordingToolPresenter(parentEvents),
    });

    await harness.loop.run(new Session([{ role: "user", content: "delegate the reading" }]));

    assert.deepEqual(parentEvents, ["showToolCall:task", "showResult:task:child summary"]);
    assert.equal(JSON.stringify(parentEvents).includes("CHILD-ONLY-FILE-CONTENT"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
