import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";

export type Conversation = MessageParam[];
export type ModelRequest = MessageCreateParamsNonStreaming;
export type ModelResponse = Pick<Message, "content" | "stop_reason">;
export type AnthropicTool = Tool;

export interface ModelClient {
  messages: {
    create(request: ModelRequest): Promise<ModelResponse>;
  };
}

export interface BashInput {
  command: string;
}

export interface ReadFileInput {
  path: string;
  limit?: number;
}

export interface WriteFileInput {
  path: string;
  content: string;
}

export interface EditFileInput {
  path: string;
  old_text: string;
  new_text: string;
}

export interface GlobInput {
  pattern: string;
}

export interface ToolHooksContext<TName extends string = string> {
  readonly name: TName;
  readonly input: unknown;
}

export interface ToolHooksAfterContext<TName extends string = string>
  extends ToolHooksContext<TName> {
  readonly result: string;
  readonly durationMs: number;
}

export interface ToolHooks {
  readonly before?: (context: ToolHooksContext) => Promise<void> | void;
  readonly after?: (context: ToolHooksAfterContext) => Promise<void> | void;
}

export interface Workspace {
  readonly root: string;
  readonly safePath: (userPath: string) => Promise<string>;
}

export type Logger = (text: string) => void;
