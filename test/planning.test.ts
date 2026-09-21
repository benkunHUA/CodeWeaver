import assert from "node:assert/strict";
import test from "node:test";
import {
  TODO_REMINDER_TEXT,
  TODO_REMINDER_THRESHOLD,
  TODO_REMINDER_TOOL,
  TODO_STATUSES,
  TodoList,
  TodoReminder,
  TodoStore,
} from "../src/planning/index.js";
import type { TodoItem } from "../src/planning/index.js";

function errorMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Error, "parse must throw an Error");
    return error.message;
  }
  throw new Error("expected the call to throw");
}

function pendingTodos(count: number): TodoItem[] {
  return Array.from({ length: count }, (_value, index) => ({
    content: `task ${index}`,
    status: "pending" as const,
  }));
}

test("render marks each status and appends the completed count", () => {
  const list = TodoList.parse([
    { content: "a", status: "pending" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "completed" },
  ]);

  assert.equal(list.isEmpty, false);
  assert.equal(list.render(), "[ ] a\n[>] b\n[x] c\n\n(1/3 completed)");
  assert.deepEqual(list.items, [
    { content: "a", status: "pending" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "completed" },
  ]);
});

test("an empty list renders 'No todos.' with no trailing newline", () => {
  const list = TodoList.empty();

  assert.equal(list.isEmpty, true);
  assert.deepEqual(list.items, []);
  assert.equal(list.render(), "No todos.");
});

test("parse normalizes content whitespace and status case", () => {
  const list = TodoList.parse([{ content: "  write tests  ", status: "PENDING" }]);

  assert.deepEqual(list.items, [{ content: "write tests", status: "pending" }]);
  assert.equal(list.render(), "[ ] write tests\n\n(0/1 completed)");
});

test("parse defaults a missing status to pending", () => {
  const list = TodoList.parse([{ content: "ship it" }, { content: "done", status: "COMPLETED" }]);

  assert.deepEqual(list.items, [
    { content: "ship it", status: "pending" },
    { content: "done", status: "completed" },
  ]);
  assert.equal(list.render(), "[ ] ship it\n[x] done\n\n(1/2 completed)");
});

test("parse coerces non-string content to a string", () => {
  const list = TodoList.parse([{ content: 5, status: "completed" }]);

  assert.deepEqual(list.items, [{ content: "5", status: "completed" }]);
});

test("parse rejects a non-array with the Python message", () => {
  assert.equal(errorMessage(() => TodoList.parse("not a list")), "todos must be a list");
  assert.equal(errorMessage(() => TodoList.parse({ todos: [] })), "todos must be a list");
  assert.equal(errorMessage(() => TodoList.parse(undefined)), "todos must be a list");
});

test("parse rejects more than 20 todos with the Python message", () => {
  assert.equal(errorMessage(() => TodoList.parse(pendingTodos(21))), "Max 20 todos allowed");
});

test("parse rejects non-object items with their index", () => {
  assert.equal(errorMessage(() => TodoList.parse([1])), "todos[0] must be an object");
  assert.equal(errorMessage(() => TodoList.parse([null])), "todos[0] must be an object");
  assert.equal(
    errorMessage(() => TodoList.parse([{ content: "a" }, [{ content: "b" }]])),
    "todos[1] must be an object",
  );
});

test("parse rejects empty content with its index", () => {
  assert.equal(errorMessage(() => TodoList.parse([{}])), "todos[0] requires content");
  assert.equal(
    errorMessage(() => TodoList.parse([{ content: "a" }, { content: "   " }])),
    "todos[1] requires content",
  );
});

test("parse rejects an unknown status with the normalized value in quotes", () => {
  assert.equal(
    errorMessage(() => TodoList.parse([{ content: "a", status: "done" }])),
    "todos[0] has invalid status 'done'",
  );
  assert.equal(
    errorMessage(() => TodoList.parse([{ content: "a", status: "In Progress" }])),
    "todos[0] has invalid status 'in progress'",
  );
  assert.equal(
    errorMessage(() => TodoList.parse([{ content: "a", status: 5 }])),
    "todos[0] has invalid status '5'",
  );
});

test("parse rejects more than one in_progress todo", () => {
  assert.equal(
    errorMessage(() =>
      TodoList.parse([
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ]),
    ),
    "Only one todo can be in_progress at a time",
  );
});

test("parse accepts exactly 20 todos", () => {
  assert.equal(TodoList.parse(pendingTodos(20)).items.length, 20);
});

test("per-item checks run before the in_progress count", () => {
  const list = [
    { content: "a", status: "in_progress" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "nope" },
  ];

  assert.equal(errorMessage(() => TodoList.parse(list)), "todos[2] has invalid status 'nope'");
});

test("TODO_STATUSES lists the accepted statuses in order", () => {
  assert.deepEqual([...TODO_STATUSES], ["pending", "in_progress", "completed"]);
});

test("TodoStore.update returns the render and stores the parsed list", () => {
  const store = new TodoStore();
  assert.equal(store.list.render(), "No todos.");

  const output = store.update([{ content: "first", status: "in_progress" }]);

  assert.equal(output, "[>] first\n\n(0/1 completed)");
  assert.deepEqual(store.list.items, [{ content: "first", status: "in_progress" }]);
  assert.equal(store.list.render(), output);
});

test("TodoStore.update keeps the previous list when validation fails", () => {
  const store = new TodoStore();
  const output = store.update([{ content: "first", status: "in_progress" }]);

  assert.throws(
    () =>
      store.update([
        { content: "second", status: "in_progress" },
        { content: "third", status: "in_progress" },
      ]),
    /Only one todo can be in_progress at a time/,
  );
  assert.deepEqual(store.list.items, [{ content: "first", status: "in_progress" }]);
  assert.equal(store.list.render(), output);

  assert.throws(() => store.update("not a list"), { message: "todos must be a list" });
  assert.deepEqual(store.list.items, [{ content: "first", status: "in_progress" }]);
});

test("TODO reminder constants are pinned to their literal values", () => {
  // These assertions compare against literals rather than against the constants
  // themselves: a self-comparison would stay green even if the reminder text or
  // the tracked tool name drifted, so only literals can catch that drift.
  assert.equal(TODO_REMINDER_TEXT, "<reminder>请更新你的任务列表。</reminder>");
  assert.equal(TODO_REMINDER_THRESHOLD, 3);
  assert.equal(TODO_REMINDER_TOOL, "todo_write");
});

test("TodoReminder: default threshold fires on the third round without the tracked tool", () => {
  const reminder = new TodoReminder();

  assert.equal(reminder.afterToolRound(["bash"]), undefined);
  assert.equal(reminder.afterToolRound(["bash"]), undefined);
  assert.equal(reminder.afterToolRound(["bash"]), TODO_REMINDER_TEXT);
  assert.equal(reminder.afterToolRound(["bash"]), undefined, "firing resets the counter");
  assert.equal(reminder.afterToolRound(["bash"]), undefined);
  assert.equal(reminder.afterToolRound(["bash"]), TODO_REMINDER_TEXT);
});

test("TodoReminder: a round containing the tracked tool resets the counter", () => {
  const reminder = new TodoReminder();

  assert.equal(reminder.afterToolRound(["bash"]), undefined);
  assert.equal(reminder.afterToolRound(["bash", "todo_write"]), undefined);
  assert.equal(reminder.afterToolRound(["bash"]), undefined);
  assert.equal(
    reminder.afterToolRound(["bash"]),
    undefined,
    "without the reset the fourth round would have fired",
  );
});

test("TodoReminder: beginRun drops the rounds accumulated so far", () => {
  const reminder = new TodoReminder();

  assert.equal(reminder.afterToolRound(["bash"]), undefined);
  assert.equal(reminder.afterToolRound(["bash"]), undefined);
  reminder.beginRun();
  assert.equal(reminder.afterToolRound(["bash"]), undefined);
});

test("TodoReminder: threshold, toolName and text are injectable", () => {
  const fast = new TodoReminder({ threshold: 2 });
  assert.equal(fast.afterToolRound(["bash"]), undefined);
  assert.equal(fast.afterToolRound(["bash"]), TODO_REMINDER_TEXT);

  const custom = new TodoReminder({ toolName: "plan", text: "X" });
  assert.equal(custom.afterToolRound(["plan"]), undefined);
  assert.equal(custom.afterToolRound(["bash"]), undefined);
  assert.equal(custom.afterToolRound(["bash"]), undefined, "the plan round reset the counter");
  assert.equal(custom.afterToolRound(["bash"]), "X");
});
