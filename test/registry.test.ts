import assert from "node:assert/strict";
import test from "node:test";
import { symlink, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolRegistry } from "../src/tools/registry.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { createWorkspace, safeWorkspacePath } from "../src/workspace.js";
import type { ToolDefinition } from "../src/types.js";

type AnyToolDefinition = ToolDefinition;

const noopDefinition: AnyToolDefinition = {
  name: "bash",
  schema: {
    name: "bash",
    description: "noop",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  handler: async (input) => `ok:${(input as { readonly command: string }).command}`,
};

const readDefinition: AnyToolDefinition = {
  name: "read_file",
  schema: {
    name: "read_file",
    description: "noop",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1 } },
      required: ["path"],
    },
  },
  handler: async (input) => {
    const shape = input as { readonly path: string; readonly limit?: number };
    return `read:${shape.path}:${shape.limit ?? "none"}`;
  },
};

test("TR-1.1: listTools & getSchemas expose five-tool shape", async () => {
  const registry = await createDefaultRegistry();
  assert.deepEqual(
    registry.listTools().map((tool) => tool.name),
    ["bash", "read_file", "write_file", "edit_file", "glob"],
  );
  const schemas = registry.getSchemas();
  assert.equal(schemas.length, 5);
  for (const schema of schemas) {
    assert.ok(schema.name);
    assert.ok(schema.description);
    assert.equal(schema.input_schema?.type, "object");
    assert.ok("required" in schema.input_schema);
  }
});

test("TR-1.2: invalid input returns Error without throwing", async () => {
  const registry = createToolRegistry([noopDefinition, readDefinition]);
  assert.equal(
    await registry.invoke("bash", {}),
    "Error: Invalid input for bash: command is required",
  );
  assert.equal(
    await registry.invoke("bash", { command: 42 }),
    "Error: Invalid input for bash: bash.command must be string",
  );
  assert.equal(
    await registry.invoke("read_file", { path: "a", limit: -5 }),
    "Error: Invalid input for read_file: read_file.limit must be >= 1",
  );
  const hookCalls: Array<{ phase: string; name: string }> = [];
  const registryWithHooks = createToolRegistry([readDefinition], {
    hooks: {
      before: (ctx) => {
        hookCalls.push({ phase: "before", name: ctx.name });
      },
      after: (ctx) => {
        hookCalls.push({ phase: "after", name: ctx.name, result: ctx.result } as never);
      },
    },
  });
  assert.match(
    await registryWithHooks.invoke("read_file", {}),
    /^Error: Invalid input for read_file: /,
  );
  assert.deepEqual(hookCalls.map((call) => call.phase), ["before", "after"]);
});

test("TR-1.4: hooks always fire and hook failures are isolated", async () => {
  const logs: string[] = [];
  const registry = createToolRegistry([noopDefinition], {
    logger: (message) => logs.push(message),
    hooks: {
      before() {
        throw new Error("boom before");
      },
      after() {
        throw new Error("boom after");
      },
    },
  });
  assert.equal(await registry.invoke("bash", { command: "echo hi" }), "ok:echo hi");
  assert.match(logs.join("\n"), /hook error: bash before failed: boom before/);
  assert.match(logs.join("\n"), /hook error: bash after failed: boom after/);
  const durations: number[] = [];
  await createToolRegistry([noopDefinition], {
    hooks: {
      after(ctx) {
        durations.push(ctx.durationMs);
      },
    },
  }).invoke("bash", { command: "x" });
  assert.equal(durations.length, 1);
  for (const duration of durations) {
    assert.ok(duration >= 0);
  }
});

test("registry snapshots isolate schemas, definitions and hook inputs", async () => {
  const definition = { ...noopDefinition, schema: structuredClone(noopDefinition.schema) };
  const definitions = [definition];
  const registry = createToolRegistry(definitions, {
    hooks: { before(ctx) {
      if (typeof ctx.input === "object" && ctx.input !== null) Object.assign(ctx.input, { command: 9 });
    } },
  });
  definition.schema.input_schema.required = ["oops"];
  definitions.pop();
  registry.getSchemas()[0]!.input_schema.required = ["oops"];
  registry.listTools()[0]!.schema.input_schema.required = ["oops"];
  assert.equal(await registry.invoke("bash", { command: "valid" }), "ok:valid");
  assert.equal(registry.listTools().length, 1);
  assert.equal(typeof registry.getHandler("bash"), "function");
  assert.equal(registry.getHandler("missing"), undefined);
  assert.throws(() => createToolRegistry([noopDefinition, noopDefinition]), /Duplicate/);
  assert.throws(() => createToolRegistry([{ ...noopDefinition, schema: { ...noopDefinition.schema, name: "wrong" } }]), /mismatch/);
});

test("registry normalizes results and audits unknown, invalid, success and failure calls", async () => {
  const events: Array<{ name: string; phase: string; result?: string }> = [];
  const noop: ToolDefinition<string> = {
    name: "noop",
    schema: { name: "noop", input_schema: { type: "object", properties: { text: { type: "string", minLength: 1 } }, required: ["text"] } },
    handler: async (raw) => {
      const { text } = raw as { text: string };
      if (text === "throw") throw new Error("handler failed");
      if (text === "empty") return "";
      return "\u{1f680}".repeat(50_001);
    },
  };
  const registry = createToolRegistry([noop], {
    hooks: {
      before: ({ name }) => { events.push({ name, phase: "before" }); },
      after: ({ name, result, durationMs }) => {
        assert.ok(Number.isFinite(durationMs) && durationMs >= 0);
        events.push({ name, phase: "after", result });
      },
    },
  });
  for (const [name, input, expected] of [
    ["missing", {}, "Unknown: missing"],
    ["noop", { text: "" }, "Error: Invalid input for noop: noop.text must have at least 1 characters"],
    ["noop", { text: "throw" }, "Error: handler failed"],
    ["noop", { text: "empty" }, "(no output)"],
    ["noop", { text: "large" }, "\u{1f680}".repeat(50_000)],
  ] as const) {
    assert.equal(await registry.invoke(name, input), expected);
    assert.deepEqual(events.splice(0), [{ name, phase: "before" }, { name, phase: "after", result: expected }]);
  }
  const throwingLogger = createToolRegistry([noopDefinition], {
    logger: () => { throw new Error("logger failed"); },
    hooks: { before: () => { throw new Error("before failed"); }, after: () => { throw new Error("after failed"); } },
  });
  assert.equal(await throwingLogger.invoke("bash", { command: "ok" }), "ok:ok");
  assert.equal(await throwingLogger.invoke("missing", {}), "Unknown: missing");
});

test("TR-I-2.1: every public handler access preserves registry guarantees", async () => {
  const events: string[] = [];
  const registry = createToolRegistry([{
    name: "noop",
    schema: { name: "noop", input_schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
    handler: async (raw: unknown) => {
      const { text } = raw as { text: string };
      if (text === "throw") throw new Error("failed");
      return text === "empty" ? "" : "x".repeat(50_001);
    },
  }], {
    hooks: {
      before: () => { events.push("before"); },
      after: () => { events.push("after"); },
    },
  });
  const handlers = [
    (input: unknown) => registry.invoke("noop", input),
    registry.getHandler("noop")!,
    registry.listTools()[0]!.handler as (input: unknown) => Promise<string>,
  ];
  for (const handler of handlers) {
    for (const [input, expected] of [
      [{}, "Error: Invalid input for noop: text is required"],
      [{ text: "throw" }, "Error: failed"],
      [{ text: "empty" }, "(no output)"],
      [{ text: "large" }, "x".repeat(50_000)],
    ] as const) {
      assert.equal(await handler(input), expected);
      assert.deepEqual(events.splice(0), ["before", "after"]);
    }
  }
});

await test("TR-1.3: safeWorkspacePath rejects escapes via .. and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-ws-"));
  const inside = join(root, "inside");
  await mkdir(inside);
  const workspace = await createWorkspace(inside);
  const workspaceRoot = workspace.root;
  const outsidePath = join(workspaceRoot, "..", "outside.tmp");
  const innerLink = join(workspaceRoot, "etc-passwd");
  await writeFile(outsidePath, "secret");
  await writeFile(join(root, "sibling.tmp"), "sibling");
  try {
    await mkdir(join(workspaceRoot, "nested"));
    await writeFile(join(workspaceRoot, "nested", "a.txt"), "hello");
    await symlink("/etc/passwd", innerLink);
    await assert.rejects(safeWorkspacePath(inside, "../outside.tmp"), /Path escapes workspace/);
    await assert.rejects(workspace.safePath("nested/../../outside.tmp"), /Path escapes workspace/);
    await assert.rejects(workspace.safePath("../sibling.tmp"), /Path escapes workspace/);
    await assert.rejects(workspace.safePath("etc-passwd"), /Path escapes workspace/);
    await assert.rejects(workspace.safePath("/etc/passwd"), /Path escapes workspace/);
    assert.equal(await workspace.safePath("./nested/./a.txt"), join(workspaceRoot, "nested", "a.txt"));
    assert.equal(await workspace.safePath("a/b/c/new.txt"), join(workspaceRoot, "a/b/c/new.txt"));
    assert.equal(await workspace.safePath("."), workspaceRoot);
    await symlink(join(workspaceRoot, "nested"), join(workspaceRoot, "link"));
    assert.equal(await workspace.safePath("link/a.txt"), join(workspaceRoot, "nested/a.txt"));
    await rm(join(workspaceRoot, "link"));
    await symlink(join(workspaceRoot, ".."), join(workspaceRoot, "link"));
    await assert.rejects(workspace.safePath("link/outside.tmp"), /Path escapes workspace/);
    await assert.rejects(workspace.safePath("link/not/created/yet"), /Path escapes workspace/);
    await symlink(join(workspaceRoot, "..", "missing"), join(workspaceRoot, "dangling"));
    await assert.rejects(workspace.safePath("dangling/new"), /symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
