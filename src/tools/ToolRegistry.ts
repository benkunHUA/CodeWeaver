import type { AnthropicTool, ToolHooks } from "../types.js";
import type { Tool } from "./core/Tool.js";
import type { ToolContext } from "./core/ToolContext.js";

export interface ToolRegistryOptions {
  /** Shared dependency object handed to every tool invocation. */
  readonly context: ToolContext;
  readonly hooks?: ToolHooks | undefined;
  readonly logger?: ((message: string) => void) | undefined;
}

function formatHookError(name: string, phase: "before" | "after", error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `hook error: ${name} ${phase} failed: ${message}`;
}

/**
 * Class-based tool dispatcher: it owns the tool instances plus the dispatch
 * guarantees (hook observation, error normalization) around every invocation.
 */
export class ToolRegistry {
  readonly #context: ToolContext;
  readonly #hooks: ToolHooks;
  readonly #logger: ((message: string) => void) | undefined;
  readonly #tools = new Map<string, Tool<unknown>>();
  /** Detached registration-order snapshots of every accepted schema. */
  readonly #schemas: AnthropicTool[] = [];

  constructor(options: ToolRegistryOptions) {
    this.#context = options.context;
    // Snapshot so a caller replacing fields afterwards cannot change behavior.
    this.#hooks = { ...options.hooks };
    this.#logger = options.logger;
  }

  /** Register a tool. Duplicate names or a schema name mismatch throw. */
  register(tool: Tool<unknown>): this {
    const name = tool.name;
    if (this.#tools.has(name)) {
      throw new Error(`Duplicate tool name: ${name}`);
    }
    const schema = tool.toAnthropicSchema();
    if (schema.name !== name) {
      throw new Error(`Tool schema name mismatch: ${name}`);
    }
    this.#tools.set(name, tool);
    this.#schemas.push(structuredClone(schema));
    return this;
  }

  /** Anthropic tool schemas in registration order; callers get a snapshot. */
  schemas(): AnthropicTool[] {
    return this.#schemas.map((schema) => structuredClone(schema));
  }

  list(): readonly Tool<unknown>[] {
    return [...this.#tools.values()];
  }

  /** Dependency object every registered tool is executed with. */
  get context(): ToolContext {
    return this.#context;
  }

  get(name: string): Tool<unknown> | undefined {
    return this.#tools.get(name);
  }

  async invoke(name: string, input: unknown): Promise<string> {
    const tool = this.#tools.get(name);
    await this.#runBefore(name, input);
    const started = performance.now();
    let result: string;
    try {
      if (!tool) {
        result = `Unknown: ${name}`;
        this.#log(result);
      } else {
        // Validation, error strings, placeholders and truncation already
        // happen inside the `Tool.execute` template.
        result = await tool.execute(input, this.#context);
      }
    } catch (error) {
      result = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    const durationMs = Math.max(0, performance.now() - started);
    await this.#runAfter(name, input, result, durationMs);
    return result;
  }

  /** Diagnostics must never interrupt dispatch, even if the sink throws. */
  #log(message: string): void {
    try {
      this.#logger?.(message);
    } catch {
      // Swallowed on purpose.
    }
  }

  async #runBefore(name: string, input: unknown): Promise<void> {
    const before = this.#hooks.before;
    if (!before) return;
    try {
      await before({ name, input: structuredClone(input) });
    } catch (error) {
      this.#log(formatHookError(name, "before", error));
    }
  }

  async #runAfter(name: string, input: unknown, result: string, durationMs: number): Promise<void> {
    const after = this.#hooks.after;
    if (!after) return;
    try {
      await after({ name, input: structuredClone(input), result, durationMs });
    } catch (error) {
      this.#log(formatHookError(name, "after", error));
    }
  }
}
