/** Input of the `task` tool. */
export interface TaskInput {
  readonly prompt: string;
}

/** Port the `task` tool uses to run a subagent with its own conversation. */
export interface SubagentLauncher {
  run(prompt: string): Promise<string>;
}
