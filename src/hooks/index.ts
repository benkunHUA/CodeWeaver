import { HookBus } from "./HookBus.js";
import {
  createLargeOutputHook,
  createLogHook,
  createPermissionHook,
  createSessionSummaryHook,
  createWorkspaceContextHook,
} from "./handlers.js";
import type { PermissionChecker } from "./types.js";

export { HookBus };
export type { HookBusOptions, HookRegisterOptions } from "./HookBus.js";
export {
  createLargeOutputHook,
  createLogHook,
  createPermissionHook,
  createSessionSummaryHook,
  createWorkspaceContextHook,
};
export type {
  HookContexts,
  HookErrorPolicy,
  HookEvent,
  HookHandler,
  HookResult,
  PermissionCheckResult,
  PermissionChecker,
  PermissionRequestShape,
  PostToolUseContext,
  PreToolUseContext,
  StopContext,
  UserPromptSubmitContext,
} from "./types.js";

export interface DefaultHooksOptions {
  readonly checker: PermissionChecker;
  readonly workspaceRoot: string;
  readonly logger?: ((message: string) => void) | undefined;
  readonly log?: ((message: string) => void) | undefined;
  readonly largeOutputThreshold?: number | undefined;
}

// Composition root: the s04 registration order, with permission checked before logging.
export function createDefaultHooks(options: DefaultHooksOptions): HookBus {
  const log = options.log ?? console.log;
  const bus = new HookBus({ logger: options.logger });
  bus.register("UserPromptSubmit", createWorkspaceContextHook({ log }), { name: "workspace-context" });
  bus.register("PreToolUse", createPermissionHook(options.checker, { log }), { name: "permission" });
  bus.register("PreToolUse", createLogHook({ log }), { name: "log" });
  bus.register("PostToolUse", createLargeOutputHook({ log, threshold: options.largeOutputThreshold }), {
    name: "large-output",
  });
  bus.register("Stop", createSessionSummaryHook({ log }), { name: "session-summary" });
  return bus;
}
