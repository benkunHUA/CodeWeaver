import type {
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { runBash, sliceCharacters } from "./bash.js";
import type { AgentOptions, BashInput, Conversation } from "./types.js";

export const TOOLS: Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

export function systemPrompt(cwd = process.cwd()): string {
  return `You are a coding agent at ${cwd}. Use bash to solve tasks. Act, don't explain.`;
}

function parseBashInput(input: unknown): BashInput {
  if (
    typeof input !== "object" ||
    input === null ||
    !("command" in input) ||
    typeof input.command !== "string"
  ) {
    throw new TypeError("Tool input must contain a string command");
  }
  return { command: input.command };
}

export async function agentLoop(
  messages: Conversation,
  {
    client,
    model,
    system = systemPrompt(),
    runCommand = runBash,
    log = console.log,
  }: AgentOptions,
): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model,
      system,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content });
    const toolCalls = response.content.filter((block) => block.type === "tool_use");
    // Actual content is authoritative even if stop_reason disagrees.
    if (toolCalls.length === 0) return;

    const results: ToolResultBlockParam[] = [];
    for (const block of toolCalls) {
      const { command } = parseBashInput(block.input);
      log(`\x1b[33m$ ${command}\x1b[0m`);
      const output = await runCommand(command);
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
