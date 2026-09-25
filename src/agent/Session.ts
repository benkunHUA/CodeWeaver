import type { ContentBlock, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { Conversation } from "../types.js";

export class Session {
  readonly #messages: Conversation;
  // This turn's user request, tracked separately because compaction must keep
  // the "current request" apart from the conversation summary; tool results are
  // also `role: "user"`, so they cannot be used to recover the request.
  #activeRequest = "";

  constructor(messages: Conversation = []) {
    // Keep the caller's array by reference: the CLI and tests hold it externally.
    this.#messages = messages;
  }

  /** The underlying conversation array; kept for the SDK request payload. */
  get messages(): Conversation {
    return this.#messages;
  }

  /** This turn's user request; compaction keeps it apart from the summary. */
  get activeRequest(): string {
    return this.#activeRequest;
  }

  appendAssistant(content: ContentBlock[]): void {
    this.#messages.push({ role: "assistant", content });
  }

  appendToolResults(results: readonly ContentBlockParam[]): void {
    this.#messages.push({ role: "user", content: [...results] });
  }

  /** Appends a user turn and records it as this turn's active request. */
  appendUser(query: string): void {
    this.#messages.push({ role: "user", content: query });
    this.#activeRequest = query;
  }

  /**
   * Rewrites the conversation in place. The array is mutated (clear, then push
   * one message at a time) instead of reassigned or spread, so references held
   * by the CLI and tests keep pointing at the same array; spreading a huge
   * array into `push(...messages)` would also risk the call-argument limit.
   *
   * A compaction step that rewrote nothing hands the very same array back;
   * clearing it first would empty the source before the loop can re-add
   * anything, so an identical array is simply a no-op.
   */
  replace(messages: Conversation): void {
    if (messages === this.#messages) return;
    this.#messages.splice(0, this.#messages.length);
    for (const message of messages) this.#messages.push(message);
  }

  /**
   * Injects a Stop-hook message. It is a user turn but not this turn's request,
   * so it deliberately leaves `activeRequest` untouched.
   */
  injectUser(text: string): void {
    this.#messages.push({ role: "user", content: text });
  }
}
