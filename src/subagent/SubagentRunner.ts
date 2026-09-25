import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { AgentLoop, type ToolRoundReminder } from "../agent/AgentLoop.js";
import { Session } from "../agent/Session.js";
import type { CompactionPort } from "../compaction/index.js";
import type { HookBus } from "../hooks/HookBus.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ModelClient } from "../types.js";
import { ConsoleSubagentPresenter, type SubagentPresenter } from "./SubagentPresenter.js";
import type { SubagentLauncher } from "./types.js";

export const SUBAGENT_MAX_TURNS = 30;
export const SUBAGENT_NO_SUMMARY = "(no summary)";

/** s06 wording for a subagent that never produced a final answer. */
export function subagentTurnLimitMessage(maxTurns: number): string {
  return `Subagent stopped after ${maxTurns} turns without a final answer.`;
}

export interface SubagentRunnerOptions {
  readonly client: ModelClient;
  readonly model: string;
  /** The subagent's system prompt, supplied by the wiring layer. */
  readonly system: string;
  readonly registry: ToolRegistry;
  readonly workspaceRoot: string;
  /** Shared with the parent so the subagent obeys the same lifecycle hooks. */
  readonly hooks?: HookBus | undefined;
  /** The subagent's own reminder instance; never the parent's. */
  readonly reminder?: ToolRoundReminder | undefined;
  /** Defaults to `SUBAGENT_MAX_TURNS`. */
  readonly maxTurns?: number | undefined;
  readonly maxTokens?: number | undefined;
  /** Defaults to `ConsoleSubagentPresenter`. */
  readonly presenter?: SubagentPresenter | undefined;
  /**
   * Compaction is injected rather than built here: the child session has its own
   * messages and `activeRequest`, so the same port simply runs against them.
   */
  readonly compaction?: CompactionPort | undefined;
}

/**
 * A subagent is not a second implementation: it is the one `AgentLoop` pointed
 * at a brand-new `Session` whose first (and only initial) message is the
 * delegated prompt, so the parent's conversation never leaks in and the
 * subagent's tool calls stay in its own context. The loop is built once from
 * the injected collaborators and reused across `run()` calls, while every call
 * gets a fresh session. Only the final assistant text returns to the caller.
 */
export class SubagentRunner implements SubagentLauncher {
  readonly #loop: AgentLoop;
  readonly #presenter: SubagentPresenter;
  readonly #maxTurns: number;

  constructor(options: SubagentRunnerOptions) {
    this.#presenter = options.presenter ?? new ConsoleSubagentPresenter();
    this.#maxTurns = options.maxTurns ?? SUBAGENT_MAX_TURNS;
    this.#loop = new AgentLoop({
      client: options.client,
      model: options.model,
      system: options.system,
      registry: options.registry,
      workspaceRoot: options.workspaceRoot,
      presenter: this.#presenter,
      maxTurns: this.#maxTurns,
      hooks: options.hooks,
      reminder: options.reminder,
      maxTokens: options.maxTokens,
      compaction: options.compaction,
    });
  }

  async run(prompt: string): Promise<string> {
    this.#presenter.showStart();
    // `appendUser` (not the constructor) records the prompt as the active
    // request, so a child compaction keeps it apart from its own summary.
    const session = new Session();
    session.appendUser(prompt);
    const outcome = await this.#loop.run(session);
    if (outcome === "turn-limit") {
      this.#presenter.showStopped();
      return subagentTurnLimitMessage(this.#maxTurns);
    }
    this.#presenter.showFinish();
    const summary = extractText(session.messages.at(-1));
    return summary === "" ? SUBAGENT_NO_SUMMARY : summary;
  }
}

/** Joins the text blocks of the final message; a string body is returned as is. */
function extractText(message: MessageParam | undefined): string {
  if (message === undefined) return "";
  const { content } = message;
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}
