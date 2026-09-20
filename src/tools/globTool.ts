import { readdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { OUTPUT_LIMIT, sliceCharacters } from "../bash.js";
import type { Workspace } from "../types.js";

const GLOB_MATCH_LIMIT = 200;

function escapeForRegex(value: string): string {
  return value.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

function segmentToRegex(segment: string): RegExp {
    let local = "";
    for (let j = 0; j < segment.length; j += 1) {
      const char = segment[j] ?? "";
      if (char === "\\") {
        local += escapeForRegex(segment[j + 1] ?? "");
        j += 1;
      } else if (char === "*") {
        local += "[^/]*";
      } else if (char === "?") {
        local += "[^/]";
      } else if (char === "[") {
        const end = segment.indexOf("]", j);
        if (end === -1) {
          local += escapeForRegex(char);
        } else {
          let bracket = segment.slice(j + 1, end);
          if (bracket.length === 0) {
            local += escapeForRegex(char);
          } else {
            const negated = bracket.startsWith("!");
            if (negated) bracket = bracket.slice(1);
            bracket = bracket.replace(/[\\^[]/g, "\\$&");
            local += `[${negated ? "^" : ""}${bracket}]`;
            j = end;
          }
        }
      } else {
        local += escapeForRegex(char);
      }
    }
    return new RegExp(`^${local}$`, "u");
}

export async function globTool(
  workspace: Workspace,
  input: { readonly pattern: string },
): Promise<string> {
  try {
    if (isAbsolute(input.pattern) || input.pattern.split("/").includes("..")) {
      throw new Error(`Path escapes workspace: ${input.pattern}`);
    }
    if (input.pattern.length > 4096) throw new Error("Glob pattern exceeds 4096 characters");
    const directoryOnly = input.pattern.endsWith("/");
    const segments = input.pattern.split("/").filter((part) => part !== "" && part !== ".");
    if (!segments.length) return "(no matches)";
    const regexes = segments.map((segment) => segment === "**" ? null : segmentToRegex(segment));
    const expand = (states: Set<number>): Set<number> => {
      for (const state of states) {
        if (segments[state] === "**") states.add(state + 1);
      }
      return states;
    };
    const stack = [{ directory: "", states: expand(new Set([0])) }];
    const seen = new Set<string>();
    while (stack.length) {
      const { directory, states } = stack.pop()!;
      const checked = await workspace.safePath(directory);
      for (const entry of await readdir(checked, { withFileTypes: true })) {
        const next = new Set<number>();
        for (const state of states) {
          const segment = segments[state];
          if (segment === undefined || (entry.name.startsWith(".") && !segment.startsWith("."))) continue;
          if (segment === "**") next.add(state);
          else if (regexes[state]?.test(entry.name)) next.add(state + 1);
        }
        expand(next);
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (next.has(segments.length) && (!directoryOnly || entry.isDirectory())) {
          seen.add(directoryOnly ? `${relative}/` : relative);
        }
        // Do not follow directory symlinks: this also bounds cyclic trees.
        if (entry.isDirectory() && [...next].some((state) => state < segments.length)) {
          stack.push({ directory: relative, states: next });
        }
      }
    }
    const allowed: string[] = [];
    for (const candidate of [...seen].sort()) {
      try {
        await workspace.safePath(candidate);
        allowed.push(candidate);
      } catch {
        // Skip matches resolving outside workspace.
      }
      if (allowed.length > GLOB_MATCH_LIMIT + 1) break;
    }
    const outputLines = allowed.slice(0, GLOB_MATCH_LIMIT);
    if (allowed.length > GLOB_MATCH_LIMIT) {
      outputLines.push("... (more matches omitted; narrow the pattern)");
    }
    const joined = outputLines.length === 0 ? "(no matches)" : outputLines.join("\n");
    return sliceCharacters(joined, OUTPUT_LIMIT);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
