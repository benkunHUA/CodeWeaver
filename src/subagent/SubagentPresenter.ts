import { sliceCharacters } from "../bash.js";
import type { Logger } from "../types.js";
import { SilentToolPresenter, type ToolPresenter } from "../agent/ToolPresenter.js";

/** Result preview length, matching the s06 `output[:100]` slice. */
const SUBAGENT_PREVIEW_LENGTH = 100;

/**
 * Terminal port of the subagent: start/finish/stopped markers plus a prefixed
 * tool-result line. It extends `ToolPresenter` so the nested `AgentLoop` can use
 * it unchanged, with one deliberate difference: `showToolCall` prints nothing,
 * because the subagent must not echo the parent's `$ command` line.
 */
export interface SubagentPresenter extends ToolPresenter {
  showStart(): void;
  showFinish(): void;
  showStopped(): void;
}

export interface ConsoleSubagentPresenterOptions {
  readonly log?: Logger | undefined;
}

export class ConsoleSubagentPresenter implements SubagentPresenter {
  readonly #log: Logger;

  constructor(options: ConsoleSubagentPresenterOptions = {}) {
    this.#log = options.log ?? console.log;
  }

  showStart(): void {
    this.#log("\n\x1b[35m[子智能体] 已启动\x1b[0m");
  }

  showResult(result: string, toolName: string): void {
    const preview = sliceCharacters(result, SUBAGENT_PREVIEW_LENGTH);
    this.#log(`  \x1b[90m[子智能体] ${toolName}: ${preview}\x1b[0m`);
  }

  showFinish(): void {
    this.#log("\x1b[35m[子智能体] 已完成\x1b[0m");
  }

  showStopped(): void {
    this.#log("\x1b[35m[子智能体] 已停止（达到轮次上限）\x1b[0m");
  }

  /** The subagent never prints the tool invocation itself. */
  showToolCall(_name: string, _input: unknown): void {}
}

/** Presenter for tests and headless use: every method is a no-op. */
export class SilentSubagentPresenter extends SilentToolPresenter implements SubagentPresenter {
  showStart(): void {}

  showFinish(): void {}

  showStopped(): void {}
}
