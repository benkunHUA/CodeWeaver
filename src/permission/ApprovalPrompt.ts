import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import type { ApprovalPrompt, ApprovalRequest, ApprovalResponse } from "./types.js";

/**
 * What the terminal prompt asks. Chinese on purpose: the CLI diverges from the
 * English wording the s03 lesson prints.
 */
export const APPROVAL_QUESTION = "   是否允许？[y/N] ";

/** Reason reported when approval is impossible (no TTY, or an explicit deny-all). */
export const NO_INTERACTIVE_TERMINAL = "没有交互式终端，无法确认";

const APPROVED_ANSWERS: readonly string[] = ["y", "yes"];

function isApproved(answer: string): boolean {
  return APPROVED_ANSWERS.includes(answer.trim().toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ConsoleApprovalPromptOptions {
  /** Usually `process.stdin.isTTY === true`. */
  readonly isInteractive: boolean;
  /** Defaults to `console.log`. */
  readonly log?: ((message: string) => void) | undefined;
  /** Injectable for tests; defaults to a one-shot `node:readline` interface. */
  readonly question?: ((promptText: string) => Promise<string>) | undefined;
}

/**
 * Gate 3 prompt: prints the s03 banner and reads one line from the terminal.
 *
 * The prompt never throws and never blocks when there is no interactive
 * terminal, because the pipeline must stay fail-closed in both cases.
 */
export class ConsoleApprovalPrompt implements ApprovalPrompt {
  private readonly isInteractive: boolean;
  private readonly log: (message: string) => void;
  private readonly question: ((promptText: string) => Promise<string>) | undefined;
  private questionProvider: ((promptText: string) => Promise<string>) | undefined;

  constructor(options: ConsoleApprovalPromptOptions) {
    this.isInteractive = options.isInteractive;
    this.log = options.log ?? console.log;
    this.question = options.question;
  }

  /**
   * Reuse an already-open readline interface for approval prompts.
   *
   * The CLI already owns a REPL readline on `stdin`. Creating a second
   * interface here would make both consumers race for the same input stream:
   * the "y" typed at the approval prompt can be swallowed by the REPL and
   * later replayed as the next user question. Injecting the REPL's own reader
   * keeps a single consumer on the terminal.
   */
  setQuestionProvider(provider: (promptText: string) => Promise<string>): void {
    this.questionProvider = provider;
  }

  async request(request: ApprovalRequest): Promise<ApprovalResponse> {
    if (!this.isInteractive) {
      return { decision: "deny", reason: NO_INTERACTIVE_TERMINAL };
    }
    try {
      this.log(`\n\x1b[33m[需要确认] ${request.reason}\x1b[0m`);
      this.log(`   工具: ${request.toolName}(${JSON.stringify(request.input)})`);
      const ask = this.questionProvider ?? this.question ?? ((promptText: string) => this.readLine(promptText));
      const answer = await ask(APPROVAL_QUESTION);
      // A plain denial carries no reason: the approval gate supplies the default.
      return isApproved(answer) ? { decision: "allow" } : { decision: "deny" };
    } catch (error) {
      return { decision: "deny", reason: `征求确认失败：${errorMessage(error)}` };
    }
  }

  /** Fallback interface, only used when no shared reader was injected. Closed on EOF. */
  private async readLine(promptText: string): Promise<string> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return await new Promise<string>((resolve, reject) => {
        let answered = false;
        rl.question(promptText, (answer) => {
          answered = true;
          resolve(answer);
        });
        rl.once("close", () => {
          if (!answered) reject(new Error("输入流在回答前结束"));
        });
      });
    } finally {
      rl.close();
    }
  }
}

/** Deny-everything prompt for non-interactive environments and explicit wiring. */
export class DenyAllApprovalPrompt implements ApprovalPrompt {
  async request(_request: ApprovalRequest): Promise<ApprovalResponse> {
    return { decision: "deny", reason: NO_INTERACTIVE_TERMINAL };
  }
}
