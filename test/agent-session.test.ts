import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { Session } from "../src/agent/Session.js";
import { ConsoleToolPresenter, SilentToolPresenter } from "../src/agent/ToolPresenter.js";
import { subagentPrompt, systemPrompt } from "../src/agent/systemPrompt.js";
import type { Conversation } from "../src/types.js";

const text = (value: string): ContentBlock => ({
  type: "text", text: value, citations: null,
});

test("Session appends the same message shapes as direct pushes", () => {
  const original: Conversation = [{ role: "user", content: "hello" }];
  const session = new Session(original);
  assert.equal(session.messages, original, "the caller's array must be reused");

  const assistant: ContentBlock[] = [text("working")];
  const results: readonly ToolResultBlockParam[] = [
    { type: "tool_result", tool_use_id: "a", content: "first output" },
    { type: "tool_result", tool_use_id: "b", content: "second output" },
  ];
  session.appendAssistant(assistant);
  session.appendToolResults(results);
  session.injectUser("请先补测试");

  assert.deepEqual(original, [
    { role: "user", content: "hello" },
    { role: "assistant", content: assistant },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "first output" },
        { type: "tool_result", tool_use_id: "b", content: "second output" },
      ],
    },
    { role: "user", content: "请先补测试" },
  ]);
  assert.ok(Array.isArray(original[2]?.content), "tool results are pushed as a plain array");
});

test("Session starts from an empty conversation without copying a shared one", () => {
  const session = new Session();
  assert.deepEqual(session.messages, []);
  session.injectUser("hello");
  assert.deepEqual(session.messages, [{ role: "user", content: "hello" }]);
});

test("SilentToolPresenter never writes anything", () => {
  const presenter = new SilentToolPresenter();
  const original = console.log;
  // A throwing replacement proves the presenter never reaches the logger.
  console.log = (() => {
    throw new Error("SilentToolPresenter must not log");
  }) as typeof console.log;
  try {
    assert.doesNotThrow(() => {
      presenter.showToolCall("bash", { command: "printf hi" });
      presenter.showResult("some result", "bash");
    });
  } finally {
    console.log = original;
  }
});

test("ConsoleToolPresenter prints the bash command exactly like the loop", () => {
  const lines: string[] = [];
  const presenter = new ConsoleToolPresenter({ log: (line) => lines.push(line) });
  presenter.showToolCall("bash", { command: "printf hi" });
  assert.deepEqual(lines, ["\x1b[33m$ printf hi\x1b[0m"]);
});

test("ConsoleToolPresenter stays silent for non-bash tools", () => {
  const lines: string[] = [];
  const presenter = new ConsoleToolPresenter({ log: (line) => lines.push(line) });
  presenter.showToolCall("read_file", { path: "a.txt" });
  presenter.showToolCall("glob", { pattern: "*.ts" });
  presenter.showToolCall("write_file", { path: "out.txt", content: "pong" });
  assert.deepEqual(lines, []);
});

test("ConsoleToolPresenter skips a bash call whose command is not a string", () => {
  const lines: string[] = [];
  const presenter = new ConsoleToolPresenter({ log: (line) => lines.push(line) });
  presenter.showToolCall("bash", { command: 42 });
  presenter.showToolCall("bash", {});
  presenter.showToolCall("bash", null);
  presenter.showToolCall("bash", "printf hi");
  assert.deepEqual(lines, []);
});

test("ConsoleToolPresenter previews at most 200 code points by default", () => {
  const lines: string[] = [];
  const presenter = new ConsoleToolPresenter({ log: (line) => lines.push(line) });
  presenter.showResult("🚀".repeat(250), "bash");
  assert.equal(lines.length, 1);
  const out = lines[0] ?? "";
  assert.equal(Array.from(out).length, 200);
  assert.equal(out, "🚀".repeat(200));
});

test("ConsoleToolPresenter honours a custom previewLength", () => {
  const lines: string[] = [];
  const presenter = new ConsoleToolPresenter({
    log: (line) => lines.push(line),
    previewLength: 3,
  });
  presenter.showResult("abcdef", "bash");
  assert.deepEqual(lines, ["abc"]);
});

test("ConsoleToolPresenter defaults to console.log", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    const presenter = new ConsoleToolPresenter();
    presenter.showToolCall("bash", { command: "printf hi" });
    presenter.showResult("done", "bash");
  } finally {
    console.log = original;
  }
  assert.deepEqual(lines, ["\x1b[33m$ printf hi\x1b[0m", "done"]);
});

test("systemPrompt keeps the migrated wording unchanged", () => {
  assert.equal(
    systemPrompt("/workspace"),
    "你是一个位于 /workspace 的编程智能体。开始任何多步骤任务前，先用 todo_write 规划步骤，并在执行过程中持续更新状态。需要聚焦探索或边界清晰的子任务时，用 task 委派给子智能体。请使用工具解决问题，直接动手，不要只做解释。",
  );
});

test("subagentPrompt keeps a fresh-conversation wording", () => {
  assert.equal(
    subagentPrompt("/workspace"),
    "你是一个位于 /workspace 的编程智能体。完成交给你的任务后，返回简洁的最终结论。",
  );
});
