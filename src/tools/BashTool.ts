import { COMMAND_TIMEOUT_MS, runBash } from "../bash.js";
import type { BashInput } from "../types.js";
import { Tool } from "./core/Tool.js";
import type { ToolContext } from "./core/ToolContext.js";
import type { JsonSchemaObject } from "./core/validate.js";

export class BashTool extends Tool<BashInput> {
  readonly name = "bash";
  readonly description = "执行 shell 命令。";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  };

  protected async run(input: BashInput, context: ToolContext): Promise<string> {
    return runBash(input.command, { cwd: context.workspace.root, timeoutMs: COMMAND_TIMEOUT_MS });
  }
}
