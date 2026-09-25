import type { LoadSkillInput } from "../skills/types.js";
import { Tool } from "./core/Tool.js";
import type { ToolContext } from "./core/ToolContext.js";
import type { JsonSchemaObject } from "./core/validate.js";

/**
 * Reads one skill's full SKILL.md text through the library port exposed by the
 * context. The concrete loader is never imported here, so the tool stays a pure
 * port user; it also never writes to the terminal.
 */
export class LoadSkillTool extends Tool<LoadSkillInput> {
  readonly name = "load_skill";
  readonly description = "按名称读取某个技能的完整说明（SKILL.md）。";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };

  protected async run(input: LoadSkillInput, context: ToolContext): Promise<string> {
    const skills = context.skills;
    // Fail closed: without a library the tool must not pretend a skill was loaded.
    if (skills === undefined) throw new Error("Skill loading is not available in this context");
    return skills.load(input.name);
  }
}
