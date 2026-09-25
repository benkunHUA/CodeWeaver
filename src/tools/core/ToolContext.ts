import type { Workspace } from "../../types.js";
import { TodoStore } from "../../planning/TodoStore.js";
import type { SkillLibrary } from "../../skills/types.js";
import type { SubagentLauncher } from "../../subagent/types.js";
import type { FileLockRegistry } from "./FileLockRegistry.js";

export interface ToolContextOptions {
  readonly workspace: Workspace;
  readonly locks: FileLockRegistry;
  // Explicit `| undefined` lets callers forward optional values directly.
  readonly logger?: ((message: string) => void) | undefined;
  readonly todos?: TodoStore | undefined;
  readonly subagents?: SubagentLauncher | undefined;
  readonly skills?: SkillLibrary | undefined;
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
  /**
   * Delegation port the `task` tool uses to run a subagent. `undefined` means
   * "delegation is not allowed in this context" (the registry a subagent runs
   * with is built from exactly that kind of context), never "use a default
   * launcher": a context without a launcher must fail closed.
   */
  readonly subagents: SubagentLauncher | undefined;
  /**
   * Skill lookup port the `load_skill` tool reads from. `undefined` means
   * "this context has no skill library", so a tool that depends on it must fail
   * closed instead of fabricating an empty library.
   */
  readonly skills: SkillLibrary | undefined;

  constructor(options: ToolContextOptions) {
    this.workspace = options.workspace;
    this.locks = options.locks;
    this.logger = options.logger ?? (() => {});
    this.todos = options.todos ?? new TodoStore();
    this.subagents = options.subagents;
    this.skills = options.skills;
  }
}
