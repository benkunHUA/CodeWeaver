import type { TaskInput } from "../subagent/types.js";
import { Tool } from "./core/Tool.js";
import type { ToolContext } from "./core/ToolContext.js";
import type { JsonSchemaObject } from "./core/validate.js";

/**
 * Entry point of subagent delegation: it forwards the prompt to the launcher
 * exposed by the context and returns only the subagent's final text. The
 * concrete runner is never imported here, so the tool stays a pure port user.
 */
export class TaskTool extends Tool<TaskInput> {
  readonly name = "task";
  readonly description = "把边界清晰的子任务委派给拥有全新上下文的子智能体，只返回其最终结论。";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { prompt: { type: "string", minLength: 1 } },
    required: ["prompt"],
  };

  protected async run(input: TaskInput, context: ToolContext): Promise<string> {
    const launcher = context.subagents;
    // Fail closed: a tool registered in a context without delegation must not
    // pretend to have run a subagent.
    if (launcher === undefined) throw new Error("Subagent delegation is not available in this context");
    return launcher.run(input.prompt);
  }
}
