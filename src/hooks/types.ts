import type { Conversation } from "../types.js";

// The four hook points of the agent loop, mirroring s04_hooks/code.py.
export type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

export interface UserPromptSubmitContext {
  readonly query: string;
  readonly workspaceRoot: string;
}
export interface PreToolUseContext {
  readonly toolName: string;
  readonly input: unknown;
  readonly workspaceRoot: string;
}
export interface PostToolUseContext {
  readonly toolName: string;
  readonly input: unknown;
  readonly result: string;
  readonly workspaceRoot: string;
}
export interface StopContext {
  readonly messages: Conversation;
  readonly workspaceRoot: string;
}
export interface HookContexts {
  readonly UserPromptSubmit: UserPromptSubmitContext;
  readonly PreToolUse: PreToolUseContext;
  readonly PostToolUse: PostToolUseContext;
  readonly Stop: StopContext;
}
export type HookResult = string | void;
export type HookHandler<E extends HookEvent> = (context: HookContexts[E]) => HookResult | Promise<HookResult>;
export type HookErrorPolicy = "block" | "ignore";

// Structural interface decoupled from src/permission: any pipeline exposing check() can plug in.
export interface PermissionCheckResult {
  readonly allowed: boolean;
  readonly reason: string;
  readonly gate: string;
}
export interface PermissionRequestShape {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly workspaceRoot: string;
}
export interface PermissionChecker {
  check(request: PermissionRequestShape): Promise<PermissionCheckResult>;
}
