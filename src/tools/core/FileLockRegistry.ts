import { resolve } from "node:path";
import type { Workspace } from "../../types.js";

/**
 * Instance-scoped replacement for the previous module-level `editLocks` map:
 * the same serialization guarantees without global mutable state.
 */
export class FileLockRegistry {
  #locks = new Map<string, Promise<unknown>>();

  /** Serialize work sharing one key. */
  withLock<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    // A failed predecessor must not block the next waiter.
    const next = previous.then(body, body);
    const awaited = next.then(
      (value) => {
        if (this.#locks.get(key) === awaited) this.#locks.delete(key);
        return value;
      },
      (error) => {
        if (this.#locks.get(key) === awaited) this.#locks.delete(key);
        throw error;
      },
    );
    this.#locks.set(key, awaited);
    return awaited as Promise<T>;
  }

  /**
   * Two-level serialization preserved from the previous implementation:
   * first the *requested* path (so equal request paths cannot reorder while
   * `safePath` awaits), then the resolved real path (so symlink aliases to the
   * same file still serialize).
   */
  withFileLock<T>(workspace: Workspace, requestedPath: string, body: (resolved: string) => Promise<T>): Promise<T> {
    // Queue equal request paths before async realpath can reorder their arrival.
    return this.withLock(`request:${resolve(workspace.root, requestedPath)}`, async () => {
      const resolved = await workspace.safePath(requestedPath);
      return this.withLock(resolved, () => body(resolved));
    });
  }
}
