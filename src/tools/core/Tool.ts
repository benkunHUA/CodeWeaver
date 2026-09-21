import type { AnthropicTool } from "../../types.js";
import { OUTPUT_LIMIT, sliceCharacters } from "../../bash.js";
import type { JsonSchemaObject } from "./validate.js";
import { validateObjectSchema } from "./validate.js";
import type { ToolContext } from "./ToolContext.js";

/**
 * Template-method base class for every tool: validation, error normalization,
 * empty-result placeholder and output truncation live here exactly once, so
 * subclasses only implement `run`.
 *
 * A tool owns its schema: `execute` validates every call against this instance's
 * own `inputSchema`, never against a definition handed in by a caller. That is
 * the deliberate difference to the previous shape, where the caller passed the
 * definition and registration took a `structuredClone` snapshot for validation.
 * `ToolRegistry` still snapshots `toAnthropicSchema()`, but only its
 * outward-facing view for the model API.
 */
export abstract class Tool<TInput> {
  abstract readonly name: string;
  abstract readonly description: string;
  /** Owned by the tool; every `execute` call is validated against this schema. */
  abstract readonly inputSchema: JsonSchemaObject;
  /** Result text used when the tool produced an empty string. */
  protected readonly emptyPlaceholder: string = "(no output)";

  /** Fresh, detached schema for the model API; callers may mutate the result. */
  toAnthropicSchema(): AnthropicTool {
    return {
      name: this.name,
      description: this.description,
      input_schema: structuredClone(this.inputSchema) as AnthropicTool["input_schema"],
    };
  }

  /** Fixed dispatch order; subclasses must not override this method. */
  async execute(rawInput: unknown, context: ToolContext): Promise<string> {
    const errors = validateObjectSchema(this.name, rawInput, this.inputSchema);
    let result: string;
    if (errors.length > 0) {
      result = `Error: Invalid input for ${this.name}: ${errors.join("; ")}`;
    } else {
      try {
        const value: unknown = await this.run(rawInput as TInput, context);
        if (typeof value !== "string") {
          throw new Error(`Invalid result from ${this.name}: expected string`);
        }
        result = value;
      } catch (error) {
        result = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return sliceCharacters(result || this.emptyPlaceholder, OUTPUT_LIMIT);
  }

  protected abstract run(input: TInput, context: ToolContext): Promise<string>;
}
