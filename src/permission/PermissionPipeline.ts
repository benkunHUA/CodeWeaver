import type { PermissionGate } from "./PermissionGate.js";
import type { GateContext, GateOutcome, PermissionDecision, PermissionRequest } from "./types.js";

/**
 * Runs gates in order until one decides.
 *
 * A gate that answers "ask" does not end the run: the pending approval is
 * forwarded to the remaining gates through GateContext.ask (that is how the
 * approval gate recognizes a request that needs confirmation). A request that
 * is still pending when the chain ends is denied, never silently allowed: a
 * gate list without an approval gate must not turn an "ask" into an "allow".
 * Only a request that never raised an ask falls through as allowed by default.
 *
 * Any gate failure is fail-closed: the request is denied with the failing gate
 * name, never allowed.
 */
export class PermissionPipeline {
  private readonly gates: readonly PermissionGate[];

  constructor(gates: readonly PermissionGate[]) {
    this.gates = [...gates];
  }

  listGates(): readonly string[] {
    return this.gates.map((gate) => gate.name);
  }

  async check(request: PermissionRequest): Promise<PermissionDecision> {
    let ask: GateContext["ask"];
    for (const gate of this.gates) {
      const context: GateContext = ask === undefined ? { request } : { request, ask };
      let outcome: GateOutcome | undefined;
      try {
        outcome = await gate.evaluate(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { allowed: false, reason: `权限检查出错：${message}`, gate: gate.name };
      }
      if (outcome === undefined) continue;
      if (outcome.kind === "decide") return outcome.decision;
      ask = { reason: outcome.reason, gate: outcome.gate };
    }
    // Fail closed: an ask that no gate resolved must never become an allow.
    if (ask !== undefined) {
      return { allowed: false, reason: "权限请求未决", gate: "pipeline" };
    }
    return { allowed: true, reason: "", gate: "default" };
  }
}
