import type {
  AnthropicTool,
  RegisteredToolDefinition,
  ToolHandler,
  ToolHandlerResult,
  ToolHooks,
  ToolRegistry,
  ToolRegistryLogger,
} from "../types.js";
import { OUTPUT_LIMIT, sliceCharacters } from "../bash.js";
import type { JsonSchemaObject } from "./validate.js";
import { validateObjectSchema } from "./validate.js";

interface CreateToolRegistryOptions {
  readonly hooks?: ToolHooks;
  readonly logger?: ToolRegistryLogger;
}

function getObjectSchema(schema: RegisteredToolDefinition["schema"]["input_schema"]): JsonSchemaObject {
  if (schema?.type !== "object") {
    return { type: "object", properties: {}, required: [] };
  }
  return schema as JsonSchemaObject;
}

function formatHookError(name: string, phase: "before" | "after", error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `hook error: ${name} ${phase} failed: ${message}`;
}

export function createToolRegistry(
  definitions: readonly RegisteredToolDefinition[],
  options: CreateToolRegistryOptions = {},
): ToolRegistry {
  const byName = new Map<string, RegisteredToolDefinition>();
  const schemas: AnthropicTool[] = [];
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw new Error(`Duplicate tool name: ${definition.name}`);
    }
    if (definition.schema.name !== definition.name) {
      throw new Error(`Tool schema name mismatch: ${definition.name}`);
    }
    const snapshot = { ...definition, schema: structuredClone(definition.schema) };
    byName.set(definition.name, snapshot);
    schemas.push(snapshot.schema);
  }
  const logger: ToolRegistryLogger = (message) => {
    try { options.logger?.(message); } catch { /* Diagnostics must not interrupt dispatch. */ }
  };
  const hooks: ToolHooks = { ...options.hooks };

  async function runBefore(name: string, input: unknown): Promise<void> {
    if (!hooks.before) return;
    try {
      await hooks.before({ name, input: structuredClone(input) });
    } catch (error) {
      logger(formatHookError(name, "before", error));
    }
  }

  async function runAfter(name: string, input: unknown, result: string, durationMs: number): Promise<void> {
    if (!hooks.after) return;
    try {
      await hooks.after({ name, input: structuredClone(input), result, durationMs });
    } catch (error) {
      logger(formatHookError(name, "after", error));
    }
  }

  async function invoke(name: string, input: unknown): Promise<ToolHandlerResult> {
    const definition = byName.get(name);
    await runBefore(name, input);
    const started = performance.now();
    let result: string;
    try {
      if (!definition) {
        result = `Unknown: ${name}`;
        logger(result);
      } else {
        const objectSchema = getObjectSchema(definition.schema.input_schema);
        const validationErrors = validateObjectSchema(name, input, objectSchema);
        if (validationErrors.length > 0) {
          result = `Error: Invalid input for ${name}: ${validationErrors.join("; ")}`;
        } else {
          result = await definition.handler(input as never);
          if (typeof result !== "string") throw new Error(`Invalid result from ${name}: expected string`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = `Error: ${message}`;
    }
    result = sliceCharacters(result || "(no output)", OUTPUT_LIMIT);
    const durationMs = Math.max(0, performance.now() - started);
    await runAfter(name, input, result, durationMs);
    return result;
  }

  return {
    listTools(): readonly RegisteredToolDefinition[] {
      return [...byName.values()].map((definition) => ({
        ...definition, schema: structuredClone(definition.schema),
        handler: (input: unknown) => invoke(definition.name, input),
      }));
    },
    getSchemas(): readonly AnthropicTool[] {
      return structuredClone(schemas);
    },
    getHandler(name: string): ToolHandler | undefined {
      return byName.has(name) ? (input) => invoke(name, input) : undefined;
    },
    invoke,
  };
}
