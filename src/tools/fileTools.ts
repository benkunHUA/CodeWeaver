import { chmod, readFile, writeFile as writeFileFs, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { OUTPUT_LIMIT, sliceCharacters } from "../bash.js";
import type { Workspace } from "../types.js";

export async function readFileTool(
  workspace: Workspace,
  input: { readonly path: string; readonly limit?: number },
): Promise<string> {
  try {
    const resolved = await workspace.safePath(input.path);
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(resolved));
    const lines = raw.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u);
    if (lines.at(-1) === "") lines.pop();
    const limit = Number.isInteger(input.limit) ? (input.limit as number) : undefined;
    let outputLines = lines;
    if (limit !== undefined && limit > 0 && limit < lines.length) {
      outputLines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    }
    return sliceCharacters(outputLines.join("\n"), OUTPUT_LIMIT) || "(no output)";
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const editLocks = new Map<string, Promise<unknown>>();

async function withEditLock<T>(file: string, body: () => Promise<T>): Promise<T> {
  const previous = editLocks.get(file) ?? Promise.resolve();
  const next = previous.then(body, body);
  const awaited = next.then(
    (value) => {
      if (editLocks.get(file) === awaited) editLocks.delete(file);
      return value;
    },
    (error) => {
      if (editLocks.get(file) === awaited) editLocks.delete(file);
      throw error;
    },
  );
  editLocks.set(file, awaited);
  return awaited as Promise<T>;
}

function withFileLock<T>(workspace: Workspace, path: string, body: (resolved: string) => Promise<T>): Promise<T> {
  // Queue equal request paths before async realpath can reorder their arrival.
  return withEditLock(`request:${resolve(workspace.root, path)}`, async () => {
    const resolved = await workspace.safePath(path);
    return withEditLock(resolved, () => body(resolved));
  });
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const metadata = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (metadata && !metadata.isFile()) throw new Error(`Not a regular file: ${target}`);
  // Keep temporary content on the destination filesystem for atomic rename.
  const directory = await mkdtemp(join(dirname(target), ".codeweaver-"));
  const temporary = join(directory, "content");
  try {
    await writeFileFs(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (metadata) await chmod(temporary, metadata.mode & 0o777);
    await rename(temporary, target);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function writeFileTool(
  workspace: Workspace,
  input: { readonly path: string; readonly content: string },
): Promise<string> {
  try {
    await withFileLock(workspace, input.path, async (resolved) => {
      await mkdir(dirname(resolved), { recursive: true });
      const checked = await workspace.safePath(input.path);
      if (checked !== resolved) throw new Error(`Path changed during write: ${input.path}`);
      await atomicWrite(checked, input.content);
    });
    const bytes = new TextEncoder().encode(input.content).byteLength;
    return `Wrote ${bytes} bytes to ${input.path}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function editFileTool(
  workspace: Workspace,
  input: { readonly path: string; readonly old_text: string; readonly new_text: string },
): Promise<string> {
  try {
    return await withFileLock(workspace, input.path, async (resolved) => {
      const checked = await workspace.safePath(input.path);
      if (checked !== resolved) throw new Error(`Path changed during edit: ${input.path}`);
      const current = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(resolved));
      if (!current.includes(input.old_text)) {
        return `Error: text not found in ${input.path}`;
      }
      const next = current.replace(input.old_text, () => input.new_text);
      await atomicWrite(resolved, next);
      return `Edited ${input.path}`;
    });
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
