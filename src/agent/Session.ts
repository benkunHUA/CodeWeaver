import type { ContentBlock, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { Conversation } from "../types.js";

export class Session {
  readonly #messages: Conversation;

  constructor(messages: Conversation = []) {
    // Keep the caller's array by reference: the CLI and tests hold it externally.
    this.#messages = messages;
  }

  /** The underlying conversation array; kept for the SDK request payload. */
  get messages(): Conversation {
    return this.#messages;
  }

  appendAssistant(content: ContentBlock[]): void {
    this.#messages.push({ role: "assistant", content });
  }

  appendToolResults(results: readonly ToolResultBlockParam[]): void {
    this.#messages.push({ role: "user", content: [...results] });
  }

  injectUser(text: string): void {
    this.#messages.push({ role: "user", content: text });
  }
}
