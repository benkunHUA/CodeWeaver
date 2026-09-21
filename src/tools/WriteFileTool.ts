import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { WriteFileInput } from "../types.js";
import { atomicWrite } from "./core/atomicWrite.js";
import { Tool } from "./core/Tool.js";
import type { ToolContext } from "./core/ToolContext.js";
import type { JsonSchemaObject } from "./core/validate.js";

export class WriteFileTool extends Tool<WriteFileInput> {
  readonly name = "write_file";
  readonly description = "将内容写入文件。";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  };

  protected async run(input: WriteFileInput, context: ToolContext): Promise<string> {
    await context.locks.withFileLock(context.workspace, input.path, async (resolved) => {
      await mkdir(dirname(resolved), { recursive: true });
      const checked = await context.workspace.safePath(input.path);
      if (checked !== resolved) throw new Error(`Path changed during write: ${input.path}`);
      await atomicWrite(checked, input.content);
    });
    const bytes = new TextEncoder().encode(input.content).byteLength;
    return `Wrote ${bytes} bytes to ${input.path}`;
  }
}
