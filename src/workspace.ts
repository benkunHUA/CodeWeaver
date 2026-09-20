import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";
import type { Workspace } from "./types.js";

async function resolveInsideOrUnder(path: string, createOnMissing: boolean): Promise<string> {
  if (!createOnMissing) return realpath(path);
  const missingParts: string[] = [];
  let candidate = path;
  while (true) {
    try {
      const existing = await realpath(candidate);
      if (missingParts.length && !(await stat(existing)).isDirectory()) {
        throw new Error(`ENOTDIR: not a directory '${candidate}'`);
      }
      return resolve(existing, ...missingParts.reverse());
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code !== "ENOENT") throw error;
      // A dangling symlink is not a missing component that we can safely create.
      const entry = await lstat(candidate).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code !== "ENOENT") throw failure;
        return undefined;
      });
      if (entry?.isSymbolicLink()) throw new Error(`Unresolvable symbolic link: ${candidate}`);
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missingParts.push(basename(candidate));
      candidate = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export async function safeWorkspacePath(
  root: string,
  userPath: string,
  { createOnMissing = true }: { readonly createOnMissing?: boolean } = {},
): Promise<string> {
  const normalizedRoot = await realpath(resolve(root));
  const absolute = resolve(normalizedRoot, userPath);
  if (!isInside(normalizedRoot, absolute)) {
    throw new Error(`Path escapes workspace: ${userPath}`);
  }
  const candidate = await resolveInsideOrUnder(absolute, createOnMissing);
  if (!isInside(normalizedRoot, candidate)) {
    throw new Error(`Path escapes workspace: ${userPath}`);
  }
  return candidate;
}

export async function createWorkspace(root: string = process.cwd()): Promise<Workspace> {
  const normalizedRoot = await realpath(resolve(root));
  if (!(await stat(normalizedRoot)).isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${root}`);
  }
  return {
    root: normalizedRoot,
    async safePath(userPath: string): Promise<string> {
      if (await realpath(normalizedRoot) !== normalizedRoot) {
        throw new Error(`Workspace root changed: ${normalizedRoot}`);
      }
      return safeWorkspacePath(normalizedRoot, userPath);
    },
  };
}
