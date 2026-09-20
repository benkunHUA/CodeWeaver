import { PermissionPipeline } from "./PermissionPipeline.js";
import type { PermissionGate } from "./PermissionGate.js";
import { ApprovalGate } from "./ApprovalGate.js";
import { DenyListGate } from "./DenyListGate.js";
import { RuleGate } from "./RuleGate.js";
import { defaultPermissionRules } from "./rules.js";
import type { ApprovalPrompt } from "./types.js";

export type {
  ApprovalPrompt,
  ApprovalRequest,
  ApprovalResponse,
  GateContext,
  GateOutcome,
  PermissionAction,
  PermissionDecision,
  PermissionRequest,
  PermissionRule,
} from "./types.js";
export { PermissionGate } from "./PermissionGate.js";
export { DEFAULT_DENY_LIST, DenyListGate } from "./DenyListGate.js";
export { RuleGate } from "./RuleGate.js";
export {
  DestructiveCommandRule,
  WorkspaceBoundaryRule,
  containsDestructiveCommand,
  defaultPermissionRules,
} from "./rules.js";
export { PermissionPipeline } from "./PermissionPipeline.js";
export { ApprovalGate } from "./ApprovalGate.js";
export {
  APPROVAL_QUESTION,
  NO_INTERACTIVE_TERMINAL,
  ConsoleApprovalPrompt,
  DenyAllApprovalPrompt,
} from "./ApprovalPrompt.js";
export type { ConsoleApprovalPromptOptions } from "./ApprovalPrompt.js";

export function createPermissionPipeline(gates: readonly PermissionGate[]): PermissionPipeline {
  return new PermissionPipeline(gates);
}

export interface DefaultPermissionOptions {
  readonly workspaceRoot: string;
  readonly approval: ApprovalPrompt;
  readonly logger?: ((message: string) => void) | undefined;
  /** Overrides the default gate chain, e.g. to isolate a gate in a test. */
  readonly gates?: readonly PermissionGate[] | undefined;
}

/**
 * Production wiring: deny list, then rules, then user approval.
 *
 * ApprovalGate comes last on purpose: any earlier `ask` must be resolved by the
 * user instead of falling through to the pipeline's default allow.
 */
export function createDefaultPermissionPipeline(
  options: DefaultPermissionOptions,
): PermissionPipeline {
  const gates = options.gates ?? [
    new DenyListGate(),
    new RuleGate(defaultPermissionRules),
    new ApprovalGate(options.approval),
  ];
  return new PermissionPipeline(gates);
}

