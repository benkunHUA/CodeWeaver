import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { join } from "node:path";
import type { ModelClient, ToolHooks } from "./types.js";
import { subagentPrompt } from "./agent/systemPrompt.js";
import { ContextCompactor, ToolResultStore, TranscriptArchive } from "./compaction/index.js";
import { createDefaultHooks } from "./hooks/index.js";
import type { HookBus } from "./hooks/index.js";
import { ConsoleApprovalPrompt, createDefaultPermissionPipeline } from "./permission/index.js";
import { TodoReminder, TodoStore } from "./planning/index.js";
import { SkillLoader } from "./skills/index.js";
import {
  ConsoleSubagentPresenter,
  SUBAGENT_MAX_TURNS,
  SubagentRunner,
} from "./subagent/index.js";
import { FileLockRegistry } from "./tools/core/FileLockRegistry.js";
import { ToolContext } from "./tools/core/ToolContext.js";
import { TaskTool } from "./tools/TaskTool.js";
import { ToolRegistry } from "./tools/ToolRegistry.js";
import { createDefaultTools } from "./tools/createDefaultTools.js";
import { createWorkspace } from "./workspace.js";

export interface Config {
  readonly model: string;
  readonly client: ModelClient;
  readonly workspaceRoot: string;
  readonly toolHooks: ToolHooks;
}

export interface RuntimeConfig extends Config {
  readonly registry: ToolRegistry;
  readonly hooks: HookBus;
  /**
   * The approval prompt instance the permission pipeline was built with. It is
   * kept here (not in `Config`) so the CLI can inject its shared readline
   * reader without leaking terminal details into the base configuration.
   */
  readonly approval: ConsoleApprovalPrompt;
  /**
   * Stateful reminder strategy handed to `AgentLoop`. `AgentLoop` calls
   * `beginRun()` at the start of every `run()`, which resets the internal
   * counter, so a single instance can be safely reused across questions.
   */
  readonly reminder: TodoReminder;
  /**
   * Delegation backend behind the parent's `task` tool. Exposed so the CLI and
   * tests can reuse the same runner instead of wiring a second one.
   */
  readonly subagents: SubagentRunner;
  /**
   * Skills scanned once at startup from `<workspace.root>/skills`. It is both
   * the source of the prompt catalog and the data source for `load_skill`, and
   * the same instance is shared by the parent and the subagent.
   */
  readonly skills: SkillLoader;
  /**
   * The one compaction pipeline both loops run against. It is stateless (all
   * state lives in the workspace directories), so the parent and the subagent
   * can safely share the instance while keeping separate conversations.
   */
  readonly compaction: ContextCompactor;
}

export function loadConfig(): Config {
  config({ override: true, quiet: true });
  if (process.env.ANTHROPIC_BASE_URL) {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }

  const model = process.env.MODEL_ID;
  if (!model) throw new Error("MODEL_ID is required");
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required");
  }
  const workspaceRoot = process.env.CODEWEAVER_ROOT ?? process.cwd();
  const toolHooks: ToolHooks = {
    before(ctx) {
      console.log(`\x1b[35m> ${ctx.name}\x1b[0m`);
    },
  };
  return {
    model,
    client: new Anthropic(),
    workspaceRoot,
    toolHooks,
  };
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const config = loadConfig();
  const workspace = await createWorkspace(config.workspaceRoot);
  const approval = new ConsoleApprovalPrompt({ isInteractive: process.stdin.isTTY === true });
  const pipeline = createDefaultPermissionPipeline({ workspaceRoot: workspace.root, approval });
  const hooks = createDefaultHooks({
    checker: pipeline,
    workspaceRoot: workspace.root,
    log: console.log,
    logger: console.error,
  });
  const locks = new FileLockRegistry();
  const logger = console.error;

  // s08 artifacts live inside the workspace so the model can read them back:
  // `.transcripts/` keeps whole histories, `.task_outputs/tool-results/` keeps
  // the full text behind every recoverable placeholder.
  const archive = new TranscriptArchive({ dir: join(workspace.root, ".transcripts") });
  const results = new ToolResultStore({ dir: join(workspace.root, ".task_outputs", "tool-results") });
  const compaction = new ContextCompactor({
    client: config.client,
    model: config.model,
    archive,
    results,
    log: console.log,
  });

  // Scan the skills directory once; the same library feeds both prompts and the
  // `load_skill` tool, so the parent and the subagent share one snapshot.
  const skills = await SkillLoader.scan({ dir: join(workspace.root, "skills") });

  // The subagent gets a fresh context but shares the workspace, the locks and
  // the skill library.
  const subContext = new ToolContext({
    workspace,
    locks,
    todos: new TodoStore(),
    skills,
    logger,
  });
  const subRegistry = new ToolRegistry({ context: subContext, hooks: config.toolHooks, logger });
  // The eight base tools only: a subagent has no `task`, so depth is fixed at
  // one, but it can still compact its own history.
  for (const tool of createDefaultTools()) subRegistry.register(tool);

  const subagents = new SubagentRunner({
    client: config.client,
    model: config.model,
    system: subagentPrompt(workspace.root, skills.catalog()),
    registry: subRegistry,
    workspaceRoot: workspace.root,
    hooks,
    // A separate instance: the child loop's beginRun() must not reset the
    // parent's reminder counter.
    reminder: new TodoReminder(),
    maxTurns: SUBAGENT_MAX_TURNS,
    presenter: new ConsoleSubagentPresenter({ log: console.log }),
    compaction,
  });

  // The parent gets one extra tool: `task`.
  const context = new ToolContext({
    workspace,
    locks,
    todos: new TodoStore(),
    subagents,
    skills,
    logger,
  });
  const registry = new ToolRegistry({ context, hooks: config.toolHooks, logger });
  for (const tool of createDefaultTools()) registry.register(tool);
  registry.register(new TaskTool());

  const reminder = new TodoReminder();
  return {
    ...config,
    workspaceRoot: workspace.root,
    hooks,
    registry,
    approval,
    reminder,
    subagents,
    skills,
    compaction,
  };
}
