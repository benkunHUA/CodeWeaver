import { sliceCharacters } from "../bash.js";
import type { Logger } from "../types.js";

const BASH_TOOL_NAME = "bash";

/** True only when `input.command` is a string, matching the old parser contract. */
function isBashInput(input: unknown): input is { readonly command: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "command" in input &&
    typeof (input as { command?: unknown }).command === "string"
  );
}

export interface ToolPresenter {
  /** Show the tool about to run. */
  showToolCall(name: string, input: unknown): void;
  /** Show the tool result preview; `toolName` is the tool that produced it. */
  showResult(result: string, toolName: string): void;
}

export class SilentToolPresenter implements ToolPresenter {
  showToolCall(_name: string, _input: unknown): void {}

  showResult(_result: string, _toolName: string): void {}
}

export interface ConsoleToolPresenterOptions {
  readonly log?: Logger | undefined;
  readonly previewLength?: number | undefined;
}

const DEFAULT_PREVIEW_LENGTH = 200;

export class ConsoleToolPresenter implements ToolPresenter {
  readonly #log: Logger;
  readonly #previewLength: number;

  constructor(options: ConsoleToolPresenterOptions = {}) {
    this.#log = options.log ?? console.log;
    this.#previewLength = options.previewLength ?? DEFAULT_PREVIEW_LENGTH;
  }

  showToolCall(name: string, input: unknown): void {
    // The `> name` line belongs to the registry layer (ToolHooks.before), so
    // only bash prints here, and only when its command is a string.
    if (name !== BASH_TOOL_NAME) return;
    if (!isBashInput(input)) return;
    this.#log(`\x1b[33m$ ${input.command}\x1b[0m`);
  }

  showResult(result: string, _toolName: string): void {
    this.#log(sliceCharacters(result, this.#previewLength));
  }
}
