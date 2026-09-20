import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import type { ModelClient, ToolRegistry, ToolHooks } from "./types.js";
import { createDefaultRegistry } from "./tools/index.js";
import { createWorkspace } from "./workspace.js";

export interface Config {
  readonly model: string;
  readonly client: ModelClient;
  readonly workspaceRoot: string;
  readonly hooks: ToolHooks;
}

export interface RuntimeConfig extends Config {
  readonly registry: ToolRegistry;
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
  const hooks: ToolHooks = {
    before(ctx) {
      console.log(`\x1b[35m> ${ctx.name}\x1b[0m`);
    },
  };
  return {
    model,
    client: new Anthropic(),
    workspaceRoot,
    hooks,
  };
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const config = loadConfig();
  const workspace = await createWorkspace(config.workspaceRoot);
  const registry = await createDefaultRegistry({
    root: workspace.root, hooks: config.hooks, logger: console.error,
  });
  return { ...config, workspaceRoot: workspace.root, registry };
}
