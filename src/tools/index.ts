import type {
  AnthropicTool,
  ToolDefinition,
  ToolHandler,
  ToolHooks,
  ToolRegistry,
  ToolRegistryLogger,
  Workspace,
} from "../types.js";
import { COMMAND_TIMEOUT_MS, runBash } from "../bash.js";
import { createWorkspace } from "../workspace.js";
import { createToolRegistry } from "./registry.js";
import { editFileTool, readFileTool, writeFileTool } from "./fileTools.js";
import { globTool } from "./globTool.js";

export interface DefaultRegistryOptions {
  readonly root?: string;
  readonly hooks?: ToolHooks;
  readonly logger?: ToolRegistryLogger;
  readonly overrides?: readonly {
    readonly name: ToolDefinition["name"];
    readonly handler?: ToolHandler;
  }[];
}

const TOOL_SCHEMAS: readonly AnthropicTool[] = [
  {
    name: "bash",
    description: "执行 shell 命令。",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "读取文件内容。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "将内容写入文件。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "精确替换文件中的一段文本，仅替换第一处匹配。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "glob",
    description: "按 glob 模式查找文件；** 表示递归匹配。",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
];

export const defaultToolSchemas: AnthropicTool[] = structuredClone(TOOL_SCHEMAS) as AnthropicTool[];

export async function createDefaultRegistry(options: DefaultRegistryOptions = {}): Promise<ToolRegistry> {
  const workspace: Workspace = await createWorkspace(options.root ?? process.cwd());
  const overrides = new Map(
    (options.overrides ?? []).map((item) => [item.name, item] as const),
  );
  const definitions: ToolDefinition[] = [
    {
      name: "bash",
      schema: TOOL_SCHEMAS[0] as AnthropicTool,
      handler: async (input) => runBash(input.command, { cwd: workspace.root, timeoutMs: COMMAND_TIMEOUT_MS }),
    },
    {
      name: "read_file",
      schema: TOOL_SCHEMAS[1] as AnthropicTool,
      handler: async (input) => readFileTool(workspace, input),
    },
    {
      name: "write_file",
      schema: TOOL_SCHEMAS[2] as AnthropicTool,
      handler: async (input) => writeFileTool(workspace, input),
    },
    {
      name: "edit_file",
      schema: TOOL_SCHEMAS[3] as AnthropicTool,
      handler: async (input) => editFileTool(workspace, input),
    },
    {
      name: "glob",
      schema: TOOL_SCHEMAS[4] as AnthropicTool,
      handler: async (input) => globTool(workspace, input),
    },
  ];
  for (const [name, override] of overrides) {
    if (!override.handler) continue;
    const index = definitions.findIndex((definition) => definition.name === name);
    if (index !== -1) {
      definitions[index] = { ...definitions[index], handler: override.handler } as ToolDefinition;
    }
  }
  return createToolRegistry(definitions, options);
}
