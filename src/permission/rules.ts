import { isAbsolute, relative, resolve } from "node:path";
import type { PermissionAction, PermissionRequest, PermissionRule } from "./types.js";

// s03 writes this as `(?i)(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])`.
// JavaScript has no inline `(?i)` flag, so case-insensitivity comes from the
// `i` flag here. The pattern deliberately ignores `rm` in the middle of a word
// (e.g. "model"), so only the substring list below is broad.
const DESTRUCTIVE_COMMAND_WORD = /(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])/i;

const DESTRUCTIVE_SUBSTRINGS: readonly string[] = ["rm ", "> /etc/", "chmod 777"];

export function containsDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_COMMAND_WORD.test(command);
}

/**
 * Rule: file tools may only touch paths inside the workspace.
 *
 * The check is pure string arithmetic (resolve/relative) on purpose: the path
 * may not exist yet, so it must not hit the disk (no realpath, no stat) and
 * must not throw.
 *
 * Escaping the workspace yields "deny" rather than "ask": this is a hard
 * boundary that user approval must not be able to relax.
 */
export class WorkspaceBoundaryRule implements PermissionRule {
  readonly name = "workspace-boundary";
  readonly tools: readonly string[] = ["read_file", "write_file", "edit_file"];
  readonly message = "Access outside workspace";

  evaluate(request: PermissionRequest): PermissionAction | undefined {
    const userPath = request.input.path;
    if (typeof userPath !== "string") return undefined;
    const root = resolve(request.workspaceRoot);
    const resolved = resolve(root, userPath);
    const escaped = relative(root, resolved);
    if (escaped.startsWith("..") || isAbsolute(escaped)) return "deny";
    return undefined;
  }
}

/**
 * Rule: shell commands that look destructive need explicit approval.
 */
export class DestructiveCommandRule implements PermissionRule {
  readonly name = "destructive-command";
  readonly tools: readonly string[] = ["bash"];
  readonly message = "Potentially destructive command";

  evaluate(request: PermissionRequest): PermissionAction | undefined {
    const raw = request.input.command;
    const command = typeof raw === "string" ? raw : "";
    const destructive = containsDestructiveCommand(command)
      || DESTRUCTIVE_SUBSTRINGS.some((keyword) => command.includes(keyword));
    return destructive ? "ask" : undefined;
  }
}

export const defaultPermissionRules: readonly PermissionRule[] = [
  new WorkspaceBoundaryRule(),
  new DestructiveCommandRule(),
];
