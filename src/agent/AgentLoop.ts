import type {
  ContentBlock,
  ContentBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { CompactionPort } from "../compaction/index.js";
import { MAX_REACTIVE_RETRIES } from "../compaction/index.js";
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
  /** Cap on model requests a single run() may issue; omitted means no cap. */
  readonly maxTurns?: number | undefined;
  readonly reminder?: ToolRoundReminder | undefined;
  /**
   * Optional compaction port. When omitted, the loop behaves exactly as before:
   * the conversation is sent as-is and an oversized-prompt rejection escapes.
   */
  readonly compaction?: CompactionPort | undefined;
}

/**
 * Why run() returned: the model stopped calling tools and no Stop handler
 * forced a continue ("finished"), or the maxTurns cap was reached ("turn-limit").
 */
export type AgentLoopOutcome = "finished" | "turn-limit";

/** Per-round reminder schedule; the loop owns no tool-specific knowledge. */
export interface ToolRoundReminder {
  /** Called once at the start of every run() so state cannot leak across questions. */
  beginRun(): void;
  /** Called after a round of executed tools; returns the text to append, if any. */
  afterToolRound(toolNames: readonly string[]): string | undefined;
}

const DEFAULT_MAX_TOKENS = 8000;

/**
 * The agentic turn loop: request, append, dispatch tool calls serially, then
 * feed the results back. Hook triggering stays in this class because a hook's
 * return value changes control flow (PreToolUse blocks, Stop continues).
 *
 * Reminder scheduling is a port: the loop only decides *when* to ask and where
 * to append the injected text, while the injected strategy lives outside.
 *
 * `maxTurns` caps the number of model requests one run() may issue; once the cap
 * is reached the loop returns "turn-limit" before asking the model again.
 * Without it the loop keeps iterating until it returns "finished".
 *
 * Compaction is an optional port: `prepare` runs before every request and may
 * rewrite the history, `afterBatch` runs once a tool batch has closed (so no
 * orphan tool_result is left behind), and a request rejected for an oversized
 * prompt is answered by one `reactive` rewrite plus a single retry per run().
 * Which tools request compaction is the port's decision, never the loop's.
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
  readonly #reminder: ToolRoundReminder | undefined;
  readonly #maxTurns: number | undefined;
  readonly #compaction: CompactionPort | undefined;

  constructor(options: AgentLoopOptions) {
    this.#client = options.client;
    this.#model = options.model;
    this.#system = options.system;
    this.#registry = options.registry;
    this.#workspaceRoot = options.workspaceRoot;
    this.#hooks = options.hooks;
    this.#presenter = options.presenter ?? new ConsoleToolPresenter();
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#reminder = options.reminder;
    this.#maxTurns = options.maxTurns;
    this.#compaction = options.compaction;
  }

  async run(session: Session): Promise<AgentLoopOutcome> {
    this.#reminder?.beginRun();
    // Reactive retries are scoped to one run(); a fresh run() starts over.
    let reactiveRetries = 0;
    for (let turn = 0; ; turn += 1) {
      if (this.#maxTurns !== undefined && turn >= this.#maxTurns) {
        return "turn-limit";
      }
      const compaction = this.#compaction;
      if (compaction) {
        // Compaction runs before every request and may rewrite the history.
        session.replace(await compaction.prepare(session.messages, session.activeRequest));
      }

      let response;
      try {
        response = await this.#client.messages.create({
          model: this.#model,
          system: this.#system,
          messages: session.messages,
          tools: this.#registry.schemas(),
          max_tokens: this.#maxTokens,
        });
        // A successful request resets the retry allowance.
        reactiveRetries = 0;
      } catch (error) {
        // A reactive retry re-sends the request, so it counts as a model request
        // towards maxTurns: `continue` advances the loop counter.
        if (
          compaction
          && compaction.isPromptTooLong(error)
          && reactiveRetries < MAX_REACTIVE_RETRIES
        ) {
          session.replace(await compaction.reactive(session.messages, session.activeRequest));
          reactiveRetries += 1;
          continue;
        }
        throw error;
      }

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
        return "finished";
      }

      const results: ContentBlockParam[] = [];
      const executed: string[] = [];
      for (const block of toolCalls) {
        const blocked = await this.#hooks?.trigger("PreToolUse", {
          toolName: block.name,
          input: block.input,
          workspaceRoot: this.#workspaceRoot,
        });
        if (blocked !== undefined) {
          this.#presenter.showResult(blocked, block.name);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: blocked,
          });
          continue;
        }
        this.#presenter.showToolCall(block.name, block.input);
        executed.push(block.name);
        const output = await this.#registry.invoke(block.name, block.input);
        await this.#hooks?.trigger("PostToolUse", {
          toolName: block.name,
          input: block.input,
          result: output,
          workspaceRoot: this.#workspaceRoot,
        });
        this.#presenter.showResult(output, block.name);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
      const reminder = this.#reminder?.afterToolRound(executed);
      if (reminder !== undefined) results.push({ type: "text", text: reminder });
      session.appendToolResults(results);
      // Compact only after the batch has closed, so no orphan tool_result remains.
      if (compaction) {
        session.replace(
          await compaction.afterBatch(session.messages, executed, session.activeRequest),
        );
      }
    }
  }
}
