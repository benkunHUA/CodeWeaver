import type { Tool } from "./core/Tool.js";
import { BashTool } from "./BashTool.js";
import { CompactTool } from "./CompactTool.js";
import { EditFileTool } from "./EditFileTool.js";
import { GlobTool } from "./GlobTool.js";
import { LoadSkillTool } from "./LoadSkillTool.js";
import { ReadFileTool } from "./ReadFileTool.js";
import { TodoWriteTool } from "./TodoWriteTool.js";
import { WriteFileTool } from "./WriteFileTool.js";

export interface CreateDefaultToolsOptions {
  /** Replacement tool instances keyed by `name`; unknown names are appended. */
  readonly overrides?: readonly Tool<unknown>[] | undefined;
}

/**
 * The eight built-in tools in the same order the previous schema list used.
 * `compact` is last so adding it never shifts the schemas the earlier lessons
 * pin verbatim.
 */
export function createDefaultTools(options: CreateDefaultToolsOptions = {}): Tool<unknown>[] {
  const defaults: Tool<unknown>[] = [
    new BashTool(),
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new GlobTool(),
    new TodoWriteTool(),
    new LoadSkillTool(),
    new CompactTool(),
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
