import { TodoList } from "./TodoList.js";

/** Session-level mutable todo state; the list itself stays immutable. */
export class TodoStore {
  #list: TodoList = TodoList.empty();

  get list(): TodoList {
    return this.#list;
  }

  /**
   * Validates before replacing the state: a rejected update throws and leaves
   * the previous list untouched. Returns the new `render()`.
   */
  update(raw: unknown): string {
    const next = TodoList.parse(raw);
    this.#list = next;
    return next.render();
  }
}
