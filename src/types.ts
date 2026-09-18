import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages";

export type Conversation = MessageParam[];
export type ModelRequest = MessageCreateParamsNonStreaming;
export type ModelResponse = Pick<Message, "content" | "stop_reason">;

export interface ModelClient {
  messages: {
    create(request: ModelRequest): Promise<ModelResponse>;
  };
}

export interface BashInput {
  command: string;
}

export type CommandRunner = (command: string) => Promise<string>;
export type Logger = (text: string) => void;

export interface AgentOptions {
  client: ModelClient;
  model: string;
  system?: string;
  runCommand?: CommandRunner;
  log?: Logger;
}
