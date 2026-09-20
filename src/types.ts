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

export type ToolName = "bash" | "read_file" | "write_file" | "edit_file" | "glob";

export interface ToolInputMap {
  bash: BashInput;
  read_file: ReadFileInput;
  write_file: WriteFileInput;
  edit_file: EditFileInput;
  glob: GlobInput;
}

export type ToolInput = ToolInputMap[ToolName] | unknown;

export type ToolHandlerResult = string;
export type ToolHandler<TInput = unknown> = (input: TInput) => Promise<ToolHandlerResult>;

export type ToolDefinition<TName extends string = ToolName> = TName extends string ? {
  readonly name: TName;
  readonly schema: AnthropicTool;
  readonly handler: ToolHandler<TName extends keyof ToolInputMap ? ToolInputMap[TName] : unknown>;
} : never;

export type RegisteredToolDefinition = ToolDefinition | ToolDefinition<string>;

export interface ToolHooksContext<TName extends string = string> {
  readonly name: TName;
  readonly input: unknown;
}

export interface ToolHooksAfterContext<TName extends string = string>
  extends ToolHooksContext<TName> {
  readonly result: ToolHandlerResult;
  readonly durationMs: number;
}

export interface ToolHooks {
  readonly before?: (context: ToolHooksContext) => Promise<void> | void;
  readonly after?: (context: ToolHooksAfterContext) => Promise<void> | void;
}

export type ToolRegistryLogger = (message: string) => void;

export interface ToolRegistry {
  readonly listTools: () => readonly RegisteredToolDefinition[];
  readonly getSchemas: () => readonly AnthropicTool[];
  readonly getHandler: (name: string) => ToolHandler | undefined;
  readonly invoke: (name: string, input: unknown) => Promise<ToolHandlerResult>;
}

export interface Workspace {
  readonly root: string;
  readonly safePath: (userPath: string) => Promise<string>;
}

export type CommandRunner = (command: string) => Promise<string>;
export type Logger = (text: string) => void;

export interface AgentOptions {
  readonly client: ModelClient;
  readonly model: string;
  readonly system?: string;
  readonly registry?: ToolRegistry;
  readonly hooks?: ToolHooks;
  readonly log?: Logger;
  /** @deprecated use hooks + registry handlers or mock registry instead; kept for s01 parity tests */
  readonly runCommand?: CommandRunner;
}
