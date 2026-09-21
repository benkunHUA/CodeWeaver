export function systemPrompt(cwd = process.cwd()): string {
  return `你是一个位于 ${cwd} 的编程智能体。请使用工具解决问题，直接动手，不要只做解释。`;
}
