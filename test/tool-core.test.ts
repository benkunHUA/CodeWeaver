import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_LIMIT } from "../src/bash.js";
import { createWorkspace } from "../src/workspace.js";
import { FileLockRegistry } from "../src/tools/core/FileLockRegistry.js";
import { Tool } from "../src/tools/core/Tool.js";
import { ToolContext } from "../src/tools/core/ToolContext.js";
import type { JsonSchemaObject } from "../src/tools/core/validate.js";
import { BashTool } from "../src/tools/BashTool.js";
import { EditFileTool } from "../src/tools/EditFileTool.js";
import { GlobTool } from "../src/tools/GlobTool.js";
import { ReadFileTool } from "../src/tools/ReadFileTool.js";
import { WriteFileTool } from "../src/tools/WriteFileTool.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { createDefaultTools } from "../src/tools/createDefaultTools.js";
import type { AnthropicTool } from "../src/types.js";

class EchoTool extends Tool<{ value: string }> {
  readonly name = "echo";
  readonly description = "Echo the input value.";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  };
  calls = 0;

  protected async run(input: { value: string }, _context: ToolContext): Promise<string> {
    this.calls += 1;
    if (input.value === "throw") throw new Error("boom");
    if (input.value === "not-a-string") return 42 as never;
    return input.value;
  }
}

class TerseEchoTool extends EchoTool {
  protected override readonly emptyPlaceholder = "(silence)";
}

async function withWorkspace<T>(body: (context: ToolContext) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "cw-tool-core-"));
  try {
    const workspace = await createWorkspace(root);
    return await body(new ToolContext({ workspace, locks: new FileLockRegistry() }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("tool template validates input before running and never calls run on invalid input", async () => {
  await withWorkspace(async (context) => {
    const tool = new EchoTool();
    assert.equal(await tool.execute({}, context), "Error: Invalid input for echo: value is required");
    assert.equal(await tool.execute({ value: 42 }, context), "Error: Invalid input for echo: echo.value must be string");
    assert.equal(await tool.execute("not-an-object", context), "Error: Invalid input for echo: echo must be object");
    assert.equal(tool.calls, 0);
    assert.equal(typeof context.logger, "function");
    assert.doesNotThrow(() => context.logger("ignored"));
  });
});

test("tool template normalizes thrown errors, non-string results and empty results", async () => {
  await withWorkspace(async (context) => {
    const tool = new EchoTool();
    assert.equal(await tool.execute({ value: "throw" }, context), "Error: boom");
    assert.equal(await tool.execute({ value: "not-a-string" }, context), "Error: Invalid result from echo: expected string");
    assert.equal(await tool.execute({ value: "hello" }, context), "hello");
    assert.equal(tool.calls, 3);
    assert.equal(await new EchoTool().execute({ value: "" }, context), "(no output)");
    assert.equal(await new TerseEchoTool().execute({ value: "" }, context), "(silence)");
    assert.equal(await new TerseEchoTool().execute({ value: "kept" }, context), "kept");
  });
});

test("tool template truncates long output by code point", async () => {
  await withWorkspace(async (context) => {
    const result = await new EchoTool().execute({ value: "\u{1f680}".repeat(50_005) }, context);
    assert.equal(result, "\u{1f680}".repeat(OUTPUT_LIMIT));
    assert.equal(Array.from(result).length, OUTPUT_LIMIT);
    // No half surrogate: truncation happens on code points, not UTF-16 units.
    assert.equal(result.length, OUTPUT_LIMIT * 2);
    assert.ok(/^\u{1f680}+$/u.test(result));
  });
});

test("toAnthropicSchema returns a detached snapshot of name, description and input schema", () => {
  const tool = new EchoTool();
  const schema = tool.toAnthropicSchema();
  assert.equal(schema.name, "echo");
  assert.equal(schema.description, "Echo the input value.");
  assert.deepEqual(schema.input_schema, tool.inputSchema);
  const mutable = schema.input_schema as { required: string[]; properties: Record<string, unknown> };
  mutable.required.push("oops");
  delete mutable.properties.value;
  assert.deepEqual(tool.inputSchema.required, ["value"]);
  assert.deepEqual(tool.inputSchema.properties, { value: { type: "string" } });
  const second = tool.toAnthropicSchema();
  assert.notEqual(second, schema);
  assert.deepEqual(second.input_schema, tool.inputSchema);
});

test("FileLockRegistry serializes one key per instance and isolates other instances", async () => {
  const registry = new FileLockRegistry();
  const events: string[] = [];
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const queued = (label: string, ms: number) => registry.withLock("shared", async () => {
    events.push(`start:${label}`);
    await delay(ms);
    events.push(`end:${label}`);
  });
  await Promise.all([queued("a", 20), queued("b", 0), queued("c", 0)]);
  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);

  const other = new FileLockRegistry();
  events.length = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocking = registry.withLock("shared", async () => {
    events.push("blocking:start");
    await gate;
    events.push("blocking:end");
  });
  const independent = other.withLock("shared", async () => { events.push("independent"); });
  await independent;
  assert.deepEqual(events, ["blocking:start", "independent"]);
  release();
  await blocking;
  assert.deepEqual(events, ["blocking:start", "independent", "blocking:end"]);
});

test("FileLockRegistry keeps running after a failed body", async () => {
  const registry = new FileLockRegistry();
  const order: string[] = [];
  const failing = registry.withLock("chain", async () => {
    order.push("fail");
    throw new Error("boom");
  });
  const following = registry.withLock("chain", async () => {
    order.push("next");
    return "ok";
  });
  await assert.rejects(failing, /boom/);
  assert.equal(await following, "ok");
  assert.deepEqual(order, ["fail", "next"]);
});

test("withFileLock resolves request paths, serializes symlink aliases and surfaces safePath errors", async () => {
  await withWorkspace(async (context) => {
    const { locks, workspace } = context;
    await writeFile(join(workspace.root, "file.txt"), "x");
    await symlink("file.txt", join(workspace.root, "alias.txt"));
    assert.equal(await locks.withFileLock(workspace, "file.txt", async (path) => path), join(workspace.root, "file.txt"));
    // A missing path inside the workspace still resolves instead of hanging.
    assert.equal(
      await locks.withFileLock(workspace, "nested/new.txt", async (path) => path),
      join(workspace.root, "nested", "new.txt"),
    );

    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const viaRealPath = locks.withFileLock(workspace, "file.txt", async () => {
      order.push("real:start");
      await gate;
      order.push("real:end");
    });
    // Poll until the first task truly starts instead of assuming a fixed sleep window has
    // elapsed: under load (e.g. the full suite running in parallel) a fixed delay may observe
    // an empty order. Waiting for the real path to hold the lock before enqueueing the alias
    // also removes the realpath completion race that could otherwise let the alias win first.
    const deadline = Date.now() + 2000;
    while (!order.includes("real:start") && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const viaAlias = locks.withFileLock(workspace, "alias.txt", async () => { order.push("alias"); });
    // The alias is queued behind the held lock, so it must not have started yet.
    assert.deepEqual(order, ["real:start"]);
    release();
    await Promise.all([viaRealPath, viaAlias]);
    assert.deepEqual(order, ["real:start", "real:end", "alias"]);

    // An escaping path rejects through safePath and never deadlocks the key.
    await assert.rejects(
      locks.withFileLock(workspace, "../escape.txt", async () => "never"),
      /Path escapes workspace/,
    );
    await assert.rejects(
      locks.withFileLock(workspace, "../escape.txt", async () => "never"),
      /Path escapes workspace/,
    );
    // So does a dangling symlink, whose target does not exist.
    await symlink(join(workspace.root, "..", "missing"), join(workspace.root, "dangling"));
    await assert.rejects(
      locks.withFileLock(workspace, "dangling/new", async () => "never"),
      /symbolic link/,
    );
  });
});

test("tool classes declare the documented name, description and schema", () => {
  const expected = [
    [new BashTool(), "bash", "执行 shell 命令。", {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    }],
    [new ReadFileTool(), "read_file", "读取文件内容。", {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    }],
    [new WriteFileTool(), "write_file", "将内容写入文件。", {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    }],
    [new EditFileTool(), "edit_file", "精确替换文件中的一段文本，仅替换第一处匹配。", {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    }],
    [new GlobTool(), "glob", "按 glob 模式查找文件；** 表示递归匹配。", {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    }],
  ] as const;
  for (const [tool, name, description, expectedSchema] of expected) {
    const schema = tool.toAnthropicSchema();
    assert.equal(schema.name, name);
    assert.equal(schema.description, description);
    assert.equal(schema.input_schema.type, "object");
    assert.deepEqual(schema.input_schema, tool.inputSchema);
    assert.ok((schema.input_schema.required?.length ?? 0) > 0);
    // The tool class owns its schema, so pin the full literal here: a silent
    // edit of `properties` / `required` must fail in this repo without relying
    // on the s02 parity suite's indirect coverage.
    assert.deepEqual(schema.input_schema, expectedSchema);
  }
  assert.deepEqual(
    expected.map(([, name]) => name).sort(),
    ["bash", "edit_file", "glob", "read_file", "write_file"],
  );
});

test("tool classes execute like the previous free functions", async () => {
  await withWorkspace(async (context) => {
    assert.equal(await new BashTool().execute({ command: "printf hi" }, context), "hi");
    assert.equal(await new BashTool().execute({}, context), "Error: Invalid input for bash: command is required");
    assert.equal(
      await new WriteFileTool().execute({ path: "notes/a.txt", content: "hello" }, context),
      "Wrote 5 bytes to notes/a.txt",
    );
    assert.equal(await new ReadFileTool().execute({ path: "notes/a.txt" }, context), "hello");
    assert.equal(await new ReadFileTool().execute({ path: "notes/a.txt", limit: 1 }, context), "hello");
    assert.equal(
      await new EditFileTool().execute({ path: "notes/a.txt", old_text: "l", new_text: "L" }, context),
      "Edited notes/a.txt",
    );
    assert.equal(await new ReadFileTool().execute({ path: "notes/a.txt" }, context), "heLlo");
    assert.equal(
      await new EditFileTool().execute({ path: "notes/a.txt", old_text: "zzz", new_text: "!" }, context),
      "Error: text not found in notes/a.txt",
    );
    assert.match(await new ReadFileTool().execute({ path: "missing.txt" }, context), /^Error: /);
    await writeFile(join(context.workspace.root, "notes", "empty.txt"), "");
    assert.equal(await new ReadFileTool().execute({ path: "notes/empty.txt" }, context), "(no output)");
    assert.equal(await new GlobTool().execute({ pattern: "notes/*.txt" }, context), "notes/a.txt\nnotes/empty.txt");
    assert.equal(await new GlobTool().execute({ pattern: "*.missing" }, context), "(no matches)");
    assert.equal(await new GlobTool().execute({ pattern: "../*" }, context), "Error: Path escapes workspace: ../*");
  });
});

// --- ToolRegistry / createDefaultTools -------------------------------------

const DEFAULT_TOOL_NAMES = ["bash", "read_file", "write_file", "edit_file", "glob"];

/** Standalone echo tool registered under `bash`; the name cannot be reused from `EchoTool`. */
class BashEchoTool extends Tool<{ value: string }> {
  readonly name = "bash";
  readonly description = "Echo the input value.";
  readonly inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  };
  calls = 0;

  protected async run(input: { value: string }, _context: ToolContext): Promise<string> {
    this.calls += 1;
    return input.value;
  }
}

class FailingTool extends Tool<{}> {
  readonly name = "failing";
  readonly description = "Always throws.";
  readonly inputSchema: JsonSchemaObject = { type: "object", properties: {} };

  protected async run(_input: {}, _context: ToolContext): Promise<string> {
    throw new Error("boom");
  }
}

class MismatchedSchemaTool extends Tool<{}> {
  readonly name = "mismatched";
  readonly description = "Reports a different schema name.";
  readonly inputSchema: JsonSchemaObject = { type: "object", properties: {} };

  override toAnthropicSchema(): AnthropicTool {
    return { ...super.toAnthropicSchema(), name: "other" };
  }

  protected async run(_input: {}, _context: ToolContext): Promise<string> {
    return "never";
  }
}

test("ToolRegistry registers the default tools in order and returns schema snapshots", async () => {
  await withWorkspace(async (context) => {
    const registry = new ToolRegistry({ context });
    for (const tool of createDefaultTools()) registry.register(tool);
    assert.deepEqual(registry.schemas().map((schema) => schema.name), DEFAULT_TOOL_NAMES);
    assert.deepEqual(registry.list().map((tool) => tool.name), DEFAULT_TOOL_NAMES);
    assert.equal(registry.get("glob")?.name, "glob");
    assert.equal(registry.get("nothing"), undefined);

    const first = registry.schemas();
    const bashSchema = first[0]!;
    bashSchema.name = "mutated";
    bashSchema.description = "mutated";
    (bashSchema.input_schema.required as string[]).push("oops");
    delete (bashSchema.input_schema.properties as Record<string, unknown>).command;

    const second = registry.schemas();
    assert.notEqual(second[0], bashSchema);
    assert.equal(second[0]!.name, "bash");
    assert.equal(second[0]!.description, "执行 shell 命令。");
    assert.deepEqual(second[0]!.input_schema.required, ["command"]);
    assert.deepEqual(second[0]!.input_schema.properties, { command: { type: "string" } });
    // `list()` hands out a copy, so mutating it cannot change the registry.
    const listed = [...registry.list()];
    listed.pop();
    assert.deepEqual(registry.list().map((tool) => tool.name), DEFAULT_TOOL_NAMES);
  });
});

test("ToolRegistry rejects duplicate names and mismatched schema names", async () => {
  await withWorkspace(async (context) => {
    const registry = new ToolRegistry({ context });
    registry.register(new BashTool());
    assert.throws(() => registry.register(new BashTool()), { message: "Duplicate tool name: bash" });
    assert.throws(() => registry.register(new MismatchedSchemaTool()), {
      message: "Tool schema name mismatch: mismatched",
    });
    // Neither rejected registration changed the registry.
    assert.deepEqual(registry.schemas().map((schema) => schema.name), ["bash"]);
    assert.equal(registry.get("mismatched"), undefined);
  });
});

test("ToolRegistry reports unknown tools and still runs both hooks", async () => {
  await withWorkspace(async (context) => {
    const events: string[] = [];
    const logs: string[] = [];
    const registry = new ToolRegistry({
      context,
      logger: (message) => logs.push(message),
      hooks: {
        before: (hookContext) => {
          events.push(`before:${hookContext.name}`);
        },
        after: (hookContext) => {
          events.push(`after:${hookContext.name}:${hookContext.result}:${hookContext.durationMs >= 0}`);
        },
      },
    });
    assert.equal(await registry.invoke("nothing", {}), "Unknown: nothing");
    assert.deepEqual(events, ["before:nothing", "after:nothing:Unknown: nothing:true"]);
    assert.deepEqual(logs, ["Unknown: nothing"]);
  });
});

test("ToolRegistry surfaces template validation errors and still runs after hooks", async () => {
  await withWorkspace(async (context) => {
    const after: string[] = [];
    const registry = new ToolRegistry({
      context,
      hooks: {
        after: (hookContext) => {
          after.push(`${hookContext.name}:${hookContext.result}`);
        },
      },
    });
    registry.register(new ReadFileTool());
    assert.equal(await registry.invoke("read_file", {}), "Error: Invalid input for read_file: path is required");
    assert.deepEqual(after, ["read_file:Error: Invalid input for read_file: path is required"]);
  });
});

test("ToolRegistry normalizes errors thrown by a tool", async () => {
  await withWorkspace(async (context) => {
    const registry = new ToolRegistry({ context });
    registry.register(new FailingTool());
    assert.equal(await registry.invoke("failing", {}), "Error: boom");
  });
});

test("ToolRegistry keeps the result when both hooks throw and reports them", async () => {
  await withWorkspace(async (context) => {
    const logs: string[] = [];
    let observedDuration = -1;
    const registry = new ToolRegistry({
      context,
      logger: (message) => logs.push(message),
      hooks: {
        before: () => {
          throw "before-boom";
        },
        after: (hookContext) => {
          observedDuration = hookContext.durationMs;
          throw new Error("after-boom");
        },
      },
    });
    registry.register(new EchoTool());
    assert.equal(await registry.invoke("echo", { value: "hi" }), "hi");
    assert.deepEqual(logs, [
      "hook error: echo before failed: before-boom",
      "hook error: echo after failed: after-boom",
    ]);
    assert.ok(observedDuration >= 0);
  });
});

test("ToolRegistry swallows logger failures", async () => {
  await withWorkspace(async (context) => {
    const registry = new ToolRegistry({
      context,
      logger: () => {
        throw new Error("log-boom");
      },
      hooks: {
        before: () => {
          throw new Error("hook-boom");
        },
      },
    });
    registry.register(new EchoTool());
    assert.equal(await registry.invoke("nothing", {}), "Unknown: nothing");
    assert.equal(await registry.invoke("echo", { value: "ok" }), "ok");
  });
});

test("createDefaultTools replaces a same-name override in place and appends new tools", async () => {
  await withWorkspace(async (context) => {
    const replacement = new BashEchoTool();
    const extra = new EchoTool();
    const tools = createDefaultTools({ overrides: [replacement, extra] });
    assert.deepEqual(tools.map((tool) => tool.name), [...DEFAULT_TOOL_NAMES, "echo"]);
    assert.equal(tools[0], replacement);

    const registry = new ToolRegistry({ context });
    for (const tool of tools) registry.register(tool);
    assert.deepEqual(registry.schemas().map((schema) => schema.name), [...DEFAULT_TOOL_NAMES, "echo"]);
    assert.equal(await registry.invoke("bash", { value: "hi" }), "hi");
    assert.equal(replacement.calls, 1);
    // The untouched defaults are still the real tools.
    assert.equal(await registry.invoke("glob", { pattern: "*.missing" }), "(no matches)");
  });
});
