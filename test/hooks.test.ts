import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HookBus,
  createDefaultHooks,
  createLargeOutputHook,
  createPermissionHook,
  createSessionSummaryHook,
} from "../src/hooks/index.js";
import type { PermissionChecker } from "../src/hooks/index.js";
import type { HookContexts } from "../src/hooks/index.js";
import type { Conversation } from "../src/types.js";

function fakeChecker(allowed: boolean, reason = "denied", gate = "test"): PermissionChecker {
  return {
    async check() {
      return { allowed, reason, gate };
    },
  };
}

test("handlers run serially in registration order and stop at the first string result", async () => {
  const bus = new HookBus();
  const calls: string[] = [];
  bus.register("PreToolUse", () => {
    calls.push("A");
    return "blocked-by-A";
  });
  bus.register("PreToolUse", () => {
    calls.push("B");
    return undefined;
  });
  assert.equal(
    await bus.trigger("PreToolUse", { toolName: "bash", input: {}, workspaceRoot: "/ws" }),
    "blocked-by-A",
  );
  assert.deepEqual(calls, ["A"]);
  assert.deepEqual(bus.listHandlers("PreToolUse"), ["handler-1", "handler-2"]);
});

test("handlers that return undefined let the next handler run", async () => {
  const bus = new HookBus();
  const calls: string[] = [];
  bus.register("PostToolUse", () => {
    calls.push("A");
  });
  bus.register("PostToolUse", () => {
    calls.push("B");
  });
  assert.equal(
    await bus.trigger("PostToolUse", { toolName: "bash", input: {}, result: "ok", workspaceRoot: "/ws" }),
    undefined,
  );
  assert.deepEqual(calls, ["A", "B"]);
});

test("all four events trigger and return values keep their meaning", async () => {
  const bus = new HookBus();
  const seen: string[] = [];
  bus.register("UserPromptSubmit", ({ query, workspaceRoot }) => {
    seen.push(`prompt:${query}@${workspaceRoot}`);
  });
  bus.register("PreToolUse", ({ toolName }) => {
    seen.push(`pre:${toolName}`);
    return "Permission denied.";
  });
  bus.register("PostToolUse", ({ toolName, result }) => {
    seen.push(`post:${toolName}:${result}`);
  });
  bus.register("Stop", ({ messages }) => {
    seen.push(`stop:${messages.length}`);
    return "injected-nudge";
  });

  assert.equal(await bus.trigger("UserPromptSubmit", { query: "hi", workspaceRoot: "/ws" }), undefined);
  assert.equal(
    await bus.trigger("PreToolUse", { toolName: "bash", input: { command: "ls" }, workspaceRoot: "/ws" }),
    "Permission denied.",
  );
  assert.equal(
    await bus.trigger("PostToolUse", { toolName: "bash", input: {}, result: "ok", workspaceRoot: "/ws" }),
    undefined,
  );
  assert.equal(
    await bus.trigger("Stop", { messages: [{ role: "user", content: "x" }], workspaceRoot: "/ws" }),
    "injected-nudge",
  );
  assert.deepEqual(seen, ["prompt:hi@/ws", "pre:bash", "post:bash:ok", "stop:1"]);
});

test("PreToolUse hook errors fail closed while other events continue", async () => {
  const logs: string[] = [];
  const bus = new HookBus({ logger: (message) => logs.push(message) });
  bus.register("PreToolUse", () => {
    throw new Error("boom-pre");
  });
  assert.equal(
    await bus.trigger("PreToolUse", { toolName: "bash", input: {}, workspaceRoot: "/ws" }),
    "Permission denied: hook error in PreToolUse",
  );

  const continued: string[] = [];
  bus.register("PostToolUse", () => {
    throw new Error("boom-post");
  });
  bus.register("PostToolUse", () => {
    continued.push("post-next");
  });
  assert.equal(
    await bus.trigger("PostToolUse", { toolName: "bash", input: {}, result: "ok", workspaceRoot: "/ws" }),
    undefined,
  );
  bus.register("Stop", () => {
    throw new Error("boom-stop");
  });
  bus.register("Stop", () => {
    continued.push("stop-next");
  });
  assert.equal(await bus.trigger("Stop", { messages: [], workspaceRoot: "/ws" }), undefined);

  assert.deepEqual(continued, ["post-next", "stop-next"]);
  assert.deepEqual(logs, [
    "hook error: PreToolUse failed: boom-pre",
    "hook error: PostToolUse failed: boom-post",
    "hook error: Stop failed: boom-stop",
  ]);
});

test("onError overrides the per-event default policy", async () => {
  const bus = new HookBus();
  bus.register("PreToolUse", () => {
    throw new Error("boom");
  }, { onError: "ignore" });
  bus.register("PreToolUse", () => "after-ignore");
  assert.equal(
    await bus.trigger("PreToolUse", { toolName: "bash", input: {}, workspaceRoot: "/ws" }),
    "after-ignore",
  );

  bus.register("Stop", () => {
    throw new Error("boom");
  }, { onError: "block" });
  assert.equal(
    await bus.trigger("Stop", { messages: [], workspaceRoot: "/ws" }),
    "Permission denied: hook error in Stop",
  );
});

test("a throwing logger never interrupts hook dispatch", async () => {
  const bus = new HookBus({
    logger: () => {
      throw new Error("logger failed");
    },
  });
  bus.register("PreToolUse", () => {
    throw new Error("boom");
  }, { onError: "ignore" });
  assert.equal(
    await bus.trigger("PreToolUse", { toolName: "bash", input: {}, workspaceRoot: "/ws" }),
    undefined,
  );
  bus.register("PreToolUse", () => {
    throw new Error("boom");
  });
  assert.equal(
    await bus.trigger("PreToolUse", { toolName: "bash", input: {}, workspaceRoot: "/ws" }),
    "Permission denied: hook error in PreToolUse",
  );
});

test("handlers receive a structured snapshot of the context", async () => {
  const bus = new HookBus();
  bus.register("PreToolUse", (received) => {
    const mutable = received as {
      toolName: string;
      input: { command: { nested: string } };
    };
    mutable.toolName = "changed";
    mutable.input.command.nested = "mutated";
  });
  const original = { toolName: "bash", input: { command: { nested: "keep" } }, workspaceRoot: "/ws" };
  await bus.trigger("PreToolUse", original);
  assert.deepEqual(original, {
    toolName: "bash",
    input: { command: { nested: "keep" } },
    workspaceRoot: "/ws",
  });
});

test("a context that cannot be cloned follows the per-event error policy", async () => {
  const preLogs: string[] = [];
  const preBus = new HookBus({ logger: (message) => preLogs.push(message) });
  const preRan: string[] = [];
  preBus.register("PreToolUse", () => {
    preRan.push("pre");
  });
  const dirtyPre = {
    toolName: "bash", input: {}, workspaceRoot: "/ws", bad: () => {},
  } as unknown as HookContexts["PreToolUse"];

  assert.equal(
    await preBus.trigger("PreToolUse", dirtyPre),
    "Permission denied: hook error in PreToolUse",
  );
  assert.deepEqual(preRan, [], "the handler must not run when the snapshot fails");
  assert.equal(preLogs.length, 1);
  assert.ok(preLogs[0]?.includes("hook error: PreToolUse failed:"), preLogs[0]);

  const postLogs: string[] = [];
  const postBus = new HookBus({ logger: (message) => postLogs.push(message) });
  const postRan: string[] = [];
  postBus.register("PostToolUse", () => { postRan.push("first"); });
  postBus.register("PostToolUse", () => { postRan.push("second"); });
  const dirtyPost = {
    toolName: "bash", input: {}, result: "ok", workspaceRoot: "/ws", bad: () => {},
  } as unknown as HookContexts["PostToolUse"];

  assert.equal(await postBus.trigger("PostToolUse", dirtyPost), undefined);
  // The ignore policy skips the broken handler and tries the next one (two logs)
  // instead of blocking the whole event like PreToolUse would.
  assert.deepEqual(postRan, [], "both handlers are skipped, none runs");
  assert.equal(postLogs.length, 2);
  assert.ok(
    postLogs.every((line) => line.includes("hook error: PostToolUse failed:")),
    postLogs.join(" | "),
  );
});

test("createPermissionHook blocks with the exact s03 tool-result text", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-hooks-perm-"));
  const logs: string[] = [];
  try {
    const bus = new HookBus();
    bus.register("PreToolUse", createPermissionHook(fakeChecker(false, "rm -rf /"), {
      log: (message) => logs.push(message),
    }));
    assert.equal(
      await bus.trigger("PreToolUse", { toolName: "bash", input: { command: "rm -rf /" }, workspaceRoot: root }),
      "Permission denied.",
    );
    assert.deepEqual(logs, ["\n\x1b[31m[blocked] rm -rf /\x1b[0m"]);

    const allowedLogs: string[] = [];
    const allowBus = new HookBus();
    allowBus.register("PreToolUse", createPermissionHook(fakeChecker(true), {
      log: (message) => allowedLogs.push(message),
    }));
    assert.equal(
      await allowBus.trigger("PreToolUse", { toolName: "bash", input: { command: "ls" }, workspaceRoot: root }),
      undefined,
    );
    assert.deepEqual(allowedLogs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createPermissionHook forwards a coerced record for non-object input", async () => {
  let seen: unknown;
  const checker: PermissionChecker = {
    async check(request) {
      seen = request;
      return { allowed: true, reason: "", gate: "test" };
    },
  };
  const handler = createPermissionHook(checker, { log: () => {} });
  assert.equal(await handler({ toolName: "bash", input: 42, workspaceRoot: "/ws" }), undefined);
  assert.deepEqual(seen, { toolName: "bash", input: {}, workspaceRoot: "/ws" });
});

test("createLargeOutputHook warns only above the threshold", async () => {
  const logs: string[] = [];
  const bus = new HookBus();
  bus.register("PostToolUse", createLargeOutputHook({ log: (message) => logs.push(message), threshold: 4 }));
  await bus.trigger("PostToolUse", { toolName: "bash", input: {}, result: "ok", workspaceRoot: "/ws" });
  await bus.trigger("PostToolUse", { toolName: "bash", input: {}, result: "12345", workspaceRoot: "/ws" });
  assert.deepEqual(logs, ["\x1b[33m[HOOK] Large output from bash: 5 chars\x1b[0m"]);
});

test("createSessionSummaryHook counts tool_result blocks safely", async () => {
  const logs: string[] = [];
  const messages: Conversation = [
    { role: "user", content: "hello" },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "1", content: "first" },
        { type: "text", text: "ignored" },
        { type: "tool_result", tool_use_id: "2", content: "second" },
      ],
    },
  ];
  const handler = createSessionSummaryHook({ log: (message) => logs.push(message) });
  assert.equal(await handler({ messages, workspaceRoot: "/ws" }), undefined);
  assert.deepEqual(logs, ["\x1b[90m[HOOK] Stop: session used 2 tool calls\x1b[0m"]);
});

test("createDefaultHooks wires the s04 order and emits hook logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-hooks-default-"));
  const logs: string[] = [];
  try {
    const bus = createDefaultHooks({
      checker: fakeChecker(true),
      workspaceRoot: root,
      logger: (message) => logs.push(message),
      log: (message) => logs.push(message),
    });
    assert.deepEqual(bus.listHandlers("UserPromptSubmit"), ["workspace-context"]);
    assert.deepEqual(bus.listHandlers("PreToolUse"), ["permission", "log"]);
    assert.ok(bus.listHandlers("PreToolUse").length >= 2);
    assert.deepEqual(bus.listHandlers("PostToolUse"), ["large-output"]);
    assert.deepEqual(bus.listHandlers("Stop"), ["session-summary"]);

    assert.equal(await bus.trigger("UserPromptSubmit", { query: "hi", workspaceRoot: root }), undefined);
    assert.equal(
      await bus.trigger("PreToolUse", { toolName: "bash", input: { command: "ls" }, workspaceRoot: root }),
      undefined,
    );
    assert.equal(
      await bus.trigger("PostToolUse", { toolName: "bash", input: {}, result: "ok", workspaceRoot: root }),
      undefined,
    );
    assert.equal(await bus.trigger("Stop", { messages: [], workspaceRoot: root }), undefined);
    assert.deepEqual(logs, [
      `\x1b[90m[HOOK] UserPromptSubmit: working in ${root}\x1b[0m`,
      "\x1b[90m[HOOK] bash(...)\x1b[0m",
      "\x1b[90m[HOOK] Stop: session used 0 tool calls\x1b[0m",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
