import type {
  ContentBlock,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { HookBus } from "../hooks/HookBus.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ModelClient } from "../types.js";
import type { Session } from "./Session.js";
import type { ToolPresenter } from "./ToolPresenter.js";
import { ConsoleToolPresenter } from "./ToolPresenter.js";

export interface AgentLoopOptions {
  readonly client: ModelClient;
  readonly model: string;
  readonly system: string;
  readonly registry: ToolRegistry;
  readonly workspaceRoot: string;
  readonly hooks?: HookBus | undefined;
  readonly presenter?: ToolPresenter | undefined;
  readonly maxTokens?: number | undefined;
}

const DEFAULT_MAX_TOKENS = 8000;

/**
 * The agentic turn loop: request, append, dispatch tool calls serially, then
 * feed the results back. Hook triggering stays in this class because a hook's
 * return value changes control flow (PreToolUse blocks, Stop continues).
 */
export class AgentLoop {
  readonly #client: ModelClient;
  readonly #model: string;
  readonly #system: string;
  readonly #registry: ToolRegistry;
  readonly #workspaceRoot: string;
  readonly #hooks: HookBus | undefined;
  readonly #presenter: ToolPresenter;
  readonly #maxTokens: number;

  constructor(options: AgentLoopOptions) {
    this.#client = options.client;
    this.#model = options.model;
    this.#system = options.system;
    this.#registry = options.registry;
    this.#workspaceRoot = options.workspaceRoot;
    this.#hooks = options.hooks;
    this.#presenter = options.presenter ?? new ConsoleToolPresenter();
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async run(session: Session): Promise<void> {
    while (true) {
      const response = await this.#client.messages.create({
        model: this.#model,
        system: this.#system,
        messages: session.messages,
        tools: this.#registry.schemas(),
        max_tokens: this.#maxTokens,
      });

      session.appendAssistant(response.content as ContentBlock[]);
      const toolCalls = response.content.filter(
        (block): block is ToolUseBlock => block.type === "tool_use",
      );
      if (toolCalls.length === 0) {
        // A Stop handler may veto the exit by returning a follow-up user message.
        const forced = await this.#hooks?.trigger("Stop", {
          messages: session.messages,
          workspaceRoot: this.#workspaceRoot,
        });
        if (typeof forced === "string") {
          session.injectUser(forced);
          continue;
        }
        return;
      }

      const results: ToolResultBlockParam[] = [];
      for (const block of toolCalls) {
        const blocked = await this.#hooks?.trigger("PreToolUse", {
          toolName: block.name,
          input: block.input,
          workspaceRoot: this.#workspaceRoot,
        });
        if (blocked !== undefined) {
          this.#presenter.showResult(blocked);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: blocked,
          });
          continue;
        }
        this.#presenter.showToolCall(block.name, block.input);
        const output = await this.#registry.invoke(block.name, block.input);
        await this.#hooks?.trigger("PostToolUse", {
          toolName: block.name,
          input: block.input,
          result: output,
          workspaceRoot: this.#workspaceRoot,
        });
        this.#presenter.showResult(output);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
      session.appendToolResults(results);
    }
  }
}
