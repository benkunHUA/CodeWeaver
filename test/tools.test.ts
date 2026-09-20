import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_TIMEOUT_MS, OUTPUT_LIMIT, runBash, sliceCharacters } from "../src/bash.js";
import { createWorkspace } from "../src/workspace.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { editFileTool, readFileTool, writeFileTool } from "../src/tools/fileTools.js";
import { globTool } from "../src/tools/globTool.js";

export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function nodeCommand(source: string): string {
  return `${quote(process.execPath)} -e ${quote(source)}`;
}

test("TR-2.1: bash success/failure/empty states remain stable", async () => {
  assert.equal(await runBash("printf hello | tr a-z A-Z"), "HELLO");
  assert.equal(await runBash("exit 3"), "(no output)");
  assert.equal(await runBash("sudo true"), "Error: Dangerous command blocked");
});

test("TR-2.1/TR-2.2: read_file handles limit, missing file and binary decode errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-tool-read-"));
  try {
    const workspace = await createWorkspace(root);
    await writeFile(join(root, "lines.txt"), Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join("\n"));
    assert.equal(await readFileTool(workspace, { path: "lines.txt", limit: 2 }), "line1\nline2\n... (3 more lines)");
    assert.equal(await readFileTool(workspace, { path: "lines.txt", limit: 5 }), ["line1", "line2", "line3", "line4", "line5"].join("\n"));
    assert.match(await readFileTool(workspace, { path: "missing.txt" }), /^Error: /);
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xff]));
    assert.match(await readFileTool(workspace, { path: "invalid.txt" }), /^Error: /);
    await writeFile(join(root, "empty.txt"), "");
    assert.equal(await readFileTool(workspace, { path: "empty.txt" }), "(no output)");
    assert.equal(await readFileTool(workspace, { path: "lines.txt", limit: 0 }), ["line1", "line2", "line3", "line4", "line5"].join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-2.1/TR-2.3: write_file creates parents, escapes workspace rejected, counts UTF-8 bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-tool-write-"));
  try {
    const workspace = await createWorkspace(root);
    assert.equal(await writeFileTool(workspace, { path: "a/b/c.txt", content: "hello\nworld" }), "Wrote 11 bytes to a/b/c.txt");
    assert.equal(await readFile(join(root, "a", "b", "c.txt"), "utf8"), "hello\nworld");
    const content = "🚀🚀";
    assert.equal(await writeFileTool(workspace, { path: "emoji.txt", content }), "Wrote 8 bytes to emoji.txt");
    assert.match(await writeFileTool(workspace, { path: "../outside.txt", content: "nope" }), /^Error: Path escapes workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-2.1: edit_file replaces exactly one occurrence or errors on missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-tool-edit-"));
  try {
    const workspace = await createWorkspace(root);
    const seed = "A\nB\nA\nC";
    await writeFile(join(root, "seed.txt"), seed);
    assert.equal(await editFileTool(workspace, { path: "seed.txt", old_text: "A", new_text: "X" }), "Edited seed.txt");
    assert.equal(await readFile(join(root, "seed.txt"), "utf8"), "X\nB\nA\nC");
    assert.equal(await editFileTool(workspace, { path: "seed.txt", old_text: "ZZZ", new_text: "X" }), "Error: text not found in seed.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-2.4: edit_file concurrency serializes and preserves single-replace semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-edit-concurrent-"));
  try {
    const workspace = await createWorkspace(root);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      await writeFile(join(root, "target.txt"), "A\nB\nA\nC");
      const first = editFileTool(workspace, { path: "target.txt", old_text: "A", new_text: "X" });
      const second = editFileTool(workspace, { path: "target.txt", old_text: "X", new_text: "Y" });
      const third = editFileTool(workspace, { path: "target.txt", old_text: "Y", new_text: "Z" });
      const results = await Promise.all([first, second, third]);
      assert.deepEqual(results, ["Edited target.txt", "Edited target.txt", "Edited target.txt"]);
      assert.equal(await readFile(join(root, "target.txt"), "utf8"), "Z\nB\nA\nC");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-2.1/TR-2.5: glob orders, dedupes, caps and filters safe paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-tool-glob-"));
  try {
    const workspace = await createWorkspace(root);
    await mkdir(join(root, "nested/deep"), { recursive: true });
    const files = Array.from({ length: 205 }, (_, i) => join(root, `f-${String(i).padStart(3, "0")}.ts`));
    for (const file of files) await writeFile(file, "x");
    await writeFile(join(root, "nested/deep/g.ts"), "x");
    await writeFile(join(root, "README.md"), "x");
    const patternAll = "**/*.ts";
    const result = await globTool(workspace, { pattern: patternAll });
    assert.ok(result.includes("... (more matches omitted; narrow the pattern)"));
    assert.equal(result.split("\n").length, 201);
    const small = await globTool(workspace, { pattern: "README.md" });
    assert.equal(small, "README.md");
    const noMatch = await globTool(workspace, { pattern: "*.missing" });
    assert.equal(noMatch, "(no matches)");
    const escapeLink = join(root, "escape");
    await symlink(root, escapeLink);
    const withEscapes = await globTool(workspace, { pattern: "escape/**/*.ts" });
    assert.equal(withEscapes, "(no matches)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file tools reject outside links, preserve internal links and modes, and clean temporary writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-atomic-"));
  try {
    await mkdir(join(root, "inside"));
    await writeFile(join(root, "outside"), "secret");
    const workspace = await createWorkspace(join(root, "inside"));
    await symlink(join(root, "outside"), join(workspace.root, "escape"));
    await symlink(root, join(workspace.root, "escape-dir"));
    for (const path of ["escape", "../outside", "escape-dir/outside"]) {
      assert.match(await readFileTool(workspace, { path }), /^Error: Path escapes workspace/);
      assert.match(await writeFileTool(workspace, { path, content: "bad" }), /^Error: Path escapes workspace/);
      assert.match(await editFileTool(workspace, { path, old_text: "secret", new_text: "bad" }), /^Error: Path escapes workspace/);
    }
    assert.equal(await readFile(join(root, "outside"), "utf8"), "secret");
    await writeFile(join(workspace.root, "script"), "A A");
    await chmod(join(workspace.root, "script"), 0o751);
    await symlink("script", join(workspace.root, "alias"));
    assert.equal(await writeFileTool(workspace, { path: "alias", content: "A A" }), "Wrote 3 bytes to alias");
    assert.equal((await stat(join(workspace.root, "script"))).mode & 0o777, 0o751);
    const results = await Promise.all(["script", "alias"].map((path) =>
      editFileTool(workspace, { path, old_text: "A", new_text: "$&" })));
    assert.ok(results.every((result) => result.startsWith("Edited")));
    assert.equal(await readFile(join(workspace.root, "script"), "utf8"), "$& $&");
    assert.match(await editFileTool(workspace, { path: "missing", old_text: "a", new_text: "b" }), /^Error: /);
    assert.match(await writeFileTool(workspace, { path: "script/child", content: "x" }), /^Error: /);
    await mkdir(join(workspace.root, "directory"));
    assert.match(await writeFileTool(workspace, { path: "directory", content: "x" }), /^Error: /);
    assert.ok((await readdir(workspace.root)).every((name) => !name.startsWith(".codeweaver-")));
    assert.equal(await globTool(workspace, { pattern: "escape*" }), "(no matches)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("glob supports classes, question marks, recursive suffixes and explicit hidden paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-glob-pattern-"));
  try {
    const workspace = await createWorkspace(root);
    await mkdir(join(root, "nested/deep"), { recursive: true });
    await mkdir(join(root, ".hidden"));
    for (const name of ["a.ts", "b.ts", "c.js", "[.txt", ".secret.ts", "nested/deep/a.ts", ".hidden/h.ts"]) {
      await writeFile(join(root, name), "");
    }
    assert.equal(await globTool(workspace, { pattern: "[a-b].ts" }), "a.ts\nb.ts");
    assert.equal(await globTool(workspace, { pattern: "[!b].ts" }), "a.ts");
    assert.equal(await globTool(workspace, { pattern: "?.js" }), "c.js");
    assert.equal(await globTool(workspace, { pattern: "[.txt" }), "[.txt");
    assert.equal(await globTool(workspace, { pattern: "**/*.ts" }), "a.ts\nb.ts\nnested/deep/a.ts");
    assert.equal(await globTool(workspace, { pattern: ".*.ts" }), ".secret.ts");
    assert.equal(await globTool(workspace, { pattern: ".hidden/*.ts" }), ".hidden/h.ts");
    assert.equal(await globTool(workspace, { pattern: "nested/**" }), "nested\nnested/deep\nnested/deep/a.ts");
    assert.equal(await globTool(workspace, { pattern: "nested/*/" }), "nested/deep/");
    assert.match(await globTool(workspace, { pattern: "../*" }), /^Error: Path escapes workspace/);
    assert.match(await globTool(workspace, { pattern: "/etc/*" }), /^Error: Path escapes workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-I-1.1: initialized workspace rejects a replaced root before outside I/O", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-root-replaced-"));
  try {
    await mkdir(join(root, "inside"));
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "secret"), "secret");
    const registry = await createDefaultRegistry({ root: join(root, "inside") });
    await rename(join(root, "inside"), join(root, "original"));
    await symlink(join(root, "outside"), join(root, "inside"));
    for (const [name, input] of [
      ["read_file", { path: "secret" }],
      ["write_file", { path: "secret", content: "bad" }],
      ["edit_file", { path: "secret", old_text: "secret", new_text: "bad" }],
      ["glob", { pattern: "*" }],
    ] as const) {
      assert.match(await registry.invoke(name, input), /^Error: Workspace root changed/);
    }
    assert.equal(await readFile(join(root, "outside", "secret"), "utf8"), "secret");
    assert.deepEqual(await readdir(join(root, "outside")), ["secret"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-I-3.1: glob question marks and classes match Unicode code points", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-glob-unicode-"));
  try {
    const workspace = await createWorkspace(root);
    for (const name of ["a.ts", "\u{1f680}.ts", "[.txt", "].txt", "(.txt", "^.txt"]) {
      await writeFile(join(root, name), "");
    }
    assert.equal(await globTool(workspace, { pattern: "?.ts" }), "a.ts\n\u{1f680}.ts");
    assert.equal(await globTool(workspace, { pattern: "[\u{1f680}].ts" }), "\u{1f680}.ts");
    assert.equal(await globTool(workspace, { pattern: "[!\u{1f680}].ts" }), "a.ts");
    assert.equal(await globTool(workspace, { pattern: "[a-\u{1f680}].ts" }), "a.ts\n\u{1f680}.ts");
    for (const pattern of ["[.txt", "].txt", "(.txt", "^.txt"]) {
      assert.equal(await globTool(workspace, { pattern }), pattern);
    }
    assert.equal(await globTool(workspace, { pattern: "[[].txt" }), "[.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-2.6: registry invoke normalizes all errors into strings", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-tool-robust-"));
  try {
    const logs: string[] = [];
    const registry = await createDefaultRegistry({
      root,
      logger: (message) => logs.push(message),
      hooks: {
        before() {
          throw new Error("before boom");
        },
        after() {
          throw new Error("after boom");
        },
      },
    });
    const command = await registry.invoke("bash", {});
    assert.match(command, /^Error: Invalid input for bash/);
    const readMissing = await registry.invoke("read_file", { path: "nope.txt" });
    assert.match(readMissing, /^Error: /);
    const unknown = await registry.invoke("nothing", { x: 1 });
    assert.equal(unknown, "Unknown: nothing");
    assert.match(logs.join("\n"), /hook error: bash before failed: before boom/);
    assert.match(logs.join("\n"), /hook error: read_file after failed: after boom/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-2.1: bash timeout and error formatting remain aligned with s01", async () => {
  assert.equal(COMMAND_TIMEOUT_MS, 120_000);
  assert.equal(
    await runBash(`exec ${nodeCommand("setInterval(() => {}, 1000)")}`, { timeoutMs: 100 }),
    "Error: Timeout (0.1s)",
  );
  assert.equal(sliceCharacters("abcdef", 3), "abc");
  assert.equal(OUTPUT_LIMIT, 50_000);
});
