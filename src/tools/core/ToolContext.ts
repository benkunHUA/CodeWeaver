import type { Workspace } from "../../types.js";
import { TodoStore } from "../../planning/TodoStore.js";
import type { FileLockRegistry } from "./FileLockRegistry.js";

export interface ToolContextOptions {
  readonly workspace: Workspace;
  readonly locks: FileLockRegistry;
  // Explicit `| undefined` lets callers forward optional values directly.
  readonly logger?: ((message: string) => void) | undefined;
  readonly todos?: TodoStore | undefined;
}

/** Everything a tool needs at runtime, without any global mutable state. */
export class ToolContext {
  readonly workspace: Workspace;
  readonly locks: FileLockRegistry;
  /** Diagnostics sink; a throwing logger must never break a tool call. */
  readonly logger: (message: string) => void;
  /**
   * Session-level todo state, owned by the injected instance: a module-level
   * mutable todo singleton is deliberately forbidden in this repository.
   */
  readonly todos: TodoStore;

  constructor(options: ToolContextOptions) {
    this.workspace = options.workspace;
    this.locks = options.locks;
    this.logger = options.logger ?? (() => {});
    this.todos = options.todos ?? new TodoStore();
  }
}
