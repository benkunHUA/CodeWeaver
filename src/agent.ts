import type {
  ContentBlock,
  MessageCreateParamsBase,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { sliceCharacters } from "./bash.js";
import type {
  AgentOptions,
  BashInput,
  Conversation,
  ToolHandler,
  ToolRegistry,
} from "./types.js";
import type { ToolRegistryLogger } from "./types.js";
import { createDefaultRegistry, defaultToolSchemas } from "./tools/index.js";
import type { DefaultRegistryOptions } from "./tools/index.js";

export const TOOLS = defaultToolSchemas;

export function systemPrompt(cwd = process.cwd()): string {
  return `你是一个位于 ${cwd} 的编程智能体。请使用工具解决问题，直接动手，不要只做解释。`;
}

function parseBashInput(input: unknown): BashInput | { readonly error: string } {
  if (
    typeof input !== "object" ||
    input === null ||
    !("command" in input) ||
    typeof input.command !== "string"
  ) {
    return { error: "Invalid input for bash: command must be a string" };
  }
  return { command: input.command };
}

function isBashBlock(block: Pick<ToolUseBlock, "name">): boolean {
  return block.name === "bash";
}

async function resolveRegistry(options: AgentOptions): Promise<ToolRegistry> {
  if (options.registry) return options.registry;
  const legacy = options.runCommand;
  const baseHooks = options.hooks;
  const logger: ToolRegistryLogger | undefined = options.log;
  const registryOptions: DefaultRegistryOptions = baseHooks
    ? logger
      ? { hooks: baseHooks, logger }
      : { hooks: baseHooks }
    : logger
      ? { logger }
      : {};
  if (!legacy) return createDefaultRegistry(registryOptions);
  const bashHandler: ToolHandler = async (raw) => {
    const parsed = parseBashInput(raw);
    if ("error" in parsed) {
      return `Error: ${parsed.error}`;
    }
    return legacy(parsed.command);
  };
  const overrides = [{ name: "bash" as const, handler: bashHandler }];
  return createDefaultRegistry({ ...registryOptions, overrides });
}

export async function agentLoop(
  messages: Conversation,
  options: AgentOptions,
): Promise<void> {
  const { client, model, log = console.log } = options;
  const system = options.system ?? systemPrompt();
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
    if (toolCalls.length === 0) return;

    const results: ToolResultBlockParam[] = [];
    for (const raw of toolCalls) {
      const block = raw as ToolUseBlock;
      if (isBashBlock(block)) {
        const parsed = parseBashInput(block.input);
        if (!("error" in parsed)) {
          log(`\x1b[33m$ ${parsed.command}\x1b[0m`);
        }
      }
      const output = await registry.invoke(block.name, block.input);
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
