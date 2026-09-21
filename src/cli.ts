#!/usr/bin/env node
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { AgentLoop } from "./agent/AgentLoop.js";
import { Session } from "./agent/Session.js";
import { ConsoleToolPresenter } from "./agent/ToolPresenter.js";
import { systemPrompt } from "./agent/systemPrompt.js";
import { stripWhitespace } from "./bash.js";
import { loadRuntimeConfig } from "./config.js";
import type { HookBus } from "./hooks/index.js";
import type { ConsoleApprovalPrompt } from "./permission/index.js";
import type { Conversation, Logger } from "./types.js";

/**
 * Everything one REPL needs. Kept as plain data so the readline terminal
 * concerns stay out of `AgentLoop`.
 */
export interface CliOptions {
  readonly loop: AgentLoop;
  readonly hooks: HookBus;
  readonly workspaceRoot: string;
  readonly approval?: ConsoleApprovalPrompt | undefined;
  readonly log?: Logger | undefined;
}

export async function runCli(options: CliOptions): Promise<void> {
  const log = options.log ?? console.log;
  // One session per REPL: history accumulates across questions.
  const history: Conversation = [];
  const session = new Session(history);
  const rl = createInterface({ input: stdin, output: stdout, terminal: !!stdin.isTTY });
  let closed = false;
  rl.on("close", () => { closed = true; });
  rl.setPrompt("\x1b[36mCodeWeaver >> \x1b[0m");
  rl.on("SIGINT", () => rl.close());
  // Reuse the REPL's readline for approval prompts. A second interface on `stdin`
  // would race with this one: the "y" typed at the prompt could be buffered by the
  // REPL and later replayed as the next user question.
  options.approval?.setQuestionProvider((text) => new Promise<string>((resolve) => {
    rl.question(text, resolve);
  }));
  log("输入问题后按回车发送，输入 q 退出。\n");

  try {
    rl.prompt();
    for await (const query of rl) {
      if (["q", "exit", ""].includes(stripWhitespace(query).toLowerCase())) break;
      await options.hooks.trigger("UserPromptSubmit", { query, workspaceRoot: options.workspaceRoot });
      history.push({ role: "user", content: query });
      await options.loop.run(session);
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
    const loop = new AgentLoop({
      client: runtime.client,
      model: runtime.model,
      system: systemPrompt(runtime.workspaceRoot),
      registry: runtime.registry,
      workspaceRoot: runtime.workspaceRoot,
      hooks: runtime.hooks,
      presenter: new ConsoleToolPresenter({ log: console.log }),
      reminder: runtime.reminder,
    });
    await runCli({
      loop,
      hooks: runtime.hooks,
      workspaceRoot: runtime.workspaceRoot,
      approval: runtime.approval,
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
