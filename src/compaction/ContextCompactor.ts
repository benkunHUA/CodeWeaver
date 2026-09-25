import type {
  ContentBlockParam,
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { Conversation, ModelClient } from "../types.js";
import { charCount } from "./text.js";
import type { ToolResultStore } from "./ToolResultStore.js";
import type { TranscriptArchive } from "./TranscriptArchive.js";
import {
  COMPACTED_LABEL,
  COMPACT_TOOL_NAME,
  CONTEXT_CHAR_LIMIT,
  EARLIER_RESULT_PREFIX,
  FIT_PREVIEW_CHARS,
  KEEP_RECENT_MESSAGES,
  KEEP_RECENT_RESULTS,
  LARGE_RESULT_CHAR_LIMIT,
  MICRO_MIN_RESULT_CHARS,
  MICRO_TARGET_RATIO,
  REACTIVE_COMPACT_LABEL,
  SNIP_HEAD_MESSAGES,
  SNIP_MAX_MESSAGES,
  SUMMARY_INPUT_CHAR_LIMIT,
  SUMMARY_MAX_TOKENS,
  SUMMARY_SYSTEM,
  TOOL_RESULT_BATCH_CHAR_LIMIT,
} from "./types.js";
import type { CompactionPort } from "./types.js";

/** A `tool_result` carrying plain text, the only shape this project's tools emit. */
type TextToolResultBlock = ToolResultBlockParam & { content: string };

interface ToolResultEntry {
  /** `"<messageIndex>:<blockIndex>"`, the identity used for unseen-set lookups. */
  readonly position: string;
  readonly block: TextToolResultBlock;
}

function isTextToolResultBlock(block: ContentBlockParam): block is TextToolResultBlock {
  return block.type === "tool_result" && typeof block.content === "string";
}

function contentBlocks(message: MessageParam | undefined): ContentBlockParam[] {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content;
}

function hasToolUse(message: MessageParam | undefined): boolean {
  return message?.role === "assistant"
    && contentBlocks(message).some((block) => block.type === "tool_use");
}

function isToolResult(message: MessageParam | undefined): boolean {
  return message?.role === "user"
    && contentBlocks(message).some((block) => block.type === "tool_result");
}

/**
 * Collects string-content tool results in document order. Non-string content is
 * skipped on purpose: Python's `str(...)` would stringify it, but this project's
 * tools only ever write strings and `String()` would leak "[object Object]".
 */
function toolResultEntries(messages: Conversation): ToolResultEntry[] {
  const entries: ToolResultEntry[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== "user") return;
    contentBlocks(message).forEach((block, blockIndex) => {
      if (isTextToolResultBlock(block)) {
        entries.push({ position: `${messageIndex}:${blockIndex}`, block });
      }
    });
  });
  return entries;
}

/** Results appended after the model's most recent response are still unseen. */
function unseenToolResultPositions(messages: Conversation): Set<string> {
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      lastAssistant = index;
      break;
    }
  }
  const positions = new Set<string>();
  for (let messageIndex = lastAssistant + 1; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "user") continue;
    contentBlocks(message).forEach((block, blockIndex) => {
      if (block.type === "tool_result") positions.add(`${messageIndex}:${blockIndex}`);
    });
  }
  return positions;
}

export interface ContextCompactorOptions {
  readonly client: ModelClient;
  readonly model: string;
  readonly archive: TranscriptArchive;
  readonly results: ToolResultStore;
  /** Diagnostics sink; defaults to a no-op so tests can stay quiet. */
  readonly log?: ((message: string) => void) | undefined;
}

/**
 * The four-step compaction pipeline from s08 plus the summarization fallback.
 *
 * Order is fixed on purpose: the cheap, lossless-but-recoverable steps run on
 * every request, and only a conversation that is still over budget reaches the
 * one step that costs a model call. Every step is public so it can be tested
 * and reused in isolation, while `CompactionPort` exposes only what the loop
 * needs.
 */
export class ContextCompactor implements CompactionPort {
  readonly #client: ModelClient;
  readonly #model: string;
  readonly #archive: TranscriptArchive;
  readonly #results: ToolResultStore;
  readonly #logger: (message: string) => void;

  constructor(options: ContextCompactorOptions) {
    this.#client = options.client;
    this.#model = options.model;
    this.#archive = options.archive;
    this.#results = options.results;
    this.#logger = options.log ?? (() => {});
  }

  static estimateChars(messages: Conversation): number {
    // Counts Unicode code points like Python's len(json.dumps(..., ensure_ascii=False)),
    // but JSON.stringify emits tighter separators than json.dumps (no space after
    // "," or ":"), so the value is a faithful trigger, not a byte-identical one.
    return charCount(JSON.stringify(messages));
  }

  /** Runs before every model request; returns the conversation to send. */
  async prepare(messages: Conversation, activeRequest: string): Promise<Conversation> {
    let next = await this.toolResultBudget(messages);
    next = await this.snipCompact(next);
    if (ContextCompactor.estimateChars(next) > CONTEXT_CHAR_LIMIT) {
      const target = Math.floor(CONTEXT_CHAR_LIMIT * MICRO_TARGET_RATIO);
      next = await this.microCompact(next, target);
      if (ContextCompactor.estimateChars(next) > CONTEXT_CHAR_LIMIT) {
        next = await this.fitToolResults(next, target);
        if (ContextCompactor.estimateChars(next) > CONTEXT_CHAR_LIMIT) {
          this.#log("[自动压缩]");
          next = await this.compactHistory(next, activeRequest);
        }
      }
    }
    return next;
  }

  /** Runs after a closed tool batch; compacts when the batch asked for it. */
  async afterBatch(
    messages: Conversation,
    executedToolNames: readonly string[],
    activeRequest: string,
  ): Promise<Conversation> {
    if (executedToolNames.includes(COMPACT_TOOL_NAME)) {
      return this.compactHistory(messages, activeRequest);
    }
    return messages;
  }

  /** Reactive path after the API rejected an oversized prompt. */
  async reactive(messages: Conversation, activeRequest: string): Promise<Conversation> {
    this.#log("[上下文超限，压缩重试]");
    const transcriptPath = await this.#archive.write(messages);
    this.#log(`[transcript 已保存：${transcriptPath}]`);
    let tailStart = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
    // Never split a tool_use from its tool_result: an orphan result is rejected
    // by the API on the retry.
    if (tailStart > 0 && isToolResult(messages[tailStart]) && hasToolUse(messages[tailStart - 1])) {
      tailStart -= 1;
    }
    const oldHistory = tailStart ? messages.slice(0, tailStart) : messages;
    const summary = await this.summarizeHistory(oldHistory);
    const message = this.summaryMessage(REACTIVE_COMPACT_LABEL, activeRequest, summary, transcriptPath);
    return tailStart ? [message, ...messages.slice(tailStart)] : [message];
  }

  /** True when the error means the prompt exceeded the model context. */
  isPromptTooLong(error: unknown): boolean {
    const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return text.includes("prompt_too_long") || text.includes("too many tokens");
  }

  /** Step 1: persist oversized results from the latest (last) tool batch. */
  async toolResultBudget(
    messages: Conversation,
    maxChars: number = TOOL_RESULT_BATCH_CHAR_LIMIT,
  ): Promise<Conversation> {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user") return messages;
    const blocks = contentBlocks(last).filter(isTextToolResultBlock);
    let total = blocks.reduce((sum, block) => sum + charCount(block.content), 0);
    // Stable descending sort by size; the batch order (not the result order) is
    // preserved in the messages themselves.
    const bySize = [...blocks].sort((a, b) => charCount(b.content) - charCount(a.content));
    for (const block of bySize) {
      if (total <= maxChars) break;
      if (charCount(block.content) <= LARGE_RESULT_CHAR_LIMIT) continue;
      block.content = await this.#results.persistLargeOutput(block.tool_use_id, block.content);
      total = blocks.reduce((sum, item) => sum + charCount(item.content), 0);
    }
    return messages;
  }

  /** Step 2: archive the middle of a very long history behind a marker. */
  async snipCompact(
    messages: Conversation,
    maxMessages: number = SNIP_MAX_MESSAGES,
  ): Promise<Conversation> {
    if (messages.length <= maxMessages) return messages;
    let headEnd = SNIP_HEAD_MESSAGES;
    let tailStart = messages.length - (maxMessages - headEnd - 1);
    if (hasToolUse(messages[headEnd - 1])) {
      while (headEnd < tailStart && isToolResult(messages[headEnd])) headEnd += 1;
    }
    if (tailStart > 0 && isToolResult(messages[tailStart]) && hasToolUse(messages[tailStart - 1])) {
      tailStart -= 1;
    }
    if (headEnd >= tailStart) return messages;
    const middle = messages.slice(headEnd, tailStart);
    // Already snipped in an earlier turn: re-archiving would only grow the file.
    if (middle.length === 1 && (await this.#archive.isMarker(middle[0]))) return messages;
    const transcriptPath = await this.#archive.write(messages);
    const marker: MessageParam = {
      role: "user",
      content: `[${tailStart - headEnd} messages archived at ${transcriptPath}]`,
    };
    return [...messages.slice(0, headEnd), marker, ...messages.slice(tailStart)];
  }

  /** Step 3: replace older, already-read results with recoverable references. */
  async microCompact(
    messages: Conversation,
    targetChars: number | undefined,
  ): Promise<Conversation> {
    const entries = toolResultEntries(messages);
    const unseen = unseenToolResultPositions(messages);
    const consumed = entries.filter((entry) => !unseen.has(entry.position));
    // The most recent consumed results stay whole; the model just read them.
    const candidates = consumed.slice(0, Math.max(0, consumed.length - KEEP_RECENT_RESULTS));
    for (const entry of candidates) {
      if (targetChars !== undefined && ContextCompactor.estimateChars(messages) <= targetChars) {
        break;
      }
      if (charCount(entry.block.content) <= MICRO_MIN_RESULT_CHARS) continue;
      let savedPath = await this.#results.resolvePlaceholder(entry.block.content);
      if (!savedPath) {
        savedPath = await this.#results.save(entry.block.tool_use_id, entry.block.content);
      }
      entry.block.content = `${EARLIER_RESULT_PREFIX}${savedPath}]`;
    }
    return messages;
  }

  /** Step 4: shrink every oversized result to a short preview until under target. */
  async fitToolResults(messages: Conversation, targetChars: number): Promise<Conversation> {
    const blocks = toolResultEntries(messages).map((entry) => entry.block);
    const bySize = [...blocks].sort((a, b) => charCount(b.content) - charCount(a.content));
    for (const block of bySize) {
      if (ContextCompactor.estimateChars(messages) <= targetChars) break;
      const output = block.content;
      const replacement = await this.#results.persistedPreview(
        block.tool_use_id,
        output,
        FIT_PREVIEW_CHARS,
      );
      if (charCount(replacement) < charCount(output)) block.content = replacement;
    }
    return messages;
  }

  /** The text handed to the summarizer, head+tail kept when it is too long. */
  summaryInput(messages: Conversation): string {
    const conversation = JSON.stringify(messages);
    if (charCount(conversation) <= SUMMARY_INPUT_CHAR_LIMIT) return conversation;
    const head = Math.floor(SUMMARY_INPUT_CHAR_LIMIT / 4);
    const tail = SUMMARY_INPUT_CHAR_LIMIT - head;
    // Python's conversation[-tail:] counts code points, so slice the code-point
    // array rather than the UTF-16 string.
    const codePoints = Array.from(conversation);
    const tailText = codePoints.slice(codePoints.length - tail).join("");
    return `${codePoints.slice(0, head).join("")}`
      + "\n...[middle omitted; full transcript is on disk]...\n"
      + tailText;
  }

  async summarizeHistory(messages: Conversation): Promise<string> {
    const response = await this.#client.messages.create({
      model: this.#model,
      system: SUMMARY_SYSTEM,
      messages: [{ role: "user", content: this.summaryInput(messages) }],
      max_tokens: SUMMARY_MAX_TOKENS,
    });
    const parts: string[] = [];
    for (const block of response.content) {
      if (block.type === "text") parts.push(block.text);
    }
    return parts.join("\n").trim() || "(empty summary)";
  }

  /**
   * A single replacement message: the summary is reference data and the active
   * request stays the only instruction, so a compacted turn cannot be hijacked
   * by text captured from an old tool result.
   */
  summaryMessage(
    label: string,
    request: string,
    summary: string,
    transcriptPath: string,
  ): MessageParam {
    return {
      role: "user",
      content: `[${label}]\n\nCurrent user request:\n${request}\n\n`
        + `Conversation summary (reference only):\n${JSON.stringify(summary)}\n\n`
        + `Full transcript: ${transcriptPath}`,
    };
  }

  /** Step 5 of the pipeline: replace the whole history with one summary message. */
  async compactHistory(messages: Conversation, activeRequest: string): Promise<Conversation> {
    const transcriptPath = await this.#archive.write(messages);
    this.#log(`[transcript 已保存：${transcriptPath}]`);
    const summary = await this.summarizeHistory(messages);
    return [this.summaryMessage(COMPACTED_LABEL, activeRequest, summary, transcriptPath)];
  }

  #log(text: string): void {
    this.#logger(text);
  }
}
