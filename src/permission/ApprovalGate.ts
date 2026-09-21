import { PermissionGate } from "./PermissionGate.js";
import type { ApprovalPrompt, ApprovalResponse, GateContext, GateOutcome } from "./types.js";

const DENIED_BY_USER = "用户拒绝";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Gate 3: turns a pending `ask` into a decision by consulting the user.
 *
 * The gate only acts when an earlier gate raised `context.ask`; otherwise it
 * abstains. It is meant to be the last gate in the chain, so a request that
 * needs confirmation always stops here instead of falling through as allowed.
 */
export class ApprovalGate extends PermissionGate {
  readonly name = "approval";
  private readonly prompt: ApprovalPrompt;

  constructor(prompt: ApprovalPrompt) {
    super();
    this.prompt = prompt;
  }

  async evaluate(context: GateContext): Promise<GateOutcome | undefined> {
    const { ask, request } = context;
    if (ask === undefined) return undefined;

    let response: ApprovalResponse;
    try {
      response = await this.prompt.request({
        toolName: request.toolName,
        input: request.input,
        reason: ask.reason,
      });
    } catch (error) {
      // Fail closed: a broken prompt must never let the tool run.
      return {
        kind: "decide",
        decision: {
          allowed: false,
          reason: `权限检查出错：${errorMessage(error)}`,
          gate: this.name,
        },
      };
    }

    if (response.decision === "allow") {
      return { kind: "decide", decision: { allowed: true, reason: "", gate: this.name } };
    }
    return {
      kind: "decide",
      decision: {
        allowed: false,
        reason: response.reason ?? DENIED_BY_USER,
        gate: this.name,
      },
    };
  }
}
