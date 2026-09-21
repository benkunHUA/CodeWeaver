import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import type { ModelClient, ToolHooks } from "./types.js";
import { createDefaultHooks } from "./hooks/index.js";
import type { HookBus } from "./hooks/index.js";
import { ConsoleApprovalPrompt, createDefaultPermissionPipeline } from "./permission/index.js";
import { FileLockRegistry } from "./tools/core/FileLockRegistry.js";
import { ToolContext } from "./tools/core/ToolContext.js";
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
  const context = new ToolContext({ workspace, locks: new FileLockRegistry(), logger: console.error });
  const registry = new ToolRegistry({ context, hooks: config.toolHooks, logger: console.error });
  for (const tool of createDefaultTools()) registry.register(tool);
  return { ...config, workspaceRoot: workspace.root, hooks, registry, approval };
}
