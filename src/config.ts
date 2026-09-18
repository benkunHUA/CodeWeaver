import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import type { ModelClient } from "./types.js";

export interface RuntimeConfig {
  model: string;
  client: ModelClient;
}

export function loadConfig(): RuntimeConfig {
  // Only load the current project's .env, so this directory is standalone.
  config({ override: true, quiet: true });
  if (process.env.ANTHROPIC_BASE_URL) {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }

  const model = process.env.MODEL_ID;
  if (!model) throw new Error("MODEL_ID is required");
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required");
  }
  // The SDK reads API key, bearer token and base URL from the environment.
  return { model, client: new Anthropic() };
}
