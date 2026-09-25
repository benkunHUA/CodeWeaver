import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ContentBlock, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { AgentLoop, type ToolRoundReminder } from "../src/agent/AgentLoop.js";
import { Session } from "../src/agent/Session.js";
import { ConsoleToolPresenter, SilentToolPresenter, type ToolPresenter } from "../src/agent/ToolPresenter.js";
import { systemPrompt } from "../src/agent/systemPrompt.js";
import { HookBus, createDefaultHooks } from "../src/hooks/index.js";
import { DenyAllApprovalPrompt, createDefaultPermissionPipeline } from "../src/permission/index.js";
import {
  TodoReminder,
  TODO_REMINDER_TEXT,
  TODO_REMINDER_THRESHOLD,
  TODO_REMINDER_TOOL,
} from "../src/planning/index.js";
import { FileLockRegistry } from "../src/tools/core/FileLockRegistry.js";
import { Tool } from "../src/tools/core/Tool.js";
import { ToolContext } from "../src/tools/core/ToolContext.js";
import type { JsonSchemaObject } from "../src/tools/core/validate.js";
import { createDefaultTools } from "../src/tools/createDefaultTools.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { createWorkspace } from "../src/workspace.js";
import type { Conversation, ModelClient, ModelRequest, ModelResponse } from "../src/types.js";

const text = (value: string): ContentBlock => ({
  type: "text", text: value, citations: null,
});
const tool = (id: string, command: string): ContentBlock => ({
  type: "tool_use", id, name: "bash", input: { command }, caller: { type: "direct" },
});
const readTool = (id: string, path: string): ContentBlock => ({
  type: "tool_use", id, name: "read_file", input: { path }, caller: { type: "direct" },
});
const globTool = (id: string, pattern: string): ContentBlock => ({
  type: "tool_use", id, name: "glob", input: { pattern }, caller: { type: "direct" },
});
const unknownTool = (id: string): ContentBlock => ({
  type: "tool_use", id, name: "not_a_tool", input: {}, caller: { type: "direct" },
});
const orderTool = (id: string): ContentBlock => ({
  type: "tool_use", id, name: "order", input: {}, caller: { type: "direct" },
});
const todoTool = (id: string): ContentBlock => ({
  type: "tool_use", id, name: "todo_write", input: {}, caller: { type: "direct" },
});

/** Default hooks whose only reachable decision is a denial (no TTY approval). */
function denyingHooks(workspaceRoot: string): HookBus {
  return createDefaultHooks({
    checker: createDefaultPermissionPipeline({
      workspaceRoot,
      approval: new DenyAllApprovalPrompt(),
    }),
    workspaceRoot,
    log: () => {},
  });
}

/**
 * A `bash` replacement injected through `createDefaultTools({ overrides })`.
 * It mirrors the built-in name/description/schema so `registry.schemas()` keeps
 * matching the default tool list.
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

/**
 * Composes the OOP registry the same way `config.ts` does: workspace ->
 * ToolContext -> ToolRegistry, with the default tools. `log` feeds both the
 * registry diagnostics and (via the caller) the loop's presenter.
 */
async function buildRegistry(
  root: string,
  options: { readonly overrides?: readonly Tool<unknown>[]; readonly log?: (message: string) => void } = {},
): Promise<ToolRegistry> {
  const workspace = await createWorkspace(root);
  const log = options.log ?? (() => {});
  const context = new ToolContext({ workspace, locks: new FileLockRegistry(), logger: log });
  const registry = new ToolRegistry({ context, logger: log });
  for (const instance of createDefaultTools({ overrides: options.overrides })) {
    registry.register(instance);
  }
  return registry;
}

/** Presenter that appends every call to a caller-owned event log. */
class RecordingPresenter implements ToolPresenter {
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
 * Probe tool for the loop ordering tests: it reports through a caller-owned log
 * whether `run` was reached at all, and never touches the workspace.
 */
class OrderTool extends Tool<{}> {
  readonly name = "order";
  readonly description = "Records whether the loop dispatched the call.";
  readonly inputSchema: JsonSchemaObject = { type: "object", properties: {} };
  readonly #executed: string[];

  constructor(executed: string[]) {
    super();
    this.#executed = executed;
  }

  protected async run(): Promise<string> {
    this.#executed.push("ran");
    return "order-ran";
  }
}

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

for (const content of [[], [text("")], [text("done")]]) {
  test(`stops without an empty tool-result turn: ${JSON.stringify(content)}`, async () => {
    const { client, requests } = fakeClient([{ content, stop_reason: "tool_use" }]);
    const messages: Conversation = [{ role: "user", content: "hello" }];
    const registry = await buildRegistry(process.cwd());
    const loop = new AgentLoop({
      client,
      model: "test-model",
      system: systemPrompt(),
      registry,
      workspaceRoot: process.cwd(),
      presenter: new SilentToolPresenter(),
    });
    await loop.run(new Session(messages));
    assert.equal(requests.length, 1);
    assert.deepEqual(messages, [
      { role: "user", content: "hello" },
      { role: "assistant", content },
    ]);
  });
}

test("TR-3.1: serial tools, multiple iterations, next user turn preserve history and include non-bash tools", async () => {
  const responses: ModelResponse[] = [
    { content: [text("working"), tool("a", "first"), readTool("b", "a.txt")], stop_reason: "end_turn" },
    { content: [tool("c", "third")], stop_reason: "tool_use" },
    { content: [text("done")], stop_reason: "end_turn" },
    { content: [text("remembered")], stop_reason: "end_turn" },
  ];
  const { client, requests } = fakeClient(responses);
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const events: string[] = [];
  const logs: string[] = [];
  const output = "\u{1f680}".repeat(250);
  const root = await mkdtemp(join(tmpdir(), "cw-agent-tools-"));
  try {
    await writeFile(join(root, "a.txt"), output);
    const log = (line: string) => logs.push(line);
    const registry = await buildRegistry(root, {
      log,
      overrides: [
        new BashStubTool(async ({ command }) => {
          events.push(`start:${command}`);
          await new Promise<void>((resolve) => setImmediate(resolve));
          events.push(`end:${command}`);
          return output;
        }),
      ],
    });
    const loop = new AgentLoop({
      client,
      model: "test-model",
      system: systemPrompt("/workspace"),
      registry,
      workspaceRoot: root,
      presenter: new ConsoleToolPresenter({ log }),
    });
    await loop.run(new Session(messages));
    assert.deepEqual(events, [
      "start:first", "end:first", "start:third", "end:third",
    ]);
    assert.deepEqual(messages[2], {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: output },
        { type: "tool_result", tool_use_id: "b", content: output },
      ],
    });
    assert.equal(logs[1], "\u{1f680}".repeat(200));
    assert.equal(messages.length, 6);
    assert.deepEqual(requests[1]?.messages, messages.slice(0, 3));
    assert.deepEqual(requests[2]?.messages, messages.slice(0, 5));
    assert.equal(requests[0]?.max_tokens, 8000);
    assert.equal(requests[0]?.model, "test-model");
    assert.equal(requests[0]?.system, "你是一个位于 /workspace 的编程智能体。开始任何多步骤任务前，先用 todo_write 规划步骤，并在执行过程中持续更新状态。需要聚焦探索或边界清晰的子任务时，用 task 委派给子智能体。请使用工具解决问题，直接动手，不要只做解释。\n\n可用技能：\n(no skills found)\n\n当某个技能适用于当前任务时，用 load_skill 读取它的完整说明。");
    assert.deepEqual(requests[0]?.tools, registry.schemas());
    assert.equal(requests[0]?.tools?.length ?? 0, 7);

    messages.push({ role: "user", content: "what did you do?" });
    await loop.run(new Session(messages));
    assert.deepEqual(requests[3]?.messages, messages.slice(0, 7));
    assert.equal(messages.length, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-3.1: unknown tool names return Unknown string without throw", async () => {
  const { client } = fakeClient([
    { content: [unknownTool("x")], stop_reason: "tool_use" },
    { content: [text("ignored unknown")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const root = await mkdtemp(join(tmpdir(), "cw-agent-unknown-"));
  try {
    const registry = await buildRegistry(root);
    const loop = new AgentLoop({
      client,
      model: "test",
      system: systemPrompt(),
      registry,
      workspaceRoot: root,
      presenter: new SilentToolPresenter(),
    });
    await loop.run(new Session(messages));
    assert.deepEqual(messages[2], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "x", content: "Unknown: not_a_tool" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool errors are ordinary results fed back to the model", async () => {
  const { client } = fakeClient([
    // `> /dev/null` only matches the tool-level bash deny list, so this stays
    // an ordinary tool error: without a permission pipeline the guard inside
    // the bash tool still applies.
    { content: [tool("a", "> /dev/null")], stop_reason: "tool_use" },
    { content: [text("blocked")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [];
  const root = await mkdtemp(join(tmpdir(), "cw-agent-err-"));
  try {
    const registry = await buildRegistry(root);
    const loop = new AgentLoop({
      client,
      model: "test",
      system: systemPrompt(),
      registry,
      workspaceRoot: root,
      presenter: new SilentToolPresenter(),
    });
    await loop.run(new Session(messages));
    assert.deepEqual(messages[1], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "a", content: "Error: Dangerous command blocked" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default hooks block a deny-listed command before the tool is executed", async () => {
  const { client } = fakeClient([
    { content: [tool("a", "sudo true")], stop_reason: "tool_use" },
    { content: [text("blocked")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [];
  const root = await mkdtemp(join(tmpdir(), "cw-agent-perm-"));
  try {
    const registry = await buildRegistry(root, {
      overrides: [
        new BashStubTool(async () => assert.fail("A denied bash call must never reach the tool handler")),
      ],
    });
    const loop = new AgentLoop({
      client,
      model: "test",
      system: systemPrompt(),
      registry,
      workspaceRoot: root,
      hooks: denyingHooks(root),
      presenter: new SilentToolPresenter(),
    });
    await loop.run(new Session(messages));
    assert.deepEqual(messages[1], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "a", content: "Permission denied." }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allowed and denied calls in one turn keep tool_use order and ids", async () => {
  const { client } = fakeClient([
    { content: [globTool("g1", "*.txt"), tool("b1", "rm -rf /")], stop_reason: "tool_use" },
    { content: [text("done")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [];
  const root = await mkdtemp(join(tmpdir(), "cw-agent-mixed-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const registry = await buildRegistry(root);
    const loop = new AgentLoop({
      client,
      model: "test",
      system: systemPrompt(),
      registry,
      workspaceRoot: root,
      hooks: denyingHooks(root),
      presenter: new SilentToolPresenter(),
    });
    await loop.run(new Session(messages));
    assert.deepEqual(messages[1], {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "g1", content: "a.txt" },
        { type: "tool_result", tool_use_id: "b1", content: "Permission denied." },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Stop handler can inject a follow-up user message and keep the loop running", async () => {
  const { client, requests } = fakeClient([
    { content: [text("first answer")], stop_reason: "end_turn" },
    { content: [text("second answer")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const hooks = new HookBus();
  let stops = 0;
  hooks.register("Stop", () => {
    stops += 1;
    return stops === 1 ? "请先补测试" : undefined;
  });
  const registry = await buildRegistry(process.cwd());
  const loop = new AgentLoop({
    client,
    model: "test",
    system: systemPrompt(),
    registry,
    workspaceRoot: process.cwd(),
    hooks,
    presenter: new SilentToolPresenter(),
  });
  await loop.run(new Session(messages));
  assert.equal(stops, 2, "Stop fires once per exit attempt");
  assert.equal(requests.length, 2, "the model is asked again after the injected message");
  assert.deepEqual(messages[2], { role: "user", content: "请先补测试" });
  assert.equal(messages.length, 4);
});

test("API errors propagate without adding invented assistant messages", async () => {
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const client: ModelClient = { messages: { async create() { throw new Error("offline"); } } };
  const registry = await buildRegistry(process.cwd());
  const loop = new AgentLoop({
    client,
    model: "test",
    system: systemPrompt(),
    registry,
    workspaceRoot: process.cwd(),
    presenter: new SilentToolPresenter(),
  });
  await assert.rejects(loop.run(new Session(messages)), /offline/);
  assert.equal(messages.length, 1);
});

test("untrusted tool input is checked before shell execution", async () => {
  const { client } = fakeClient([{
    content: [{
      type: "tool_use", id: "bad", name: "bash", input: { command: 42 }, caller: { type: "direct" },
    }],
    stop_reason: "tool_use",
  }, {
    content: [text("recovered")],
    stop_reason: "end_turn",
  }]);
  const root = await mkdtemp(join(tmpdir(), "cw-agent-invalid-"));
  try {
    const registry = await buildRegistry(root, {
      overrides: [
        new BashStubTool(async () => assert.fail("Invalid input must not reach the shell")),
      ],
    });
    const messages: Conversation = [];
    const loop = new AgentLoop({
      client,
      model: "test",
      system: systemPrompt(),
      registry,
      workspaceRoot: root,
      presenter: new SilentToolPresenter(),
    });
    await loop.run(new Session(messages));
    assert.deepEqual(messages[1], {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "bad",
        content: "Error: Invalid input for bash: bash.command must be string",
      }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an allowed call orders preToolUse, showToolCall, postToolUse and showResult", async () => {
  const { client } = fakeClient([
    { content: [orderTool("o1")], stop_reason: "tool_use" },
    { content: [text("done")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [];
  const events: string[] = [];
  const executed: string[] = [];
  const hooks = new HookBus();
  hooks.register("PreToolUse", () => { events.push("preToolUse"); });
  hooks.register("PostToolUse", () => { events.push("postToolUse"); });
  const root = await mkdtemp(join(tmpdir(), "cw-agent-order-"));
  try {
    const registry = await buildRegistry(root, { overrides: [new OrderTool(executed)] });
    const loop = new AgentLoop({
      client,
      model: "test-model",
      system: systemPrompt(),
      registry,
      workspaceRoot: root,
      hooks,
      presenter: new RecordingPresenter(events),
    });
    await loop.run(new Session(messages));
    assert.deepEqual(events, [
      "preToolUse",
      "showToolCall:order",
      "postToolUse",
      "showResult:order:order-ran",
    ]);
    assert.deepEqual(executed, ["ran"]);
    assert.deepEqual(messages[1], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "o1", content: "order-ran" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a PreToolUse block skips showToolCall and postToolUse and presents the block value once", async () => {
  const { client } = fakeClient([
    { content: [orderTool("o2")], stop_reason: "tool_use" },
    { content: [text("done")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [];
  const events: string[] = [];
  const executed: string[] = [];
  const hooks = new HookBus();
  hooks.register("PreToolUse", () => {
    events.push("preToolUse");
    return "blocked-by-test";
  });
  hooks.register("PostToolUse", () => { events.push("postToolUse"); });
  const root = await mkdtemp(join(tmpdir(), "cw-agent-block-order-"));
  try {
    const registry = await buildRegistry(root, { overrides: [new OrderTool(executed)] });
    const loop = new AgentLoop({
      client,
      model: "test-model",
      system: systemPrompt(),
      registry,
      workspaceRoot: root,
      hooks,
      presenter: new RecordingPresenter(events),
    });
    await loop.run(new Session(messages));
    assert.deepEqual(events, ["preToolUse", "showResult:order:blocked-by-test"]);
    assert.deepEqual(executed, [], "a blocked call must never reach the tool");
    assert.deepEqual(messages[1], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "o2", content: "blocked-by-test" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Stand-in for the todo tool: the real one belongs to a parallel change, so the
 * reminder tests only need the registered name and a stable result string.
 */
class TodoWriteStubTool extends Tool<{}> {
  readonly name = "todo_write";
  readonly description = "Records that the todo tool was used.";
  readonly inputSchema: JsonSchemaObject = { type: "object", properties: {} };

  protected async run(): Promise<string> {
    return "No todos.";
  }
}

/** Reminder port used to observe when the loop asks for a reminder. */
class CountingReminder implements ToolRoundReminder {
  readonly rounds: string[][] = [];
  begins = 0;

  beginRun(): void {
    this.begins += 1;
  }

  afterToolRound(toolNames: readonly string[]): string | undefined {
    this.rounds.push([...toolNames]);
    return undefined;
  }
}

/** Message content asserted to be a block array, so individual blocks are reachable. */
function blocksOf(message: Conversation[number] | undefined): ContentBlockParam[] {
  assert.ok(message, "expected an appended message");
  assert.ok(Array.isArray(message.content), "expected block content");
  return message.content;
}

/** Loop wired with the todo stub plus the injectable reminder port. */
async function buildReminderLoop(
  root: string,
  responses: ModelResponse[],
  reminder?: ToolRoundReminder,
  hooks?: HookBus,
): Promise<AgentLoop> {
  const { client } = fakeClient(responses);
  const registry = await buildRegistry(root, { overrides: [new TodoWriteStubTool()] });
  return new AgentLoop({
    client,
    model: "test",
    system: systemPrompt(),
    registry,
    workspaceRoot: root,
    presenter: new SilentToolPresenter(),
    ...(hooks === undefined ? {} : { hooks }),
    ...(reminder === undefined ? {} : { reminder }),
  });
}

/** The user messages that carry a tool round, excluding plain-text injections. */
function toolRounds(messages: Conversation): ContentBlockParam[][] {
  return messages.flatMap((message) =>
    message.role === "user" && Array.isArray(message.content) ? [message.content] : [],
  );
}

test("TR-4.1: three consecutive rounds without the todo tool inject one reminder", async () => {
  const responses: ModelResponse[] = [
    { content: [readTool("r1", "a.txt")], stop_reason: "tool_use" },
    { content: [readTool("r2", "a.txt")], stop_reason: "tool_use" },
    { content: [readTool("r3", "a.txt")], stop_reason: "tool_use" },
    { content: [text("done")], stop_reason: "end_turn" },
  ];
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const root = await mkdtemp(join(tmpdir(), "cw-agent-reminder-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const loop = await buildReminderLoop(root, responses, new TodoReminder());
    await loop.run(new Session(messages));
    assert.equal(messages.length, 8);
    assert.deepEqual(blocksOf(messages[2]), [
      { type: "tool_result", tool_use_id: "r1", content: "alpha" },
    ]);
    assert.deepEqual(blocksOf(messages[4]), [
      { type: "tool_result", tool_use_id: "r2", content: "alpha" },
    ]);
    // The reminder is appended to the same user message, after its tool_result.
    assert.deepEqual(blocksOf(messages[6]), [
      { type: "tool_result", tool_use_id: "r3", content: "alpha" },
      { type: "text", text: TODO_REMINDER_TEXT },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-4.1: a todo_write round resets the counter, so the reminder moves later", async () => {
  const responses: ModelResponse[] = [
    { content: [readTool("r1", "a.txt")], stop_reason: "tool_use" },
    { content: [todoTool("t1")], stop_reason: "tool_use" },
    { content: [readTool("r2", "a.txt")], stop_reason: "tool_use" },
    { content: [readTool("r3", "a.txt")], stop_reason: "tool_use" },
    { content: [readTool("r4", "a.txt")], stop_reason: "tool_use" },
    { content: [text("done")], stop_reason: "end_turn" },
  ];
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const root = await mkdtemp(join(tmpdir(), "cw-agent-reminder-reset-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const loop = await buildReminderLoop(root, responses, new TodoReminder());
    await loop.run(new Session(messages));
    assert.equal(messages.length, 12);
    const reminderRounds = toolRounds(messages).filter((blocks) =>
      blocks.some((block) => block.type === "text"),
    );
    assert.equal(reminderRounds.length, 1, "only the round after three ignored rounds reminds");
    assert.deepEqual(blocksOf(messages[4]), [
      { type: "tool_result", tool_use_id: "t1", content: "No todos." },
    ]);
    assert.deepEqual(blocksOf(messages[10]), [
      { type: "tool_result", tool_use_id: "r4", content: "alpha" },
      { type: "text", text: TODO_REMINDER_TEXT },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-4.2: a blocked todo_write round does not count as a todo update", async () => {
  const responses: ModelResponse[] = [
    { content: [todoTool("t1")], stop_reason: "tool_use" },
    { content: [readTool("r1", "a.txt")], stop_reason: "tool_use" },
    { content: [readTool("r2", "a.txt")], stop_reason: "tool_use" },
    { content: [text("done")], stop_reason: "end_turn" },
  ];
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const hooks = new HookBus();
  hooks.register("PreToolUse", (context) =>
    context.toolName === "todo_write" ? "Permission denied." : undefined,
  );
  const root = await mkdtemp(join(tmpdir(), "cw-agent-reminder-blocked-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const loop = await buildReminderLoop(root, responses, new TodoReminder(), hooks);
    await loop.run(new Session(messages));
    assert.deepEqual(blocksOf(messages[2]), [
      { type: "tool_result", tool_use_id: "t1", content: "Permission denied." },
    ]);
    assert.deepEqual(blocksOf(messages[4]), [
      { type: "tool_result", tool_use_id: "r1", content: "alpha" },
    ]);
    // Three rounds counted, because the blocked todo call never executed.
    assert.deepEqual(blocksOf(messages[6]), [
      { type: "tool_result", tool_use_id: "r2", content: "alpha" },
      { type: "text", text: TODO_REMINDER_TEXT },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-4.2: beginRun clears the counter between questions on the same loop", async () => {
  const responses: ModelResponse[] = [
    { content: [readTool("r1", "a.txt")], stop_reason: "tool_use" },
    { content: [readTool("r2", "a.txt")], stop_reason: "tool_use" },
    { content: [text("first answer")], stop_reason: "end_turn" },
    { content: [readTool("r3", "a.txt")], stop_reason: "tool_use" },
    { content: [text("second answer")], stop_reason: "end_turn" },
  ];
  const root = await mkdtemp(join(tmpdir(), "cw-agent-reminder-runs-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const loop = await buildReminderLoop(root, responses, new TodoReminder());
    const first: Conversation = [{ role: "user", content: "hello" }];
    await loop.run(new Session(first));
    assert.equal(
      toolRounds(first).filter((blocks) => blocks.some((block) => block.type === "text")).length,
      0,
      "two ignored rounds stay below the threshold",
    );

    const second: Conversation = [{ role: "user", content: "again" }];
    await loop.run(new Session(second));
    // Without the run reset this round would be the third consecutive one.
    assert.deepEqual(toolRounds(second), [
      [{ type: "tool_result", tool_use_id: "r3", content: "alpha" }],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-4.3: a round without tool calls never reaches afterToolRound", async () => {
  const responses: ModelResponse[] = [
    { content: [readTool("r1", "a.txt")], stop_reason: "tool_use" },
    { content: [text("thinking")], stop_reason: "end_turn" },
    { content: [readTool("r2", "a.txt")], stop_reason: "tool_use" },
    { content: [text("done")], stop_reason: "end_turn" },
  ];
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const hooks = new HookBus();
  let stops = 0;
  hooks.register("Stop", () => {
    stops += 1;
    return stops === 1 ? "keep going" : undefined;
  });
  const reminder = new CountingReminder();
  const root = await mkdtemp(join(tmpdir(), "cw-agent-reminder-notools-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const loop = await buildReminderLoop(root, responses, reminder, hooks);
    await loop.run(new Session(messages));
    assert.equal(reminder.begins, 1);
    assert.deepEqual(reminder.rounds, [["read_file"], ["read_file"]]);
    assert.equal(stops, 2, "the text-only round still exits through Stop");
    assert.deepEqual(toolRounds(messages), [
      [{ type: "tool_result", tool_use_id: "r1", content: "alpha" }],
      [{ type: "tool_result", tool_use_id: "r2", content: "alpha" }],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-4.3: without the reminder port every round stays tool_result-only", async () => {
  const responses: ModelResponse[] = [
    { content: [readTool("r1", "a.txt")], stop_reason: "tool_use" },
    { content: [readTool("r2", "a.txt")], stop_reason: "tool_use" },
    { content: [readTool("r3", "a.txt")], stop_reason: "tool_use" },
    { content: [readTool("r4", "a.txt")], stop_reason: "tool_use" },
    { content: [text("done")], stop_reason: "end_turn" },
  ];
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const root = await mkdtemp(join(tmpdir(), "cw-agent-reminder-off-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const loop = await buildReminderLoop(root, responses);
    await loop.run(new Session(messages));
    assert.deepEqual(toolRounds(messages), ["r1", "r2", "r3", "r4"].map((id) => [
      { type: "tool_result", tool_use_id: id, content: "alpha" },
    ]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TodoReminder: the third ignored round fires once and resets the counter", () => {
  const reminder = new TodoReminder();
  assert.equal(TODO_REMINDER_THRESHOLD, 3);
  assert.equal(TODO_REMINDER_TOOL, "todo_write");
  assert.equal(reminder.afterToolRound(["read_file"]), undefined);
  assert.equal(reminder.afterToolRound(["glob"]), undefined);
  assert.equal(reminder.afterToolRound(["bash"]), TODO_REMINDER_TEXT);
  assert.equal(reminder.afterToolRound(["bash"]), undefined, "firing resets the counter");
  assert.equal(reminder.afterToolRound(["bash"]), undefined);
  assert.equal(reminder.afterToolRound(["bash"]), TODO_REMINDER_TEXT);
});

test("TodoReminder: the todo tool and beginRun both reset the counter", () => {
  const reminder = new TodoReminder();
  assert.equal(reminder.afterToolRound(["bash"]), undefined);
  assert.equal(reminder.afterToolRound(["todo_write", "read_file"]), undefined);
  assert.equal(reminder.afterToolRound(["bash"]), undefined);
  assert.equal(reminder.afterToolRound(["bash"]), undefined);
  assert.equal(reminder.afterToolRound(["bash"]), TODO_REMINDER_TEXT);

  const fresh = new TodoReminder();
  assert.equal(fresh.afterToolRound(["bash"]), undefined);
  assert.equal(fresh.afterToolRound(["bash"]), undefined);
  fresh.beginRun();
  assert.equal(fresh.afterToolRound(["bash"]), undefined, "beginRun dropped the pending rounds");
  assert.equal(fresh.afterToolRound(["bash"]), undefined);
  assert.equal(fresh.afterToolRound(["bash"]), TODO_REMINDER_TEXT);
});

test("TodoReminder: threshold, toolName and text are injectable", () => {
  const fast = new TodoReminder({ threshold: 2 });
  assert.equal(fast.afterToolRound(["bash"]), undefined);
  assert.equal(fast.afterToolRound(["bash"]), TODO_REMINDER_TEXT);

  const custom = new TodoReminder({ toolName: "plan_write", text: "<reminder>custom</reminder>" });
  assert.equal(custom.afterToolRound(["todo_write"]), undefined);
  assert.equal(custom.afterToolRound(["todo_write"]), undefined);
  assert.equal(custom.afterToolRound(["plan_write"]), undefined, "the configured name resets");
  assert.equal(custom.afterToolRound(["bash"]), undefined);
  assert.equal(custom.afterToolRound(["bash"]), undefined);
  assert.equal(custom.afterToolRound(["bash"]), "<reminder>custom</reminder>");
});

test("without maxTurns run() returns finished and keeps the existing history", async () => {
  const responses: ModelResponse[] = [
    { content: [readTool("r1", "a.txt")], stop_reason: "tool_use" },
    { content: [text("done")], stop_reason: "end_turn" },
  ];
  const { client, requests } = fakeClient(responses);
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const root = await mkdtemp(join(tmpdir(), "cw-agent-outcome-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const registry = await buildRegistry(root);
    const loop = new AgentLoop({
      client,
      model: "test",
      system: systemPrompt(),
      registry,
      workspaceRoot: root,
      presenter: new SilentToolPresenter(),
    });
    const outcome = await loop.run(new Session(messages));
    assert.equal(outcome, "finished");
    assert.equal(requests.length, 2);
    assert.deepEqual(messages, [
      { role: "user", content: "hello" },
      { role: "assistant", content: [readTool("r1", "a.txt")] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "r1", content: "alpha" }],
      },
      { role: "assistant", content: [text("done")] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maxTurns: 1 returns turn-limit after one request and never triggers Stop", async () => {
  const { client, requests } = fakeClient([
    { content: [readTool("r1", "a.txt")], stop_reason: "tool_use" },
    { content: [text("never reached")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const hooks = new HookBus();
  let stops = 0;
  hooks.register("Stop", () => {
    stops += 1;
  });
  const root = await mkdtemp(join(tmpdir(), "cw-agent-max-turns-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const registry = await buildRegistry(root);
    const loop = new AgentLoop({
      client,
      model: "test",
      system: systemPrompt(),
      registry,
      workspaceRoot: root,
      hooks,
      presenter: new SilentToolPresenter(),
      maxTurns: 1,
    });
    const outcome = await loop.run(new Session(messages));
    assert.equal(outcome, "turn-limit");
    assert.equal(requests.length, 1, "the cap is checked before asking the model again");
    assert.equal(stops, 0, "a turn-limited run never reaches the Stop hook");
    assert.deepEqual(messages[2], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "r1", content: "alpha" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maxTurns: 2 allows a tool round and the closing text turn", async () => {
  const { client, requests } = fakeClient([
    { content: [readTool("r1", "a.txt")], stop_reason: "tool_use" },
    { content: [text("done")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const root = await mkdtemp(join(tmpdir(), "cw-agent-max-turns-2-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const registry = await buildRegistry(root);
    const loop = new AgentLoop({
      client,
      model: "test",
      system: systemPrompt(),
      registry,
      workspaceRoot: root,
      presenter: new SilentToolPresenter(),
      maxTurns: 2,
    });
    const outcome = await loop.run(new Session(messages));
    assert.equal(outcome, "finished");
    assert.equal(requests.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the presenter receives the tool name for allowed and blocked results", async () => {
  const { client } = fakeClient([
    {
      content: [tool("b", "echo hi"), readTool("r", "a.txt"), globTool("g", "*.txt")],
      stop_reason: "tool_use",
    },
    { content: [text("done")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [];
  const events: string[] = [];
  const hooks = new HookBus();
  hooks.register("PreToolUse", (context) =>
    context.toolName === "bash" ? "Permission denied." : undefined,
  );
  const root = await mkdtemp(join(tmpdir(), "cw-agent-tool-name-"));
  try {
    await writeFile(join(root, "a.txt"), "alpha");
    const registry = await buildRegistry(root, {
      overrides: [
        new BashStubTool(async () => assert.fail("a blocked bash call must never reach the tool")),
      ],
    });
    const loop = new AgentLoop({
      client,
      model: "test",
      system: systemPrompt(),
      registry,
      workspaceRoot: root,
      hooks,
      presenter: new RecordingPresenter(events),
    });
    await loop.run(new Session(messages));
    assert.deepEqual(events, [
      "showResult:bash:Permission denied.",
      "showToolCall:read_file",
      "showResult:read_file:alpha",
      "showToolCall:glob",
      "showResult:glob:a.txt",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
