import { stripWhitespace } from "../bash.js";
import { TODO_STATUSES, type TodoItem, type TodoStatus } from "./types.js";

const MAX_TODOS = 20;

const MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

function isTodoStatus(value: string): value is TodoStatus {
  return (TODO_STATUSES as readonly string[]).includes(value);
}

/**
 * Immutable todo list. Instances are only created through `empty`/`parse`, so
 * every stored item is already validated and normalized.
 */
export class TodoList {
  readonly #items: readonly TodoItem[];

  private constructor(items: readonly TodoItem[]) {
    this.#items = items;
  }

  static empty(): TodoList {
    return new TodoList([]);
  }

  /**
   * Validates and normalizes raw tool input. Check order and error text mirror
   * the Python TodoManager.update, since the order decides which error wins.
   */
  static parse(raw: unknown): TodoList {
    if (!Array.isArray(raw)) throw new Error("todos must be a list");
    if (raw.length > MAX_TODOS) throw new Error(`Max ${MAX_TODOS} todos allowed`);

    const validated: TodoItem[] = [];
    let inProgress = 0;
    for (const [index, todo] of raw.entries()) {
      if (typeof todo !== "object" || todo === null || Array.isArray(todo)) {
        throw new Error(`todos[${index}] must be an object`);
      }
      const record = todo as Record<string, unknown>;
      // Python str(...).strip() / str(...).lower() over the raw values.
      const content = stripWhitespace(String(record["content"] ?? ""));
      const status = String(record["status"] ?? "pending").toLowerCase();

      if (content === "") throw new Error(`todos[${index}] requires content`);
      if (!isTodoStatus(status)) {
        throw new Error(`todos[${index}] has invalid status '${status}'`);
      }
      if (status === "in_progress") inProgress += 1;
      validated.push({ content, status });
    }

    // Counted only after every item passed, so a bad status wins over this.
    if (inProgress > 1) throw new Error("Only one todo can be in_progress at a time");

    return new TodoList(validated);
  }

  get items(): readonly TodoItem[] {
    return this.#items;
  }

  get isEmpty(): boolean {
    return this.#items.length === 0;
  }

  render(): string {
    if (this.#items.length === 0) return "No todos.";

    const lines = this.#items.map((todo) => `${MARKERS[todo.status]} ${todo.content}`);
    const done = this.#items.filter((todo) => todo.status === "completed").length;
    // This line starts with "\n", which leaves a blank line before the summary.
    lines.push(`\n(${done}/${this.#items.length} completed)`);
    return lines.join("\n");
  }
}
