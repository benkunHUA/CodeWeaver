export function systemPrompt(cwd = process.cwd()): string {
  return `你是一个位于 ${cwd} 的编程智能体。开始任何多步骤任务前，先用 todo_write 规划步骤，并在执行过程中持续更新状态。需要聚焦探索或边界清晰的子任务时，用 task 委派给子智能体。请使用工具解决问题，直接动手，不要只做解释。`;
}

/** Prompt for a delegated subagent: same workspace, but a fresh conversation. */
export function subagentPrompt(cwd = process.cwd()): string {
  return `你是一个位于 ${cwd} 的编程智能体。完成交给你的任务后，返回简洁的最终结论。`;
}
