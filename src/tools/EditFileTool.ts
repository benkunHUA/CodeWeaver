import { readFile } from "node:fs/promises";
import type { EditFileInput } from "../types.js";
import { atomicWrite } from "./core/atomicWrite.js";
import { Tool } from "./core/Tool.js";
import type { ToolContext } from "./core/ToolContext.js";
import type { JsonSchemaObject } from "./core/validate.js";

export class EditFileTool extends Tool<EditFileInput> {
  readonly name = "edit_file";
  readonly description = "精确替换文件中的一段文本，仅替换第一处匹配。";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: {
      path: { type: "string" },
      old_text: { type: "string" },
      new_text: { type: "string" },
    },
    required: ["path", "old_text", "new_text"],
  };

  protected async run(input: EditFileInput, context: ToolContext): Promise<string> {
    return context.locks.withFileLock(context.workspace, input.path, async (resolved) => {
      const checked = await context.workspace.safePath(input.path);
      if (checked !== resolved) throw new Error(`Path changed during edit: ${input.path}`);
      const current = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(resolved));
      if (!current.includes(input.old_text)) {
        return `Error: text not found in ${input.path}`;
      }
      // A replacer function keeps `$&`, `$1`, ... in new_text literal.
      const next = current.replace(input.old_text, () => input.new_text);
      await atomicWrite(resolved, next);
      return `Edited ${input.path}`;
    });
  }
}
