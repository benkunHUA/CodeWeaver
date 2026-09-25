import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_TIMEOUT_MS, OUTPUT_LIMIT, runBash, sliceCharacters } from "../src/bash.js";
import { createWorkspace } from "../src/workspace.js";
import { TODO_STATUSES } from "../src/planning/index.js";
import { SkillLoader } from "../src/skills/index.js";
import { FileLockRegistry } from "../src/tools/core/FileLockRegistry.js";
import { ToolContext } from "../src/tools/core/ToolContext.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { LoadSkillTool } from "../src/tools/LoadSkillTool.js";
import { TodoWriteTool } from "../src/tools/TodoWriteTool.js";
import { createDefaultTools } from "../src/tools/createDefaultTools.js";

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
    const context = new ToolContext({ workspace, locks: new FileLockRegistry() });
    const registry = new ToolRegistry({ context });
    for (const tool of createDefaultTools()) registry.register(tool);
    await writeFile(join(root, "lines.txt"), Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join("\n"));
    assert.equal(await registry.invoke("read_file", { path: "lines.txt", limit: 2 }), "line1\nline2\n... (3 more lines)");
    assert.equal(await registry.invoke("read_file", { path: "lines.txt", limit: 5 }), ["line1", "line2", "line3", "line4", "line5"].join("\n"));
    assert.match(await registry.invoke("read_file", { path: "missing.txt" }), /^Error: /);
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xff]));
    assert.match(await registry.invoke("read_file", { path: "invalid.txt" }), /^Error: /);
    await writeFile(join(root, "empty.txt"), "");
    assert.equal(await registry.invoke("read_file", { path: "empty.txt" }), "(no output)");
    assert.equal(await registry.invoke("read_file", { path: "lines.txt", limit: 0 }), ["line1", "line2", "line3", "line4", "line5"].join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-2.1/TR-2.3: write_file creates parents, escapes workspace rejected, counts UTF-8 bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-tool-write-"));
  try {
    const workspace = await createWorkspace(root);
    const context = new ToolContext({ workspace, locks: new FileLockRegistry() });
    const registry = new ToolRegistry({ context });
    for (const tool of createDefaultTools()) registry.register(tool);
    assert.equal(await registry.invoke("write_file", { path: "a/b/c.txt", content: "hello\nworld" }), "Wrote 11 bytes to a/b/c.txt");
    assert.equal(await readFile(join(root, "a", "b", "c.txt"), "utf8"), "hello\nworld");
    const content = "🚀🚀";
    assert.equal(await registry.invoke("write_file", { path: "emoji.txt", content }), "Wrote 8 bytes to emoji.txt");
    assert.match(await registry.invoke("write_file", { path: "../outside.txt", content: "nope" }), /^Error: Path escapes workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-2.1: edit_file replaces exactly one occurrence or errors on missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-tool-edit-"));
  try {
    const workspace = await createWorkspace(root);
    const context = new ToolContext({ workspace, locks: new FileLockRegistry() });
    const registry = new ToolRegistry({ context });
    for (const tool of createDefaultTools()) registry.register(tool);
    const seed = "A\nB\nA\nC";
    await writeFile(join(root, "seed.txt"), seed);
    assert.equal(await registry.invoke("edit_file", { path: "seed.txt", old_text: "A", new_text: "X" }), "Edited seed.txt");
    assert.equal(await readFile(join(root, "seed.txt"), "utf8"), "X\nB\nA\nC");
    assert.equal(await registry.invoke("edit_file", { path: "seed.txt", old_text: "ZZZ", new_text: "X" }), "Error: text not found in seed.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-2.4: edit_file concurrency serializes and preserves single-replace semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-edit-concurrent-"));
  try {
    const workspace = await createWorkspace(root);
    const context = new ToolContext({ workspace, locks: new FileLockRegistry() });
    const registry = new ToolRegistry({ context });
    for (const tool of createDefaultTools()) registry.register(tool);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      await writeFile(join(root, "target.txt"), "A\nB\nA\nC");
      const first = registry.invoke("edit_file", { path: "target.txt", old_text: "A", new_text: "X" });
      const second = registry.invoke("edit_file", { path: "target.txt", old_text: "X", new_text: "Y" });
      const third = registry.invoke("edit_file", { path: "target.txt", old_text: "Y", new_text: "Z" });
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
    const context = new ToolContext({ workspace, locks: new FileLockRegistry() });
    const registry = new ToolRegistry({ context });
    for (const tool of createDefaultTools()) registry.register(tool);
    await mkdir(join(root, "nested/deep"), { recursive: true });
    const files = Array.from({ length: 205 }, (_, i) => join(root, `f-${String(i).padStart(3, "0")}.ts`));
    for (const file of files) await writeFile(file, "x");
    await writeFile(join(root, "nested/deep/g.ts"), "x");
    await writeFile(join(root, "README.md"), "x");
    const patternAll = "**/*.ts";
    const result = await registry.invoke("glob", { pattern: patternAll });
    assert.ok(result.includes("... (more matches omitted; narrow the pattern)"));
    assert.equal(result.split("\n").length, 201);
    const small = await registry.invoke("glob", { pattern: "README.md" });
    assert.equal(small, "README.md");
    const noMatch = await registry.invoke("glob", { pattern: "*.missing" });
    assert.equal(noMatch, "(no matches)");
    const escapeLink = join(root, "escape");
    await symlink(root, escapeLink);
    const withEscapes = await registry.invoke("glob", { pattern: "escape/**/*.ts" });
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
    const context = new ToolContext({ workspace, locks: new FileLockRegistry() });
    const registry = new ToolRegistry({ context });
    for (const tool of createDefaultTools()) registry.register(tool);
    await symlink(join(root, "outside"), join(workspace.root, "escape"));
    await symlink(root, join(workspace.root, "escape-dir"));
    for (const path of ["escape", "../outside", "escape-dir/outside"]) {
      assert.match(await registry.invoke("read_file", { path }), /^Error: Path escapes workspace/);
      assert.match(await registry.invoke("write_file", { path, content: "bad" }), /^Error: Path escapes workspace/);
      assert.match(await registry.invoke("edit_file", { path, old_text: "secret", new_text: "bad" }), /^Error: Path escapes workspace/);
    }
    assert.equal(await readFile(join(root, "outside"), "utf8"), "secret");
    await writeFile(join(workspace.root, "script"), "A A");
    await chmod(join(workspace.root, "script"), 0o751);
    await symlink("script", join(workspace.root, "alias"));
    assert.equal(await registry.invoke("write_file", { path: "alias", content: "A A" }), "Wrote 3 bytes to alias");
    assert.equal((await stat(join(workspace.root, "script"))).mode & 0o777, 0o751);
    const results = await Promise.all(["script", "alias"].map((path) =>
      registry.invoke("edit_file", { path, old_text: "A", new_text: "$&" })));
    assert.ok(results.every((result) => result.startsWith("Edited")));
    assert.equal(await readFile(join(workspace.root, "script"), "utf8"), "$& $&");
    assert.match(await registry.invoke("edit_file", { path: "missing", old_text: "a", new_text: "b" }), /^Error: /);
    assert.match(await registry.invoke("write_file", { path: "script/child", content: "x" }), /^Error: /);
    await mkdir(join(workspace.root, "directory"));
    assert.match(await registry.invoke("write_file", { path: "directory", content: "x" }), /^Error: /);
    assert.ok((await readdir(workspace.root)).every((name) => !name.startsWith(".codeweaver-")));
    assert.equal(await registry.invoke("glob", { pattern: "escape*" }), "(no matches)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("glob supports classes, question marks, recursive suffixes and explicit hidden paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-glob-pattern-"));
  try {
    const workspace = await createWorkspace(root);
    const context = new ToolContext({ workspace, locks: new FileLockRegistry() });
    const registry = new ToolRegistry({ context });
    for (const tool of createDefaultTools()) registry.register(tool);
    await mkdir(join(root, "nested/deep"), { recursive: true });
    await mkdir(join(root, ".hidden"));
    for (const name of ["a.ts", "b.ts", "c.js", "[.txt", ".secret.ts", "nested/deep/a.ts", ".hidden/h.ts"]) {
      await writeFile(join(root, name), "");
    }
    assert.equal(await registry.invoke("glob", { pattern: "[a-b].ts" }), "a.ts\nb.ts");
    assert.equal(await registry.invoke("glob", { pattern: "[!b].ts" }), "a.ts");
    assert.equal(await registry.invoke("glob", { pattern: "?.js" }), "c.js");
    assert.equal(await registry.invoke("glob", { pattern: "[.txt" }), "[.txt");
    assert.equal(await registry.invoke("glob", { pattern: "**/*.ts" }), "a.ts\nb.ts\nnested/deep/a.ts");
    assert.equal(await registry.invoke("glob", { pattern: ".*.ts" }), ".secret.ts");
    assert.equal(await registry.invoke("glob", { pattern: ".hidden/*.ts" }), ".hidden/h.ts");
    assert.equal(await registry.invoke("glob", { pattern: "nested/**" }), "nested\nnested/deep\nnested/deep/a.ts");
    assert.equal(await registry.invoke("glob", { pattern: "nested/*/" }), "nested/deep/");
    assert.match(await registry.invoke("glob", { pattern: "../*" }), /^Error: Path escapes workspace/);
    assert.match(await registry.invoke("glob", { pattern: "/etc/*" }), /^Error: Path escapes workspace/);
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
    const workspace = await createWorkspace(join(root, "inside"));
    const context = new ToolContext({ workspace, locks: new FileLockRegistry() });
    const registry = new ToolRegistry({ context });
    for (const tool of createDefaultTools()) registry.register(tool);
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
    const context = new ToolContext({ workspace, locks: new FileLockRegistry() });
    const registry = new ToolRegistry({ context });
    for (const tool of createDefaultTools()) registry.register(tool);
    for (const name of ["a.ts", "\u{1f680}.ts", "[.txt", "].txt", "(.txt", "^.txt"]) {
      await writeFile(join(root, name), "");
    }
    assert.equal(await registry.invoke("glob", { pattern: "?.ts" }), "a.ts\n\u{1f680}.ts");
    assert.equal(await registry.invoke("glob", { pattern: "[\u{1f680}].ts" }), "\u{1f680}.ts");
    assert.equal(await registry.invoke("glob", { pattern: "[!\u{1f680}].ts" }), "a.ts");
    assert.equal(await registry.invoke("glob", { pattern: "[a-\u{1f680}].ts" }), "a.ts\n\u{1f680}.ts");
    for (const pattern of ["[.txt", "].txt", "(.txt", "^.txt"]) {
      assert.equal(await registry.invoke("glob", { pattern }), pattern);
    }
    assert.equal(await registry.invoke("glob", { pattern: "[[].txt" }), "[.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TR-2.6: registry invoke normalizes all errors into strings", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-tool-robust-"));
  try {
    const logs: string[] = [];
    const logger = (message: string) => logs.push(message);
    const workspace = await createWorkspace(root);
    const context = new ToolContext({ workspace, locks: new FileLockRegistry(), logger });
    const registry = new ToolRegistry({
      context,
      logger,
      hooks: {
        before() {
          throw new Error("before boom");
        },
        after() {
          throw new Error("after boom");
        },
      },
    });
    for (const tool of createDefaultTools()) registry.register(tool);
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

test("TR-2.5: todo_write declares the s05 schema, renders and reports domain errors", async () => {
  // The declarative keywords (maxItems/enum/properties/required) are part of the
  // model-facing schema and are pinned verbatim against the s05 tool list.
  assert.deepEqual(new TodoWriteTool().inputSchema, {
    type: "object",
    properties: {
      todos: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1 },
            status: { type: "string", enum: [...TODO_STATUSES] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  });
  const schema = new TodoWriteTool().toAnthropicSchema();
  assert.equal(schema.name, "todo_write");
  assert.equal(schema.description, "创建并管理当前编码会话的任务列表。");

  const root = await mkdtemp(join(tmpdir(), "cw-tool-todo-"));
  try {
    const workspace = await createWorkspace(root);
    const context = new ToolContext({ workspace, locks: new FileLockRegistry() });
    const registry = new ToolRegistry({ context });
    for (const tool of createDefaultTools()) registry.register(tool);

    assert.deepEqual(
      registry.list().map((tool) => tool.name),
      ["bash", "read_file", "write_file", "edit_file", "glob", "todo_write", "load_skill", "compact"],
    );

    assert.equal(
      await registry.invoke("todo_write", {
        todos: [{ content: "a", status: "pending" }, { content: "b", status: "in_progress" }],
      }),
      "[ ] a\n[>] b\n\n(0/2 completed)",
    );

    // Consecutive calls share the context store, and each call replaces the whole list.
    assert.equal(
      await registry.invoke("todo_write", { todos: [{ content: "a", status: "pending" }] }),
      "[ ] a\n\n(0/1 completed)",
    );
    assert.equal(
      await registry.invoke("todo_write", {
        todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }],
      }),
      "[x] a\n[ ] b\n\n(1/2 completed)",
    );
    assert.deepEqual(registry.context.todos.list.items, [
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
    ]);

    // A second context owns an independent store.
    const otherContext = new ToolContext({ workspace, locks: new FileLockRegistry() });
    const otherRegistry = new ToolRegistry({ context: otherContext });
    for (const tool of createDefaultTools()) otherRegistry.register(tool);
    assert.notEqual(registry.context.todos, otherContext.todos);
    assert.equal(
      await otherRegistry.invoke("todo_write", { todos: [{ content: "z", status: "pending" }] }),
      "[ ] z\n\n(0/1 completed)",
    );
    assert.equal(otherContext.todos.list.render(), "[ ] z\n\n(0/1 completed)");
    assert.equal(registry.context.todos.list.render(), "[x] a\n[ ] b\n\n(1/2 completed)");

    // Domain errors win over the declarative schema keywords: the generic
    // validator ignores maxItems/enum/required nested inside one item.
    const tooMany = Array.from({ length: 21 }, (_, index) => ({ content: `t${index}`, status: "pending" }));
    assert.equal(await registry.invoke("todo_write", { todos: tooMany }), "Error: Max 20 todos allowed");
    assert.equal(
      await registry.invoke("todo_write", { todos: [{ content: "a", status: "done" }] }),
      "Error: todos[0] has invalid status 'done'",
    );
    assert.equal(
      await registry.invoke("todo_write", { todos: [{ content: "", status: "pending" }] }),
      "Error: todos[0] requires content",
    );
    assert.equal(
      await registry.invoke("todo_write", {
        todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }],
      }),
      "Error: Only one todo can be in_progress at a time",
    );
    assert.deepEqual(registry.context.todos.list.items, [
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
    ]);

    // Only the top-level shape is enforced by the shared validator.
    assert.equal(
      await registry.invoke("todo_write", { todos: "not-an-array" }),
      "Error: Invalid input for todo_write: todo_write.todos must be array",
    );
    assert.equal(await registry.invoke("todo_write", {}), "Error: Invalid input for todo_write: todos is required");

    // Content is trimmed, statuses are compared case-insensitively.
    assert.equal(
      await registry.invoke("todo_write", { todos: [{ content: "  pad  ", status: "PENDING" }] }),
      "[ ] pad\n\n(0/1 completed)",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load_skill declares a verbatim schema with a Chinese description", () => {
  const tool = new LoadSkillTool();
  assert.deepEqual(tool.inputSchema, {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  });
  const schema = tool.toAnthropicSchema();
  assert.equal(schema.name, "load_skill");
  assert.equal(schema.description, "按名称读取某个技能的完整说明（SKILL.md）。");
  assert.deepEqual(schema.input_schema, {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  });
});

test("load_skill rejects a call without a name", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-tool-skill-input-"));
  try {
    const workspace = await createWorkspace(root);
    const context = new ToolContext({ workspace, locks: new FileLockRegistry() });
    const registry = new ToolRegistry({ context });
    for (const tool of createDefaultTools()) registry.register(tool);
    assert.equal(
      await registry.invoke("load_skill", {}),
      "Error: Invalid input for load_skill: name is required",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load_skill forwards the requested name to the injected library", async () => {
  const received: string[] = [];
  const skills = {
    catalog: () => "- code-review: reviews code",
    load: (name: string): string => {
      received.push(name);
      return `SKILL(${name})`;
    },
  };
  const root = await mkdtemp(join(tmpdir(), "cw-tool-skill-fake-"));
  try {
    const workspace = await createWorkspace(root);
    const context = new ToolContext({ workspace, locks: new FileLockRegistry(), skills });
    const registry = new ToolRegistry({ context });
    registry.register(new LoadSkillTool());
    assert.equal(await registry.invoke("load_skill", { name: "code-review" }), "SKILL(code-review)");
    assert.deepEqual(received, ["code-review"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load_skill fails closed when the context has no skill library", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-tool-skill-none-"));
  try {
    const workspace = await createWorkspace(root);
    const context = new ToolContext({ workspace, locks: new FileLockRegistry() });
    assert.equal(context.skills, undefined);
    const registry = new ToolRegistry({ context });
    registry.register(new LoadSkillTool());
    // The failure is reported as an error string; `invoke` never throws.
    assert.equal(
      await registry.invoke("load_skill", { name: "demo" }),
      "Error: Skill loading is not available in this context",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createDefaultTools returns the eight built-in tools in order", () => {
  assert.deepEqual(
    createDefaultTools().map((tool) => tool.name),
    ["bash", "read_file", "write_file", "edit_file", "glob", "todo_write", "load_skill", "compact"],
  );
});

test("load_skill serves the full SKILL.md text through a real SkillLoader", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-tool-skill-real-"));
  try {
    const skillDir = join(root, "skills");
    await mkdir(join(skillDir, "demo"), { recursive: true });
    const content = "---\nname: demo\ndescription: A demo skill\n---\n\n# Demo\n\nBody text.\n";
    await writeFile(join(skillDir, "demo", "SKILL.md"), content);
    const skills = await SkillLoader.scan({ dir: skillDir });
    const workspace = await createWorkspace(root);
    const context = new ToolContext({ workspace, locks: new FileLockRegistry(), skills });
    const registry = new ToolRegistry({ context });
    registry.register(new LoadSkillTool());
    // The raw document, frontmatter included, round-trips unchanged.
    assert.equal(await registry.invoke("load_skill", { name: "demo" }), content);
    assert.equal(
      await registry.invoke("load_skill", { name: "nope" }),
      "Error: Unknown skill 'nope'. Available: demo",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
