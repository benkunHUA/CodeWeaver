import { parse } from "yaml";

export interface Frontmatter {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly body: string;
}

/**
 * Splits on `\n` while keeping the line terminator attached, mirroring Python's
 * `str.splitlines(keepends=True)` closely enough to recognise the `---` markers
 * after stripping trailing `\r`/`\n` from each line.
 */
function splitKeepingEnds(text: string): string[] {
  return text.split(/(?<=\n)/u);
}

/** Removes the trailing line terminator, mirroring Python's `rstrip("\r\n")`. */
function stripLineEnd(line: string): string {
  return line.replace(/[\r\n]+$/u, "");
}

function readMetadata(frontmatter: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = parse(frontmatter);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/**
 * Splits an optional YAML frontmatter block from the document body.
 * The opening `---` must be the first line; without a closing `---` the whole
 * text is treated as the body. Unparseable or non-mapping frontmatter yields an
 * empty metadata object while still exposing the trimmed body.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = splitKeepingEnds(text);
  if (stripLineEnd(lines[0] ?? "") !== "---") {
    return { metadata: {}, body: text };
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (stripLineEnd(lines[index] ?? "") === "---") {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex === -1) {
    return { metadata: {}, body: text };
  }

  const frontmatter = lines.slice(1, closingIndex).join("");
  const body = lines.slice(closingIndex + 1).join("").trim();
  return { metadata: readMetadata(frontmatter), body };
}
