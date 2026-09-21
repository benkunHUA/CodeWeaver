import { readFile } from "node:fs/promises";
import type { ReadFileInput } from "../types.js";
import { Tool } from "./core/Tool.js";
import type { ToolContext } from "./core/ToolContext.js";
import type { JsonSchemaObject } from "./core/validate.js";

export class ReadFileTool extends Tool<ReadFileInput> {
  readonly name = "read_file";
  readonly description = "读取文件内容。";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { path: { type: "string" }, limit: { type: "integer" } },
    required: ["path"],
  };

  protected async run(input: ReadFileInput, context: ToolContext): Promise<string> {
    const resolved = await context.workspace.safePath(input.path);
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(resolved));
    const lines = raw.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u);
    if (lines.at(-1) === "") lines.pop();
    const limit = Number.isInteger(input.limit) ? (input.limit as number) : undefined;
    let outputLines = lines;
    if (limit !== undefined && limit > 0 && limit < lines.length) {
      outputLines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    }
    // An empty result becomes the base-class placeholder.
    return outputLines.join("\n");
  }
}
