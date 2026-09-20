#!/usr/bin/env node
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { agentLoop, systemPrompt } from "./agent.js";
import { stripWhitespace } from "./bash.js";
import { loadRuntimeConfig } from "./config.js";
import type { ConsoleApprovalPrompt } from "./permission/index.js";
import type { AgentOptions, Conversation } from "./types.js";

/**
 * Optional runtime services the CLI can wire into. Kept separate from
 * `AgentOptions` so the loop contract stays free of terminal concerns.
 */
export interface CliServices {
  readonly approval?: ConsoleApprovalPrompt | undefined;
}

export async function runCli(options: AgentOptions, services?: CliServices): Promise<void> {
  const log = options.log ?? console.log;
  const history: Conversation = [];
  const rl = createInterface({ input: stdin, output: stdout, terminal: !!stdin.isTTY });
  let closed = false;
  rl.on("close", () => { closed = true; });
  rl.setPrompt("\x1b[36mCodeWeaver >> \x1b[0m");
  rl.on("SIGINT", () => rl.close());
  // Reuse the REPL's readline for approval prompts. A second interface on `stdin`
  // would race with this one: the "y" typed at the prompt could be buffered by the
  // REPL and later replayed as the next user question.
  services?.approval?.setQuestionProvider((text) => new Promise<string>((resolve) => {
    rl.question(text, resolve);
  }));
  log("输入问题后按回车发送，输入 q 退出。\n");

  try {
    rl.prompt();
    for await (const query of rl) {
      if (["q", "exit", ""].includes(stripWhitespace(query).toLowerCase())) break;
      await options.hooks?.trigger("UserPromptSubmit", {
        query,
        workspaceRoot: options.workspaceRoot ?? process.cwd(),
      });
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
    await runCli(
      { ...runtime, system: systemPrompt(runtime.workspaceRoot) },
      { approval: runtime.approval },
    );
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
