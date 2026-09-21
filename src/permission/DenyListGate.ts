import { PermissionGate } from "./PermissionGate.js";
import type { GateContext, GateOutcome } from "./types.js";

/** Same list, same order as the s03 lesson. */
export const DEFAULT_DENY_LIST: readonly string[] = [
  "rm -rf /",
  "sudo",
  "shutdown",
  "reboot",
  "mkfs",
  "dd if=",
  "> /dev/sda",
];

/**
 * Gate 1: a hard deny list for catastrophic shell commands.
 *
 * This is a guard, not a security boundary: matching is a plain, case-sensitive
 * substring test over the raw `bash` command, so quoting, aliases or any other
 * indirection walks straight past it. Never treat a pass here as proof that a
 * command is safe.
 */
export class DenyListGate extends PermissionGate {
  readonly name = "deny-list";
  private readonly patterns: readonly string[];

  constructor(patterns: readonly string[] = DEFAULT_DENY_LIST) {
    super();
    this.patterns = [...patterns];
  }

  async evaluate(context: GateContext): Promise<GateOutcome | undefined> {
    const { request } = context;
    if (request.toolName !== "bash") return undefined;
    const command = typeof request.input.command === "string" ? request.input.command : "";
    const pattern = this.patterns.find((candidate) => command.includes(candidate));
    if (pattern === undefined) return undefined;
    return {
      kind: "decide",
      decision: {
        allowed: false,
        reason: `已被拒绝：'${pattern}' 在拒绝列表中`,
        gate: this.name,
      },
    };
  }
}
