import { spawn } from "node:child_process";

export const COMMAND_TIMEOUT_MS = 120_000;
export const OUTPUT_LIMIT = 50_000;
const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

export interface BashOptions {
  cwd?: string;
  timeoutMs?: number;
}

// Python slices Unicode code points, not JavaScript's UTF-16 code units.
export function sliceCharacters(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}

export function stripWhitespace(text: string): string {
  // Match Python str.strip(), including NEL and information separators.
  return text.replace(
    /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu,
    "",
  );
}

export async function runBash(
  command: string,
  { cwd = process.cwd(), timeoutMs = COMMAND_TIMEOUT_MS }: BashOptions = {},
): Promise<string> {
  // Deliberately matches the lesson's substring filter; this is NOT a sandbox.
  if (DANGEROUS.some((fragment) => command.includes(fragment))) {
    return "Error: Dangerous command blocked";
  }

  return new Promise((resolve) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    try {
      // POSIX shell=True uses /bin/sh, just like Python (not necessarily bash).
      const child = spawn(command, {
        shell: true,
        cwd,
        stdio: ["inherit", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve(`Error: ${error.message}`);
      });
      child.once("close", () => {
        clearTimeout(timer);
        if (timedOut) return;
        // Decode after collection so split UTF-8 characters survive. Buffer
        // replaces invalid bytes; text mode also normalizes CRLF and CR.
        const decode = (chunks: Buffer[]) =>
          Buffer.concat(chunks).toString("utf8").replace(/\r\n?/g, "\n");
        const output = stripWhitespace(decode(stdout) + decode(stderr));
        // A nonzero exit code is not an exception in the Python implementation.
        resolve(output ? sliceCharacters(output, OUTPUT_LIMIT) : "(no output)");
      });
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
        // Do not wait for descendants that may still hold inherited pipes.
        child.stdout.destroy();
        child.stderr.destroy();
        resolve(`Error: Timeout (${timeoutMs / 1000}s)`);
      }, timeoutMs);
    } catch (error) {
      clearTimeout(timer);
      resolve(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
