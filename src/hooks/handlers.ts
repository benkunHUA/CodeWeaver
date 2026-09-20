import type { Conversation } from "../types.js";
import type { HookHandler, PermissionChecker } from "./types.js";

const DEFAULT_LARGE_OUTPUT_THRESHOLD = 100_000;

export interface HookLoggerOptions {
  readonly log?: ((message: string) => void) | undefined;
}

export interface LargeOutputHookOptions extends HookLoggerOptions {
  readonly threshold?: number | undefined;
}

// Non-object tool input is treated as an empty record before permission checks.
function asRecord(input: unknown): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null) return {};
  return input as Readonly<Record<string, unknown>>;
}

function isToolResultBlock(block: unknown): boolean {
  return typeof block === "object" && block !== null
    && (block as { readonly type?: unknown }).type === "tool_result";
}

function countToolResults(messages: Conversation): number {
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isToolResultBlock(block)) count += 1;
    }
  }
  return count;
}

// PreToolUse: forward the call to the permission pipeline and block on denial.
export function createPermissionHook(
  checker: PermissionChecker,
  options: HookLoggerOptions = {},
): HookHandler<"PreToolUse"> {
  const log = options.log ?? console.log;
  return async ({ toolName, input, workspaceRoot }) => {
    const result = await checker.check({ toolName, input: asRecord(input), workspaceRoot });
    if (result.allowed === false) {
      log(`\n\x1b[31m[blocked] ${result.reason}\x1b[0m`);
      return "Permission denied.";
    }
    return undefined;
  };
}

// PreToolUse: log every tool call that reaches the bus.
export function createLogHook(options: HookLoggerOptions = {}): HookHandler<"PreToolUse"> {
  const log = options.log ?? console.log;
  return ({ toolName }) => {
    log(`\x1b[90m[HOOK] ${toolName}(...)\x1b[0m`);
  };
}

// PostToolUse: warn when a tool result is unusually large.
export function createLargeOutputHook(options: LargeOutputHookOptions = {}): HookHandler<"PostToolUse"> {
  const log = options.log ?? console.log;
  const threshold = options.threshold ?? DEFAULT_LARGE_OUTPUT_THRESHOLD;
  return ({ toolName, result }) => {
    if (result.length > threshold) {
      log(`\x1b[33m[HOOK] Large output from ${toolName}: ${result.length} chars\x1b[0m`);
    }
  };
}

// Stop: summarise how many tool calls the session used before exiting.
export function createSessionSummaryHook(options: HookLoggerOptions = {}): HookHandler<"Stop"> {
  const log = options.log ?? console.log;
  return ({ messages }) => {
    log(`\x1b[90m[HOOK] Stop: session used ${countToolResults(messages)} tool calls\x1b[0m`);
  };
}

// UserPromptSubmit: announce the workspace before the prompt reaches the model.
export function createWorkspaceContextHook(options: HookLoggerOptions = {}): HookHandler<"UserPromptSubmit"> {
  const log = options.log ?? console.log;
  return ({ workspaceRoot }) => {
    log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${workspaceRoot}\x1b[0m`);
  };
}
