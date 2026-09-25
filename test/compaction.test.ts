import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ContentBlock, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { AgentLoop } from "../src/agent/AgentLoop.js";
import { Session } from "../src/agent/Session.js";
import { SilentToolPresenter } from "../src/agent/ToolPresenter.js";
import { ContextCompactor } from "../src/compaction/ContextCompactor.js";
import { ToolResultStore } from "../src/compaction/ToolResultStore.js";
import { TranscriptArchive } from "../src/compaction/TranscriptArchive.js";
import { charCount } from "../src/compaction/text.js";
import {
  COMPACT_REQUEST_RESULT,
  COMPACT_TOOL_NAME,
  LARGE_RESULT_CHAR_LIMIT,
  SUMMARY_SYSTEM,
} from "../src/compaction/types.js";
import type { CompactionPort } from "../src/compaction/types.js";
import { SilentSubagentPresenter, SubagentRunner } from "../src/subagent/index.js";
import { FileLockRegistry } from "../src/tools/core/FileLockRegistry.js";
import { ToolContext } from "../src/tools/core/ToolContext.js";
import { CompactTool } from "../src/tools/CompactTool.js";
import { createDefaultTools } from "../src/tools/createDefaultTools.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { createWorkspace } from "../src/workspace.js";
import type { Conversation, ModelClient, ModelRequest, ModelResponse } from "../src/types.js";

const text = (value: string): ContentBlock => ({
  type: "text", text: value, citations: null,
});

const userText = (content: string): MessageParam => ({ role: "user", content });
const assistantText = (value: string): MessageParam => ({ role: "assistant", content: [text(value)] });
const assistantToolUse = (id: string): MessageParam => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "bash", input: {}, caller: { type: "direct" } }],
});
const toolResult = (id: string, content: string): MessageParam => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }],
});

/** Every string-content tool_result in document order. */
function toolResultTexts(messages: Conversation): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result" && typeof block.content === "string") out.push(block.content);
    }
  }
  return out;
}

function contentOf(messages: Conversation, index: number): string {
  const content = messages[index]?.content;
  assert.equal(typeof content, "string", `message ${index} must have string content`);
  return content as string;
}

async function withTempDir(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cw-compaction-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface Harness {
  readonly compactor: ContextCompactor;
  readonly archiveDir: string;
  readonly resultsDir: string;
  /** Every summarizer request, so tests can prove when one was issued. */
  readonly requests: ModelRequest[];
  readonly logs: string[];
}

async function buildHarness(root: string, summary = "the summary"): Promise<Harness> {
  const archiveDir = join(root, ".transcripts");
  const resultsDir = join(root, ".task_outputs", "tool-results");
  const requests: ModelRequest[] = [];
  const logs: string[] = [];
  const client: ModelClient = {
    messages: {
      async create(request) {
        requests.push(structuredClone(request));
        return { content: [text(summary)], stop_reason: "end_turn" };
      },
    },
  };
  const compactor = new ContextCompactor({
    client,
    model: "summary-model",
    archive: new TranscriptArchive({ dir: archiveDir }),
    results: new ToolResultStore({ dir: resultsDir }),
    log: (line) => logs.push(line),
  });
  return { compactor, archiveDir, resultsDir, requests, logs };
}

/** A prompt-too-long error shaped like the SDK's 400 body. */
function promptTooLong(): Error {
  return new Error('400 {"type":"error","error":{"type":"invalid_request_error"},"message":"prompt_too_long"}');
}

// -- text / size estimate -------------------------------------------------------

test("charCount counts code points, not UTF-16 code units", () => {
  assert.equal(charCount("abc"), 3);
  assert.equal(charCount("🚀"), 1);
  assert.equal(charCount("a🚀b"), 3);
});

test("estimateChars measures the serialized conversation in code points", () => {
  const messages: Conversation = [userText("🚀🚀")];
  assert.equal(ContextCompactor.estimateChars(messages), charCount(JSON.stringify(messages)));
  // JSON.stringify keeps non-ASCII raw, like Python's ensure_ascii=False.
  assert.equal(ContextCompactor.estimateChars(messages), Array.from(JSON.stringify(messages)).length);
});

// -- ToolResultStore ------------------------------------------------------------

test("ToolResultStore saves under a sanitized id and verifies placeholders", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, ".task_outputs", "tool-results");
    const store = new ToolResultStore({ dir });
    const saved = await store.save("toolu/../weird id", "FULL TEXT");
    assert.equal(saved, join(dir, "toolu_.._weird_id.txt"));
    assert.equal(await readFile(saved, "utf8"), "FULL TEXT");

    const long = "z".repeat(40_000);
    const preview = await store.persistLargeOutput("t1", long);
    assert.ok(preview.startsWith("<persisted-output>\nFull output: "));
    assert.ok(preview.endsWith("\n</persisted-output>"));
    assert.ok(preview.includes(`Preview:\n${"z".repeat(2000)}`));
    assert.equal(await store.resolvePlaceholder(preview), join(dir, "t1.txt"));
    assert.equal(await readFile(join(dir, "t1.txt"), "utf8"), long);

    // An output at (or below) the large-result limit is never persisted.
    const atLimit = "y".repeat(LARGE_RESULT_CHAR_LIMIT);
    assert.equal(await store.persistLargeOutput("t2", atLimit), atLimit);
    assert.deepEqual((await readdir(dir)).sort(), ["t1.txt", "toolu_.._weird_id.txt"]);

    // The "[Earlier tool result saved at ...]" shape resolves too.
    const earlier = `[Earlier tool result saved at ${join(dir, "t1.txt")}]`;
    assert.equal(await store.resolvePlaceholder(earlier), join(dir, "t1.txt"));
    // Empty / foreign / escaping / missing placeholders never resolve.
    assert.equal(await store.resolvePlaceholder("[Earlier tool result saved at ]"), undefined);
    assert.equal(await store.resolvePlaceholder("ordinary output"), undefined);
    assert.equal(await store.resolvePlaceholder("[Earlier tool result saved at /etc/hosts]"), undefined);
    assert.equal(await store.resolvePlaceholder(`[Earlier tool result saved at ${join(dir, "gone.txt")}]`), undefined);
    assert.equal(await store.resolvePlaceholder("<persisted-output>\nno full output line\n</persisted-output>"), undefined);
  });
});

// -- TranscriptArchive ----------------------------------------------------------

test("TranscriptArchive writes one JSON line per message and validates markers", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, ".transcripts");
    const archive = new TranscriptArchive({ dir });
    const messages: Conversation = [userText("hello"), assistantText("hi")];
    const path = await archive.write(messages);
    assert.equal(path.startsWith(join(dir, "transcript_")), true);
    assert.equal(path.endsWith(".jsonl"), true);
    assert.equal(
      await readFile(path, "utf8"),
      `${JSON.stringify(messages[0])}\n${JSON.stringify(messages[1])}\n`,
    );

    assert.equal(await archive.isMarker(userText(`[2 messages archived at ${path}]`)), true);
    assert.equal(await archive.isMarker(userText(`[1 messages archived at ${join(dir, "nope.jsonl")}]`)), false);
    assert.equal(await archive.isMarker(userText(`[1 messages archived at /etc/hosts]`)), false);
    assert.equal(await archive.isMarker({ role: "assistant", content: `[1 messages archived at ${path}]` }), false);
    assert.equal(await archive.isMarker(userText("no marker here")), false);
  });
});

// -- Step 1: tool_result_budget -------------------------------------------------

test("toolResultBudget persists only the oversized results of the latest batch", async () => {
  await withTempDir(async (root) => {
    const harness = await buildHarness(root);
    const messages: Conversation = [
      assistantToolUse("a1"),
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "big", content: "x".repeat(40_000) },
          { type: "tool_result", tool_use_id: "limit", content: "y".repeat(LARGE_RESULT_CHAR_LIMIT) },
          { type: "tool_result", tool_use_id: "small", content: "small output" },
        ],
      },
    ];

    // A huge budget leaves everything untouched.
    assert.equal(await harness.compactor.toolResultBudget(messages, 10_000_000), messages);
    assert.equal(toolResultTexts(messages)[0]?.length, 40_000);

    await harness.compactor.toolResultBudget(messages, 100);
    const [big, limit, small] = toolResultTexts(messages);
    assert.ok(big?.startsWith("<persisted-output>\n"));
    assert.ok(big?.includes("Full output: "));
    assert.ok(big?.includes(`Preview:\n${"x".repeat(2000)}`));
    // At the limit it is not "large", and the small result is never a candidate.
    assert.equal(limit?.length, LARGE_RESULT_CHAR_LIMIT);
    assert.equal(small, "small output");
    assert.equal(await readFile(join(harness.resultsDir, "big.txt"), "utf8"), "x".repeat(40_000));
  });
});

// -- Step 2: snip_compact -------------------------------------------------------

test("snipCompact keeps the head, the newest tail and one archive marker", async () => {
  await withTempDir(async (root) => {
    const harness = await buildHarness(root);
    const messages: Conversation = [];
    for (let index = 0; index < 60; index += 1) {
      messages.push(index % 2 === 0 ? userText(`q${index}`) : assistantText(`a${index}`));
    }

    // At or below the cap nothing happens.
    const underCap = messages.slice(0, 50);
    assert.equal(await harness.compactor.snipCompact(underCap), underCap);
    assert.deepEqual(await readdir(harness.archiveDir).catch(() => []), []);

    const snipped = await harness.compactor.snipCompact(messages);
    assert.equal(snipped.length, 50, "3 head + 1 marker + 46 tail");
    assert.deepEqual(snipped.slice(0, 3), messages.slice(0, 3));
    assert.deepEqual(snipped.slice(4), messages.slice(14));
    assert.match(contentOf(snipped, 3), /^\[11 messages archived at .+\.jsonl\]$/);

    const transcripts = await readdir(harness.archiveDir);
    assert.equal(transcripts.length, 1);
    const written = await readFile(join(harness.archiveDir, transcripts[0]!), "utf8");
    assert.equal(written.trimEnd().split("\n").length, 60);
  });
});

test("snipCompact protects the tool_use/tool_result boundary and is idempotent", async () => {
  await withTempDir(async (root) => {
    const harness = await buildHarness(root);
    const messages: Conversation = [
      userText("q0"),
      assistantText("a1"),
      assistantToolUse("t0"),
      toolResult("t0", "r0"),
    ];
    for (let index = 4; index < 55; index += 1) {
      messages.push(index % 2 === 0 ? userText(`q${index}`) : assistantText(`a${index}`));
    }

    const snipped = await harness.compactor.snipCompact(messages);
    // The head grew past three so the assistant(tool_use) keeps its result.
    assert.deepEqual(snipped.slice(0, 4), messages.slice(0, 4));
    assert.match(contentOf(snipped, 4), /^\[5 messages archived at .+\.jsonl\]$/);
    assert.deepEqual(snipped.slice(5), messages.slice(9));
    assert.equal(toolResultTexts(snipped).length, 1, "no orphan tool_result was archived away");

    // A second pass finds only its own marker in the middle and stops.
    const again = await harness.compactor.snipCompact(snipped);
    assert.equal(again, snipped);
    assert.equal((await readdir(harness.archiveDir)).length, 1, "no second transcript is written");
  });
});

test("snipCompact moves a trailing tool_use back with its tool_result", async () => {
  await withTempDir(async (root) => {
    const harness = await buildHarness(root);
    const messages: Conversation = [];
    for (let index = 0; index < 60; index += 1) {
      messages.push(index % 2 === 0 ? userText(`q${index}`) : assistantText(`a${index}`));
    }
    // Index 14 is where the tail would start; make it the result of index 13.
    messages[13] = assistantToolUse("t13");
    messages[14] = toolResult("t13", "r13");

    const snipped = await harness.compactor.snipCompact(messages);
    assert.match(contentOf(snipped, 3), /^\[10 messages archived at .+\.jsonl\]$/);
    assert.deepEqual(snipped.slice(4, 6), messages.slice(13, 15), "the pair stays in the tail");
  });
});

// -- Step 3: micro_compact ------------------------------------------------------

test("microCompact shortens older read results and keeps new or recent ones whole", async () => {
  await withTempDir(async (root) => {
    const harness = await buildHarness(root);
    const messages: Conversation = [userText("start"), assistantToolUse("s0"), toolResult("s0", "short")];
    for (const id of ["a1", "a2", "a3", "a4"]) {
      messages.push(assistantToolUse(id), toolResult(id, `${id}-${"x".repeat(400)}`));
    }
    messages.push(assistantText("done"));
    // Appended after the last assistant reply, so the model has never read it.
    messages.push(toolResult("fresh", `fresh-${"x".repeat(400)}`));

    // A target the history already meets stops the step before touching anything.
    assert.equal(await harness.compactor.microCompact(messages, Number.MAX_SAFE_INTEGER), messages);
    assert.equal(toolResultTexts(messages)[1], `a1-${"x".repeat(400)}`);

    await harness.compactor.microCompact(messages, 0);
    const [short, a1, a2, a3, a4, fresh] = toolResultTexts(messages);
    assert.equal(short, "short", "results at or below 120 characters are left alone");
    assert.match(a1 ?? "", /^\[Earlier tool result saved at .+a1\.txt\]$/);
    assert.equal(await readFile(join(harness.resultsDir, "a1.txt"), "utf8"), `a1-${"x".repeat(400)}`);
    // The three most recent read results and the unread one stay whole.
    assert.equal(a2, `a2-${"x".repeat(400)}`);
    assert.equal(a3, `a3-${"x".repeat(400)}`);
    assert.equal(a4, `a4-${"x".repeat(400)}`);
    assert.equal(fresh, `fresh-${"x".repeat(400)}`);
  });
});

// -- Step 4: fit_tool_results ---------------------------------------------------

test("fitToolResults replaces the largest results with short previews until under target", async () => {
  await withTempDir(async (root) => {
    const harness = await buildHarness(root);
    const messages: Conversation = [
      assistantToolUse("a1"),
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "big", content: "b".repeat(9000) },
          { type: "tool_result", tool_use_id: "small", content: "s".repeat(50) },
        ],
      },
    ];

    await harness.compactor.fitToolResults(messages, 0);
    const [big, small] = toolResultTexts(messages);
    assert.ok(big?.includes(`Preview:\n${"b".repeat(1000)}`), "the fitted preview is 1000 characters");
    assert.equal(small, "s".repeat(50), "a result smaller than its placeholder is untouched");
    assert.equal(await readFile(join(harness.resultsDir, "big.txt"), "utf8"), "b".repeat(9000));
  });
});

// -- Step 5: compact_history ----------------------------------------------------

test("compactHistory archives the history and replaces it with one summary message", async () => {
  await withTempDir(async (root) => {
    const harness = await buildHarness(root, "facts only");
    const messages: Conversation = [userText("do the thing"), assistantText("on it")];

    const compacted = await harness.compactor.compactHistory(messages, "do the thing");

    assert.equal(compacted.length, 1);
    const content = contentOf(compacted, 0);
    assert.ok(content.startsWith("[Compacted]\n\nCurrent user request:\ndo the thing\n\n"));
    assert.ok(content.includes('Conversation summary (reference only):\n"facts only"'));
    const transcript = /Full transcript: (.+\.jsonl)$/.exec(content)?.[1];
    assert.ok(transcript, "the replacement message names the transcript");
    assert.equal(
      await readFile(transcript, "utf8"),
      messages.map((message) => `${JSON.stringify(message)}\n`).join(""),
    );

    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.model, "summary-model");
    assert.equal(harness.requests[0]?.system, SUMMARY_SYSTEM);
    assert.equal(harness.requests[0]?.max_tokens, 2000);
    assert.deepEqual(harness.requests[0]?.messages, [
      { role: "user", content: JSON.stringify(messages) },
    ]);
    assert.deepEqual(harness.logs, [`[transcript 已保存：${transcript}]`]);
  });
});

test("prepare only summarizes when the recoverable steps cannot get under the limit", async () => {
  await withTempDir(async (root) => {
    const harness = await buildHarness(root, "compressed state");

    // Well under the limit: no rewrite and no model call.
    const small: Conversation = [userText("hello"), assistantText("hi")];
    assert.equal(await harness.compactor.prepare(small, "hello"), small);
    assert.equal(harness.requests.length, 0);

    // Over the limit, but one oversized unread result can be persisted instead.
    const large: Conversation = [
      userText("read it"),
      assistantToolUse("t1"),
      toolResult("t1", "z".repeat(60_000)),
    ];
    const fitted = await harness.compactor.prepare(large, "read it");
    assert.equal(harness.requests.length, 0, "no summary call was needed");
    assert.ok(toolResultTexts(fitted)[0]?.startsWith("<persisted-output>\n"));
    assert.equal(await readFile(join(harness.resultsDir, "t1.txt"), "utf8"), "z".repeat(60_000));
    assert.ok(ContextCompactor.estimateChars(fitted) <= 50_000);

    // Nothing left to shrink: the history becomes one summary message.
    const compacted = await harness.compactor.prepare([userText("q".repeat(60_000))], "the question");
    assert.equal(compacted.length, 1);
    assert.ok(contentOf(compacted, 0).startsWith("[Compacted]\n\nCurrent user request:\nthe question\n\n"));
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.logs[0], "[自动压缩]");
    assert.match(harness.logs[1] ?? "", /^\[transcript 已保存：.+\.jsonl\]$/);
  });
});

test("afterBatch compacts only when the closed batch executed the compact tool", async () => {
  await withTempDir(async (root) => {
    const harness = await buildHarness(root);
    const messages: Conversation = [userText("q"), assistantToolUse("t1"), toolResult("t1", "r")];

    assert.equal(await harness.compactor.afterBatch(messages, ["bash", "read_file"], "q"), messages);
    assert.equal(harness.requests.length, 0);

    const compacted = await harness.compactor.afterBatch(messages, ["write_file", COMPACT_TOOL_NAME], "q");
    assert.equal(harness.requests.length, 1);
    assert.ok(contentOf(compacted, 0).startsWith("[Compacted]\n"));
  });
});

// -- reactive_compact -----------------------------------------------------------

test("reactive keeps the newest messages and never splits a tool pair", async () => {
  await withTempDir(async (root) => {
    const harness = await buildHarness(root, "older state");
    const messages: Conversation = [
      assistantToolUse("t0"),
      toolResult("t0", "r0"),
      assistantToolUse("t1"),
      toolResult("t1", "r1"),
      assistantText("a4"),
      userText("q5"),
      assistantText("a6"),
      userText("q7"),
    ];

    const recovered = await harness.compactor.reactive(messages, "q7");
    // The kept tail would start at index 3; index 2's tool_use is pulled back in.
    assert.equal(recovered.length, 7);
    assert.ok(contentOf(recovered, 0).startsWith("[Reactive compact]\n\nCurrent user request:\nq7\n\n"));
    assert.deepEqual(recovered.slice(1), messages.slice(2));
    assert.deepEqual(harness.requests[0]?.messages, [
      { role: "user", content: JSON.stringify(messages.slice(0, 2)) },
    ]);
    assert.equal((await readdir(harness.archiveDir)).length, 1);
    assert.equal(harness.logs[0], "[上下文超限，压缩重试]");
    assert.match(harness.logs[1] ?? "", /^\[transcript 已保存：.+\.jsonl\]$/);

    // A history shorter than the kept tail becomes just the summary message.
    const short = await buildHarness(root, "tiny");
    const only = await short.compactor.reactive([userText("hello")], "hello");
    assert.equal(only.length, 1);
    assert.ok(contentOf(only, 0).startsWith("[Reactive compact]"));
  });
});

test("isPromptTooLong recognizes only context-length rejections", async () => {
  await withTempDir(async (root) => {
    const { compactor } = await buildHarness(root);
    assert.equal(compactor.isPromptTooLong(promptTooLong()), true);
    assert.equal(compactor.isPromptTooLong(new Error("too many tokens")), true);
    assert.equal(compactor.isPromptTooLong(new Error("PROMPT_TOO_LONG")), true);
    assert.equal(compactor.isPromptTooLong("prompt_too_long"), true);
    assert.equal(compactor.isPromptTooLong(new Error("overloaded_error")), false);
    assert.equal(compactor.isPromptTooLong(undefined), false);
  });
});

// -- summary_input --------------------------------------------------------------

test("summaryInput keeps the first quarter and the last part of a huge history", async () => {
  await withTempDir(async (root) => {
    const { compactor } = await buildHarness(root);
    const input = compactor.summaryInput([userText("h".repeat(90_000))]);
    assert.ok(charCount(input) < 81_000);
    assert.ok(input.includes("\n...[middle omitted; full transcript is on disk]...\n"));
    assert.ok(input.startsWith('[{"role":"user","content":"hhhh'));
    assert.ok(input.endsWith('hhh"}]'));
  });
});

// -- AgentLoop integration ------------------------------------------------------

interface SpyOptions {
  readonly prepare?: ((messages: Conversation) => Conversation) | undefined;
  readonly afterBatch?: ((messages: Conversation) => Conversation) | undefined;
  readonly reactive?: ((messages: Conversation) => Conversation) | undefined;
}

/** Records every port call and can rewrite the conversation on the way out. */
class SpyCompactor implements CompactionPort {
  readonly prepares: Array<{ readonly messages: Conversation; readonly activeRequest: string }> = [];
  readonly batches: Array<{
    readonly messages: Conversation;
    readonly executedToolNames: readonly string[];
    readonly activeRequest: string;
  }> = [];
  reactiveCalls = 0;
  readonly #options: SpyOptions;

  constructor(options: SpyOptions = {}) {
    this.#options = options;
  }

  async prepare(messages: Conversation, activeRequest: string): Promise<Conversation> {
    this.prepares.push({ messages: structuredClone(messages), activeRequest });
    return this.#options.prepare?.(messages) ?? messages;
  }

  async afterBatch(
    messages: Conversation,
    executedToolNames: readonly string[],
    activeRequest: string,
  ): Promise<Conversation> {
    this.batches.push({
      messages: structuredClone(messages),
      executedToolNames: [...executedToolNames],
      activeRequest,
    });
    return this.#options.afterBatch?.(messages) ?? messages;
  }

  async reactive(messages: Conversation, _activeRequest: string): Promise<Conversation> {
    this.reactiveCalls += 1;
    return this.#options.reactive?.(messages) ?? messages;
  }

  isPromptTooLong(error: unknown): boolean {
    const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return text.includes("prompt_too_long") || text.includes("too many tokens");
  }
}

function queueClient(responses: Array<ModelResponse | Error>): {
  readonly client: ModelClient;
  readonly requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    client: {
      messages: {
        async create(request) {
          requests.push(structuredClone(request));
          const next = responses.shift();
          assert.ok(next, "unexpected extra model request");
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
}

async function buildLoop(options: {
  readonly root: string;
  readonly client: ModelClient;
  readonly compaction?: CompactionPort | undefined;
  readonly maxTurns?: number | undefined;
}): Promise<AgentLoop> {
  const workspace = await createWorkspace(options.root);
  const registry = new ToolRegistry({
    context: new ToolContext({ workspace, locks: new FileLockRegistry() }),
  });
  for (const instance of createDefaultTools()) registry.register(instance);
  return new AgentLoop({
    client: options.client,
    model: "test-model",
    system: "test",
    registry,
    workspaceRoot: options.root,
    presenter: new SilentToolPresenter(),
    compaction: options.compaction,
    maxTurns: options.maxTurns,
  });
}

const toolUseBlock = (id: string, name: string, input: unknown): ContentBlock => ({
  type: "tool_use", id, name, input, caller: { type: "direct" },
});

test("the compact tool is pinned to its marker and takes no arguments", async () => {
  await withTempDir(async (root) => {
    const tool = new CompactTool();
    assert.deepEqual(tool.toAnthropicSchema(), {
      name: "compact",
      description: "把较早的对话总结成摘要，释放上下文空间。",
      input_schema: { type: "object", properties: {} },
    });

    const workspace = await createWorkspace(root);
    const registry = new ToolRegistry({
      context: new ToolContext({ workspace, locks: new FileLockRegistry() }),
    });
    registry.register(tool);
    assert.equal(COMPACT_TOOL_NAME, "compact");
    assert.equal(await registry.invoke("compact", {}), COMPACT_REQUEST_RESULT);
    assert.equal(COMPACT_REQUEST_RESULT, "Compaction requested after this tool batch.");
  });
});

test("prepare runs before every request with the session's active request", async () => {
  await withTempDir(async (root) => {
    const { client, requests } = queueClient([
      { content: [toolUseBlock("t1", "bash", { command: "printf hi" })], stop_reason: "tool_use" },
      { content: [text("done")], stop_reason: "end_turn" },
    ]);
    const compactor = new SpyCompactor();
    const loop = await buildLoop({ root, client, compaction: compactor });
    const session = new Session();
    session.appendUser("the question");

    assert.equal(await loop.run(session), "finished");
    assert.equal(requests.length, 2);
    assert.deepEqual(
      compactor.prepares.map((call) => call.activeRequest),
      ["the question", "the question"],
    );
    assert.equal(compactor.prepares[0]?.messages.length, 1, "prepare runs before the first request");
    assert.equal(compactor.prepares[1]?.messages.length, 3, "and again before the second");
  });
});

test("a prepare rewrite reaches the request payload and keeps the array identity", async () => {
  await withTempDir(async (root) => {
    const rewritten: Conversation = [userText("rewritten by the compactor")];
    const { client, requests } = queueClient([
      { content: [text("done")], stop_reason: "end_turn" },
    ]);
    const messages: Conversation = [];
    const session = new Session(messages);
    session.appendUser("the question");
    const loop = await buildLoop({
      root,
      client,
      compaction: new SpyCompactor({ prepare: () => rewritten }),
    });

    await loop.run(session);
    assert.deepEqual(requests[0]?.messages, rewritten);
    assert.equal(session.messages, messages, "the caller's array must survive a compaction");
    // The rewrite is in place, and the assistant reply is appended after it.
    assert.deepEqual(messages[0], rewritten[0]);
    assert.deepEqual(messages[1], { role: "assistant", content: [text("done")] });
  });
});

test("the compact tool compacts only after the whole batch has closed", async () => {
  await withTempDir(async (root) => {
    const rewritten: Conversation = [userText("[compacted]")];
    const compactor = new SpyCompactor({ afterBatch: () => rewritten });
    const { client, requests } = queueClient([
      {
        content: [
          toolUseBlock("w1", "write_file", { path: "out.txt", content: "hello" }),
          toolUseBlock("c1", COMPACT_TOOL_NAME, {}),
        ],
        stop_reason: "tool_use",
      },
      { content: [text("done")], stop_reason: "end_turn" },
    ]);
    const loop = await buildLoop({ root, client, compaction: compactor });
    const session = new Session();
    session.appendUser("write it, then compact");

    assert.equal(await loop.run(session), "finished");
    assert.equal(compactor.batches.length, 1);
    assert.deepEqual(compactor.batches[0]?.executedToolNames, ["write_file", COMPACT_TOOL_NAME]);
    // Every tool_use already has its tool_result before the summary is requested.
    assert.deepEqual(toolResultTexts(compactor.batches[0]?.messages ?? []), [
      "Wrote 5 bytes to out.txt",
      COMPACT_REQUEST_RESULT,
    ]);
    assert.equal(await readFile(join(root, "out.txt"), "utf8"), "hello", "the side effect was not lost");
    assert.deepEqual(requests[1]?.messages, rewritten);
  });
});

test("a rejected request is rewritten once and retried", async () => {
  await withTempDir(async (root) => {
    const rewritten: Conversation = [userText("[reactive compact]")];
    const compactor = new SpyCompactor({ reactive: () => rewritten });
    const { client, requests } = queueClient([
      promptTooLong(),
      { content: [text("recovered")], stop_reason: "end_turn" },
    ]);
    const loop = await buildLoop({ root, client, compaction: compactor });
    const session = new Session();
    session.appendUser("too big");

    assert.equal(await loop.run(session), "finished");
    assert.equal(requests.length, 2);
    assert.equal(compactor.reactiveCalls, 1);
    assert.deepEqual(requests[0]?.messages, [userText("too big")]);
    assert.deepEqual(requests[1]?.messages, rewritten);
  });
});

test("the reactive retry happens at most once per run", async () => {
  await withTempDir(async (root) => {
    const compactor = new SpyCompactor();
    const { client, requests } = queueClient([promptTooLong(), promptTooLong()]);
    const loop = await buildLoop({ root, client, compaction: compactor });
    const session = new Session();
    session.appendUser("too big");

    await assert.rejects(() => loop.run(session), /prompt_too_long/);
    assert.equal(requests.length, 2, "the first rejection retries, the second escapes");
    assert.equal(compactor.reactiveCalls, 1);
  });
});

test("a retry counts as a model request towards maxTurns", async () => {
  await withTempDir(async (root) => {
    const compactor = new SpyCompactor();
    const { client, requests } = queueClient([
      promptTooLong(),
      { content: [text("never sent")], stop_reason: "end_turn" },
    ]);
    const loop = await buildLoop({ root, client, compaction: compactor, maxTurns: 1 });
    const session = new Session();
    session.appendUser("too big");

    assert.equal(await loop.run(session), "turn-limit");
    assert.equal(requests.length, 1, "no second request is issued once the cap is reached");
    assert.equal(compactor.reactiveCalls, 1);
  });
});

test("an ordinary API error is never rewritten", async () => {
  await withTempDir(async (root) => {
    const compactor = new SpyCompactor();
    const { client, requests } = queueClient([new Error("overloaded_error")]);
    const loop = await buildLoop({ root, client, compaction: compactor });
    const session = new Session();
    session.appendUser("hello");

    await assert.rejects(() => loop.run(session), /overloaded_error/);
    assert.equal(requests.length, 1);
    assert.equal(compactor.reactiveCalls, 0);
    assert.equal(compactor.batches.length, 0);
  });
});

test("a subagent compacts its own session with the delegated prompt as the request", async () => {
  await withTempDir(async (root) => {
    const workspace = await createWorkspace(root);
    const registry = new ToolRegistry({
      context: new ToolContext({ workspace, locks: new FileLockRegistry() }),
    });
    for (const instance of createDefaultTools()) registry.register(instance);
    const compactor = new SpyCompactor();
    const { client, requests } = queueClient([
      { content: [text("child summary")], stop_reason: "end_turn" },
    ]);
    const runner = new SubagentRunner({
      client,
      model: "test-model",
      system: "child",
      registry,
      workspaceRoot: root,
      presenter: new SilentSubagentPresenter(),
      compaction: compactor,
    });

    assert.equal(await runner.run("summarize a.txt"), "child summary");
    assert.equal(compactor.prepares.length, 1);
    assert.equal(compactor.prepares[0]?.activeRequest, "summarize a.txt");
    assert.deepEqual(requests[0]?.messages, [{ role: "user", content: "summarize a.txt" }]);
  });
});
