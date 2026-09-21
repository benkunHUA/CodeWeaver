import type { Tool } from "./core/Tool.js";
import { BashTool } from "./BashTool.js";
import { EditFileTool } from "./EditFileTool.js";
import { GlobTool } from "./GlobTool.js";
import { ReadFileTool } from "./ReadFileTool.js";
import { TodoWriteTool } from "./TodoWriteTool.js";
import { WriteFileTool } from "./WriteFileTool.js";

export interface CreateDefaultToolsOptions {
  /** Replacement tool instances keyed by `name`; unknown names are appended. */
  readonly overrides?: readonly Tool<unknown>[] | undefined;
}

/** The six built-in tools in the same order the previous schema list used. */
export function createDefaultTools(options: CreateDefaultToolsOptions = {}): Tool<unknown>[] {
  const defaults: Tool<unknown>[] = [
    new BashTool(),
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new GlobTool(),
    new TodoWriteTool(),
  ];
  const overrides = options.overrides ?? [];
  const tools = defaults.map(
    (tool) => overrides.find((override) => override.name === tool.name) ?? tool,
  );
  const names = new Set(tools.map((tool) => tool.name));
  for (const override of overrides) {
    if (names.has(override.name)) continue;
    tools.push(override);
    names.add(override.name);
  }
  return tools;
}
