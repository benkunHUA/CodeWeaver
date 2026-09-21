import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { AgentLoop } from "../src/agent/AgentLoop.js";
import { Session } from "../src/agent/Session.js";
import { ConsoleToolPresenter, SilentToolPresenter, type ToolPresenter } from "../src/agent/ToolPresenter.js";
import { systemPrompt } from "../src/agent/systemPrompt.js";
import { HookBus, createDefaultHooks } from "../src/hooks/index.js";
import { DenyAllApprovalPrompt, createDefaultPermissionPipeline } from "../src/permission/index.js";
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
 * matching the default five-tool list.
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

  showResult(result: string): void {
    this.#events.push(`showResult:${result}`);
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
    assert.equal(requests[0]?.system, "你是一个位于 /workspace 的编程智能体。请使用工具解决问题，直接动手，不要只做解释。");
    assert.deepEqual(requests[0]?.tools, registry.schemas());
    assert.equal(requests[0]?.tools?.length ?? 0, 5);

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
      "showResult:order-ran",
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
    assert.deepEqual(events, ["preToolUse", "showResult:blocked-by-test"]);
    assert.deepEqual(executed, [], "a blocked call must never reach the tool");
    assert.deepEqual(messages[1], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "o2", content: "blocked-by-test" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
