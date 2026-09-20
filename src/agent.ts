import type {
  ContentBlock,
  MessageCreateParamsBase,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { sliceCharacters } from "./bash.js";
import type { AgentOptions, Conversation, ToolRegistry } from "./types.js";
import { createDefaultRegistry, defaultToolSchemas } from "./tools/index.js";
import { BASH_TOOL_NAME, parseBashInput } from "./tools/bashTool.js";

export const TOOLS = defaultToolSchemas;

export function systemPrompt(cwd = process.cwd()): string {
  return `你是一个位于 ${cwd} 的编程智能体。请使用工具解决问题，直接动手，不要只做解释。`;
}

async function resolveRegistry(options: AgentOptions): Promise<ToolRegistry> {
  if (options.registry) return options.registry;
  // `log` also carries registry diagnostics, i.e. hook failures.
  return createDefaultRegistry({ hooks: options.toolHooks, logger: options.log });
}

export async function agentLoop(
  messages: Conversation,
  options: AgentOptions,
): Promise<void> {
  const { client, model, log = console.log } = options;
  const system = options.system ?? systemPrompt();
  const hooks = options.hooks;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const registry = await resolveRegistry(options);
  const tools: Exclude<MessageCreateParamsBase["tools"], undefined> = registry.getSchemas() as Exclude<
    MessageCreateParamsBase["tools"],
    undefined
  >;
  while (true) {
    const response = await client.messages.create({
      model,
      system,
      messages,
      tools,
      max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content as ContentBlock[] });
    const toolCalls = response.content.filter((block) => block.type === "tool_use");
    if (toolCalls.length === 0) {
      // A Stop handler may veto the exit by returning a follow-up user message.
      const forced = await hooks?.trigger("Stop", { messages, workspaceRoot });
      if (typeof forced === "string") {
        messages.push({ role: "user", content: forced });
        continue;
      }
      return;
    }

    const results: ToolResultBlockParam[] = [];
    for (const raw of toolCalls) {
      const block = raw as ToolUseBlock;
      const blocked = await hooks?.trigger("PreToolUse", {
        toolName: block.name,
        input: block.input,
        workspaceRoot,
      });
      if (blocked !== undefined) {
        log(sliceCharacters(blocked, 200));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: blocked,
        });
        continue;
      }
      if (block.name === BASH_TOOL_NAME) {
        const parsed = parseBashInput(block.input);
        if (!("error" in parsed)) {
          log(`\x1b[33m$ ${parsed.command}\x1b[0m`);
        }
      }
      const output = await registry.invoke(block.name, block.input);
      await hooks?.trigger("PostToolUse", {
        toolName: block.name,
        input: block.input,
        result: output,
        workspaceRoot,
      });
      log(sliceCharacters(output, 200));
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }
}
