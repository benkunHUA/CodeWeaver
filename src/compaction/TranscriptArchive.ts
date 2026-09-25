import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { Conversation } from "../types.js";

// Python's re.fullmatch against the marker text; a compaction marker can be
// re-read later, so the captured path is re-verified against this archive.
const MARKER_PATTERN = /^\[\d+ messages archived at (.+)\]$/;

export interface TranscriptArchiveOptions {
  /** Directory holding one `.jsonl` file per archived conversation. */
  readonly dir: string;
}

/** Writes whole conversations to disk as JSON lines so history can be recovered. */
export class TranscriptArchive {
  readonly #dir: string;

  constructor(options: TranscriptArchiveOptions) {
    this.#dir = options.dir;
  }

  /** Writes every message as one JSON line; returns the absolute file path. */
  async write(messages: Conversation): Promise<string> {
    await mkdir(this.#dir, { recursive: true });
    const filePath = path.resolve(this.#dir, `transcript_${randomUUID().replaceAll("-", "")}.jsonl`);
    // An empty conversation produces an empty file, matching Python's
    // `write_transcript` writing nothing for an empty list.
    const lines = messages.map((message) => `${JSON.stringify(message)}\n`).join("");
    await writeFile(filePath, lines, "utf8");
    return filePath;
  }

  /** True when the message is a valid archive marker pointing at a real transcript. */
  async isMarker(message: MessageParam | undefined): Promise<boolean> {
    if (!message || message.role !== "user" || typeof message.content !== "string") return false;
    const candidate = MARKER_PATTERN.exec(message.content)?.[1];
    if (!candidate) return false;
    return this.#isFileInsideDir(candidate);
  }

  async #isFileInsideDir(candidate: string): Promise<boolean> {
    try {
      const [resolvedFile, resolvedDir] = await Promise.all([
        realpath(candidate),
        realpath(this.#dir),
      ]);
      if (resolvedFile !== resolvedDir && !resolvedFile.startsWith(resolvedDir + path.sep)) {
        return false;
      }
      return (await stat(resolvedFile)).isFile();
    } catch {
      // A missing directory or file makes the marker invalid.
      return false;
    }
  }
}
