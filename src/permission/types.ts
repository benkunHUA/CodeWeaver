export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRequest {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly workspaceRoot: string;
}

export interface PermissionDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly gate: string;
}

export type GateOutcome =
  | { readonly kind: "decide"; readonly decision: PermissionDecision }
  | { readonly kind: "ask"; readonly reason: string; readonly gate: string };

export interface GateContext {
  readonly request: PermissionRequest;
  readonly ask?: { readonly reason: string; readonly gate: string } | undefined;
}

export interface PermissionRule {
  readonly name: string;
  readonly tools: readonly string[];
  readonly message: string;
  /** undefined = the rule does not match. */
  evaluate(request: PermissionRequest): PermissionAction | undefined;
}

// Approval prompt contract. The implementation lives in ApprovalGate.ts and is
// added by a follow-up task; this file only declares the interface.
export interface ApprovalRequest {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly reason: string;
}

export interface ApprovalResponse {
  readonly decision: "allow" | "deny";
  readonly reason?: string | undefined;
}

export interface ApprovalPrompt {
  request(request: ApprovalRequest): Promise<ApprovalResponse>;
}

export { PermissionGate } from "./PermissionGate.js";
