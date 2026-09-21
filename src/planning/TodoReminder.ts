import type { ToolRoundReminder } from "../agent/AgentLoop.js";

export const TODO_REMINDER_TEXT = "<reminder>请更新你的任务列表。</reminder>";
export const TODO_REMINDER_THRESHOLD = 3;
export const TODO_REMINDER_TOOL = "todo_write";

export interface TodoReminderOptions {
  readonly threshold?: number | undefined;
  readonly toolName?: string | undefined;
  readonly text?: string | undefined;
}

/**
 * Counts consecutive tool rounds that ignored the todo tool and asks the loop
 * to append a reminder once the threshold is reached. The counter is reset by
 * a todo round, by emitting a reminder, and at the start of every run.
 */
export class TodoReminder implements ToolRoundReminder {
  readonly #threshold: number;
  readonly #toolName: string;
  readonly #text: string;
  #roundsSinceTodo = 0;

  constructor(options: TodoReminderOptions = {}) {
    this.#threshold = options.threshold ?? TODO_REMINDER_THRESHOLD;
    this.#toolName = options.toolName ?? TODO_REMINDER_TOOL;
    this.#text = options.text ?? TODO_REMINDER_TEXT;
  }

  beginRun(): void {
    this.#roundsSinceTodo = 0;
  }

  afterToolRound(toolNames: readonly string[]): string | undefined {
    if (toolNames.includes(this.#toolName)) {
      this.#roundsSinceTodo = 0;
      return undefined;
    }
    this.#roundsSinceTodo += 1;
    if (this.#roundsSinceTodo < this.#threshold) return undefined;
    this.#roundsSinceTodo = 0;
    return this.#text;
  }
}
