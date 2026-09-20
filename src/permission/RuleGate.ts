import { PermissionGate } from "./PermissionGate.js";
import { defaultPermissionRules } from "./rules.js";
import type { GateContext, GateOutcome, PermissionRule } from "./types.js";

/**
 * Gate 2: first matching rule wins, in registration order.
 */
export class RuleGate extends PermissionGate {
  readonly name = "rules";
  private readonly rules: readonly PermissionRule[];

  constructor(rules: readonly PermissionRule[] = defaultPermissionRules) {
    super();
    this.rules = [...rules];
  }

  async evaluate(context: GateContext): Promise<GateOutcome | undefined> {
    const { request } = context;
    for (const rule of this.rules) {
      if (!rule.tools.includes(request.toolName)) continue;
      const action = rule.evaluate(request);
      if (action === undefined) continue;
      if (action === "deny") {
        return {
          kind: "decide",
          decision: { allowed: false, reason: rule.message, gate: this.name },
        };
      }
      if (action === "allow") {
        return {
          kind: "decide",
          decision: { allowed: true, reason: "", gate: this.name },
        };
      }
      return { kind: "ask", reason: rule.message, gate: this.name };
    }
    return undefined;
  }
}
