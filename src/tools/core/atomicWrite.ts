import { chmod, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Replace `target` in one step so readers never observe a partial write. */
export async function atomicWrite(target: string, content: string): Promise<void> {
  const metadata = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (metadata && !metadata.isFile()) throw new Error(`Not a regular file: ${target}`);
  // Keep temporary content on the destination filesystem for atomic rename.
  const directory = await mkdtemp(join(dirname(target), ".codeweaver-"));
  const temporary = join(directory, "content");
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (metadata) await chmod(temporary, metadata.mode & 0o777);
    await rename(temporary, target);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
