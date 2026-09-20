#!/usr/bin/env node
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { agentLoop, systemPrompt } from "./agent.js";
import { stripWhitespace } from "./bash.js";
import { loadRuntimeConfig } from "./config.js";
import type { AgentOptions, Conversation } from "./types.js";

export async function runCli(options: AgentOptions): Promise<void> {
  const log = options.log ?? console.log;
  const history: Conversation = [];
  const rl = createInterface({ input: stdin, output: stdout, terminal: !!stdin.isTTY });
  let closed = false;
  rl.on("close", () => { closed = true; });
  rl.setPrompt("\x1b[36mCodeWeaver >> \x1b[0m");
  rl.on("SIGINT", () => rl.close());
  log("输入问题后按回车发送，输入 q 退出。\n");

  try {
    rl.prompt();
    for await (const query of rl) {
      if (["q", "exit", ""].includes(stripWhitespace(query).toLowerCase())) break;
      history.push({ role: "user", content: query });
      await agentLoop(history, options);
      const content = history.at(-1)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") log(block.text);
        }
      }
      log("");
      if (!closed) rl.prompt();
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  try {
    const runtime = await loadRuntimeConfig();
    await runCli({ ...runtime, system: systemPrompt(runtime.workspaceRoot) });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
