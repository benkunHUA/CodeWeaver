export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}

/** Input contract of the todo_write tool. Owned by planning, like other modules own theirs. */
export interface TodoWriteInput {
  readonly todos: readonly TodoItem[];
}
