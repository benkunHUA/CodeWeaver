import { COMMAND_TIMEOUT_MS, runBash } from "../bash.js";
import type { BashInput, Workspace } from "../types.js";

export const BASH_TOOL_NAME = "bash" as const;

export function parseBashInput(input: unknown): BashInput | { readonly error: string } {
  if (
    typeof input !== "object" ||
    input === null ||
    !("command" in input) ||
    typeof input.command !== "string"
  ) {
    return { error: "Invalid input for bash: command must be a string" };
  }
  return { command: input.command };
}

export async function bashTool(workspace: Workspace, input: BashInput): Promise<string> {
  return runBash(input.command, { cwd: workspace.root, timeoutMs: COMMAND_TIMEOUT_MS });
}
