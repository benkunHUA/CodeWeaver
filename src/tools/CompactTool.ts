import { COMPACT_REQUEST_RESULT, COMPACT_TOOL_NAME } from "../compaction/types.js";
import { Tool } from "./core/Tool.js";
import type { ToolContext } from "./core/ToolContext.js";
import type { JsonSchemaObject } from "./core/validate.js";

/**
 * Requests context compaction and nothing else: it returns a fixed marker so the
 * agent loop can compact once the current tool batch closes. The strategy lives
 * behind the compaction port, never here, and the tool prints nothing.
 */
export class CompactTool extends Tool<Record<string, never>> {
  readonly name = COMPACT_TOOL_NAME;
  readonly description = "把较早的对话总结成摘要，释放上下文空间。";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: {},
  };

  protected async run(_input: Record<string, never>, _context: ToolContext): Promise<string> {
    return COMPACT_REQUEST_RESULT;
  }
}
