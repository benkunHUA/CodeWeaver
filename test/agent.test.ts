import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { agentLoop, systemPrompt, TOOLS } from "../src/agent.js";
import { createDefaultRegistry } from "../src/tools/index.js";
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
const unknownTool = (id: string): ContentBlock => ({
  type: "tool_use", id, name: "not_a_tool", input: {}, caller: { type: "direct" },
});

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
    await agentLoop(messages, { client, model: "test-model" });
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
    const registry = await createDefaultRegistry({
      root,
      overrides: [
        {
          name: "bash",
          handler: async (raw) => {
            const input = raw as { readonly command?: string };
            if (typeof input.command !== "string") throw new Error("missing command");
            const command = input.command;
            events.push(`start:${command}`);
            await new Promise<void>((resolve) => setImmediate(resolve));
            events.push(`end:${command}`);
            return output;
          },
        },
      ],
    });
    const options = {
      client,
      model: "test-model",
      system: systemPrompt("/workspace"),
      registry,
      log: (s: string) => logs.push(s),
    };
    await agentLoop(messages, options);
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
    assert.deepEqual(requests[0]?.tools, TOOLS);
    assert.equal(requests[0]?.tools?.length ?? 0, 5);

    messages.push({ role: "user", content: "what did you do?" });
    await agentLoop(messages, options);
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
    const registry = await createDefaultRegistry({ root });
    await agentLoop(messages, { client, model: "test", log: () => {}, registry });
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
    { content: [tool("a", "sudo true")], stop_reason: "tool_use" },
    { content: [text("blocked")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [];
  const root = await mkdtemp(join(tmpdir(), "cw-agent-err-"));
  try {
    const registry = await createDefaultRegistry({ root });
    await agentLoop(messages, { client, model: "test", log: () => {}, registry });
    assert.deepEqual(messages[1], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "a", content: "Error: Dangerous command blocked" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("API errors propagate without adding invented assistant messages", async () => {
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const client: ModelClient = { messages: { async create() { throw new Error("offline"); } } };
  await assert.rejects(agentLoop(messages, { client, model: "test" }), /offline/);
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
    const registry = await createDefaultRegistry({
      root,
      overrides: [{
        name: "bash",
        handler: async () => assert.fail("Invalid input must not reach the shell"),
      }],
    });
    const messages: Conversation = [];
    await agentLoop(messages, { client, model: "test", registry, log: () => {} });
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
