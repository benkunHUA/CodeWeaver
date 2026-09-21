import { TODO_STATUSES } from "../planning/index.js";
import type { TodoWriteInput } from "../planning/index.js";
import { Tool } from "./core/Tool.js";
import type { ToolContext } from "./core/ToolContext.js";
import type { JsonSchemaObject } from "./core/validate.js";

/**
 * Writes the session todo list. All state lives in `context.todos`, so the same
 * tool instance may be shared by registries without sharing state.
 * A successful call produces no terminal output: rendering is a hook's job.
 */
export class TodoWriteTool extends Tool<TodoWriteInput> {
  readonly name = "todo_write";
  readonly description = "创建并管理当前编码会话的任务列表。";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: {
      todos: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1 },
            status: { type: "string", enum: [...TODO_STATUSES] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  };

  protected async run(input: TodoWriteInput, context: ToolContext): Promise<string> {
    return context.todos.update(input.todos);
  }
}
