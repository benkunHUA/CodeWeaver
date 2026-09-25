import assert from "node:assert/strict";
import test from "node:test";
import { symlink, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tool } from "../src/tools/core/Tool.js";
import type { JsonSchemaObject } from "../src/tools/core/validate.js";
import { ToolContext } from "../src/tools/core/ToolContext.js";
import { FileLockRegistry } from "../src/tools/core/FileLockRegistry.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { createDefaultTools } from "../src/tools/createDefaultTools.js";
import { createWorkspace, safeWorkspacePath } from "../src/workspace.js";
import type { AnthropicTool, ToolHooks } from "../src/types.js";

const workspace = await createWorkspace();
const context = new ToolContext({ workspace, locks: new FileLockRegistry() });

/** Mirrors the removed `createToolRegistry` factory: registers the tools in order. */
function registryOf(
  tools: readonly Tool<unknown>[],
  options: { readonly hooks?: ToolHooks; readonly logger?: (message: string) => void } = {},
): ToolRegistry {
  const registry = new ToolRegistry({ context, hooks: options.hooks, logger: options.logger });
  for (const tool of tools) registry.register(tool);
  return registry;
}

class BashStubTool extends Tool<{ command: string }> {
  readonly name = "bash";
  readonly description = "noop";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  };

  protected async run(input: { command: string }): Promise<string> {
    return `ok:${input.command}`;
  }
}

class ReadFileStubTool extends Tool<{ path: string; limit?: number }> {
  readonly name = "read_file";
  readonly description = "noop";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1 } },
    required: ["path"],
  };

  protected async run(input: { path: string; limit?: number }): Promise<string> {
    return `read:${input.path}:${input.limit ?? "none"}`;
  }
}

/** Only exists so the registry's schema/name mismatch guard stays observable. */
class MismatchedSchemaTool extends BashStubTool {
  override toAnthropicSchema(): AnthropicTool {
    return { ...super.toAnthropicSchema(), name: "wrong" };
  }
}

test("TR-1.1: listTools & getSchemas expose eight-tool shape", async () => {
  const registry = registryOf(createDefaultTools());
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ["bash", "read_file", "write_file", "edit_file", "glob", "todo_write", "load_skill", "compact"],
  );
  const schemas = registry.schemas();
  assert.equal(schemas.length, 8);
  for (const schema of schemas) {
    assert.ok(schema.name);
    assert.ok(schema.description);
    assert.equal(schema.input_schema?.type, "object");
    // `compact` takes no arguments, so it declares no `required` list.
    assert.ok("properties" in schema.input_schema);
  }
});

test("TR-1.2: invalid input returns Error without throwing", async () => {
  const registry = registryOf([new BashStubTool(), new ReadFileStubTool()]);
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
  const registryWithHooks = registryOf([new ReadFileStubTool()], {
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
  const registry = registryOf([new BashStubTool()], {
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
  await registryOf([new BashStubTool()], {
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
  const definitions = [new BashStubTool()];
  const registry = registryOf(definitions, {
    hooks: { before(ctx) {
      if (typeof ctx.input === "object" && ctx.input !== null) Object.assign(ctx.input, { command: 9 });
    } },
  });
  definitions.pop();
  registry.schemas()[0]!.input_schema.required = ["oops"];
  registry.list()[0]!.toAnthropicSchema().input_schema.required = ["oops"];
  assert.equal(await registry.invoke("bash", { command: "valid" }), "ok:valid");
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("bash")?.name, "bash");
  assert.equal(registry.get("missing"), undefined);
  assert.throws(() => registryOf([new BashStubTool(), new BashStubTool()]), /Duplicate/);
  assert.throws(() => registryOf([new MismatchedSchemaTool()]), /mismatch/);
});

class RocketNoopTool extends Tool<{ text: string }> {
  readonly name = "noop";
  readonly description = "noop";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { text: { type: "string", minLength: 1 } },
    required: ["text"],
  };

  protected async run(input: { text: string }): Promise<string> {
    if (input.text === "throw") throw new Error("handler failed");
    if (input.text === "empty") return "";
    return "\u{1f680}".repeat(50_001);
  }
}

test("registry normalizes results and audits unknown, invalid, success and failure calls", async () => {
  const events: Array<{ name: string; phase: string; result?: string }> = [];
  const registry = registryOf([new RocketNoopTool()], {
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
  const throwingLogger = registryOf([new BashStubTool()], {
    logger: () => { throw new Error("logger failed"); },
    hooks: { before: () => { throw new Error("before failed"); }, after: () => { throw new Error("after failed"); } },
  });
  assert.equal(await throwingLogger.invoke("bash", { command: "ok" }), "ok:ok");
  assert.equal(await throwingLogger.invoke("missing", {}), "Unknown: missing");
});

class AuditedNoopTool extends Tool<{ text: string }> {
  readonly name = "noop";
  readonly description = "noop";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string" } },
  };

  protected async run(input: { text: string }): Promise<string> {
    if (input.text === "throw") throw new Error("failed");
    return input.text === "empty" ? "" : "x".repeat(50_001);
  }
}

test("TR-I-2.1: every public handler access preserves registry guarantees", async () => {
  const events: string[] = [];
  const registry = registryOf([new AuditedNoopTool()], {
    hooks: {
      before: () => { events.push("before"); },
      after: () => { events.push("after"); },
    },
  });
  // The registered Tool instance is exposed by `get` / `list`; the public
  // dispatch paths are the registry wrapper (which also observes the hooks) and
  // the tool's own `execute` (same validation, placeholder and truncation).
  const tool = registry.get("noop")!;
  for (const [input, expected] of [
    [{}, "Error: Invalid input for noop: text is required"],
    [{ text: "throw" }, "Error: failed"],
    [{ text: "empty" }, "(no output)"],
    [{ text: "large" }, "x".repeat(50_000)],
  ] as const) {
    assert.equal(await registry.invoke("noop", input), expected);
    assert.deepEqual(events.splice(0), ["before", "after"]);
    assert.equal(await tool.execute(input, registry.context), expected);
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
