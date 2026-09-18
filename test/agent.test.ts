import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { agentLoop, systemPrompt, TOOLS } from "../src/agent.js";
import type { Conversation, ModelClient, ModelRequest, ModelResponse } from "../src/types.js";

const text = (value: string): ContentBlock => ({
  type: "text", text: value, citations: null,
});
const tool = (id: string, command: string): ContentBlock => ({
  type: "tool_use", id, name: "bash", input: { command }, caller: { type: "direct" },
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
    await agentLoop(messages, {
      client, model: "test-model",
      runCommand: async () => assert.fail("Must not execute a command"),
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(messages, [
      { role: "user", content: "hello" },
      { role: "assistant", content },
    ]);
  });
}

test("serial tools, multiple iterations and next user turn preserve the full history", async () => {
  const responses: ModelResponse[] = [
    { content: [text("working"), tool("a", "first"), tool("b", "second")], stop_reason: "end_turn" },
    { content: [tool("c", "third")], stop_reason: "tool_use" },
    { content: [text("done")], stop_reason: "end_turn" },
    { content: [text("remembered")], stop_reason: "end_turn" },
  ];
  const { client, requests } = fakeClient(responses);
  const messages: Conversation = [{ role: "user", content: "hello" }];
  const events: string[] = [];
  const logs: string[] = [];
  const output = "\u{1f680}".repeat(250);
  const options = {
    client, model: "test-model", system: systemPrompt("/workspace"), log: (s: string) => logs.push(s),
    runCommand: async (command: string) => {
      events.push(`start:${command}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push(`end:${command}`);
      return output;
    },
  };
  await agentLoop(messages, options);
  assert.deepEqual(events, [
    "start:first", "end:first", "start:second", "end:second", "start:third", "end:third",
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
  assert.equal(requests[0]?.system, "You are a coding agent at /workspace. Use bash to solve tasks. Act, don't explain.");
  assert.deepEqual(requests[0]?.tools, TOOLS);

  messages.push({ role: "user", content: "what did you do?" });
  await agentLoop(messages, options);
  assert.deepEqual(requests[3]?.messages, messages.slice(0, 7));
  assert.equal(messages.length, 8);
});

test("tool errors are ordinary results fed back to the model", async () => {
  const { client } = fakeClient([
    { content: [tool("a", "sudo true")], stop_reason: "tool_use" },
    { content: [text("blocked")], stop_reason: "end_turn" },
  ]);
  const messages: Conversation = [];
  await agentLoop(messages, { client, model: "test", log: () => {} });
  assert.deepEqual(messages[1], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "a", content: "Error: Dangerous command blocked" }],
  });
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
  }]);
  await assert.rejects(agentLoop([], {
    client, model: "test",
    runCommand: async () => assert.fail("Invalid input must not reach the shell"),
  }), /string command/);
});
