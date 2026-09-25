import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentLoop } from "../src/agent/AgentLoop.js";
import { Session } from "../src/agent/Session.js";
import { ConsoleToolPresenter } from "../src/agent/ToolPresenter.js";
import { systemPrompt } from "../src/agent/systemPrompt.js";
import { BashTool } from "../src/tools/BashTool.js";
import { EditFileTool } from "../src/tools/EditFileTool.js";
import { GlobTool } from "../src/tools/GlobTool.js";
import { ReadFileTool } from "../src/tools/ReadFileTool.js";
import { WriteFileTool } from "../src/tools/WriteFileTool.js";
import { FileLockRegistry } from "../src/tools/core/FileLockRegistry.js";
import type { Tool } from "../src/tools/core/Tool.js";
import { ToolContext } from "../src/tools/core/ToolContext.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { createWorkspace } from "../src/workspace.js";
import type { BashInput, Conversation, ModelRequest, ModelResponse } from "../src/types.js";

/**
 * Replaces the built-in bash tool the way the old `overrides` handler did:
 * commands are recorded and echoed instead of executed. Name, description and
 * input schema stay inherited from `BashTool`, so the request payload keeps the
 * production tool shape.
 */
class BashStubTool extends BashTool {
  readonly #recordCommand: (command: string) => void;

  constructor(recordCommand: (command: string) => void) {
    super();
    this.#recordCommand = recordCommand;
  }

  protected override async run(input: BashInput): Promise<string> {
    assert.equal(typeof input.command, "string");
    this.#recordCommand(input.command);
    return `result:${input.command}`;
  }
}

/**
 * The s02 request contract has exactly five tools. `todo_write` was added in
 * s05, so the registries compared against the lesson are built explicitly here
 * instead of using `createDefaultTools()`, which now returns eight.
 */
function s02Tools(bash: Tool<unknown> = new BashTool()): Tool<unknown>[] {
  return [bash, new ReadFileTool(), new WriteFileTool(), new EditFileTool(), new GlobTool()];
}

const source = fileURLToPath(new URL("../../s02_tool_use/code.py", import.meta.url));
const candidates = process.env.PYTHON
  ? [process.env.PYTHON]
  : ["python3", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10"];
// s02 uses PEP 604 annotations and glob(root_dir=...), both requiring 3.10+.
const python = candidates.find((candidate) =>
  spawnSync(candidate, ["-c", "import sys; sys.exit(sys.version_info < (3, 10))"]).status === 0,
);
const available = existsSync(source) && python !== undefined;
const optional = {
  skip: available ? false : "Optional: original s02 lesson and Python 3.10+ are not present",
};

// Execute the actual lesson definitions, including its dispatch table, without
// importing the SDK, loading dotenv, or requiring credentials.
const oracle = String.raw`
import ast, contextlib, copy, io, json, os, subprocess, sys, types
from pathlib import Path
path = sys.argv[1]
payload = json.load(sys.stdin)
os.chdir(payload["workdir"])
with open(path, encoding="utf-8") as source:
    tree = ast.parse(source.read())
functions = {"safe_path", "agent_loop", "run_bash", "run_read", "run_write", "run_edit", "run_glob"}
assignments = {"WORKDIR", "SYSTEM", "TOOLS", "TOOL_HANDLERS"}
nodes = [
    n for n in tree.body
    if (isinstance(n, ast.FunctionDef) and n.name in functions)
    or (isinstance(n, ast.Assign) and any(
        isinstance(t, ast.Name) and t.id in assignments for t in n.targets))
]
scope = {"os": os, "subprocess": subprocess, "Path": Path}
exec(compile(ast.Module(body=nodes, type_ignores=[]), path, "exec"), scope)
if payload["mode"] == "tools":
    result = [scope["TOOL_HANDLERS"][call["name"]](**call["kwargs"])
              for call in payload["calls"]]
else:
    responses = iter(payload["responses"])
    requests, commands, names = [], [], []
    def create(**kwargs):
        requests.append(copy.deepcopy(kwargs))
        response = next(responses)
        return types.SimpleNamespace(
            stop_reason=response["stop_reason"],
            content=[types.SimpleNamespace(**block) for block in response["content"]])
    def make_handler(name, real):
        def handler(**kwargs):
            names.append(name)
            if name == "bash":
                commands.append(kwargs["command"])
                return "result:" + kwargs["command"]
            return real(**kwargs)
        return handler
    scope["TOOL_HANDLERS"] = {
        name: make_handler(name, real)
        for name, real in scope["TOOL_HANDLERS"].items()
    }
    scope.update(
        client=types.SimpleNamespace(messages=types.SimpleNamespace(create=create)),
        MODEL="test-model")
    messages = payload.get("messages", [{"role": "user", "content": "hello"}])
    logs = io.StringIO()
    with contextlib.redirect_stdout(logs):
        scope["agent_loop"](messages)
    result = dict(messages=messages, requests=requests, commands=commands,
                  names=names, logs=logs.getvalue())
print(json.dumps(result, default=lambda value: vars(value)))
`;

function runPython(mode: "tools" | "loop", extra: Record<string, unknown>): unknown {
  assert.ok(python, "Python 3.10+ is required for the s02 reference");
  const result = spawnSync(python, ["-c", oracle, source], {
    input: JSON.stringify({ mode, ...extra }),
    encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout) as unknown;
}

interface Call {
  readonly name: string;
  readonly kwargs: Record<string, unknown>;
}

const seeds: Record<string, string> = {
  "a.txt": "line1\nline2\nline3\n",
  "nested/b.txt": "AAA\nBBB\nAAA\nCCC",
  "README.md": "readme",
  "empty.txt": "",
  "unicode.txt": "caf\u00e9 \u{1f680}",
};

async function reset(root: string, extra: Record<string, string> = {}): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries({ ...seeds, ...extra })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await symlink("nested/b.txt", join(root, "inside-link"));
  await symlink(source, join(root, "outside-link"));
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) files[path] = `symlink:${await readlink(join(root, path))}`;
      else if (entry.isDirectory()) await visit(path);
      else files[path] = await readFile(join(root, path), "utf8");
    }
  }
  await visit("");
  return files;
}

// Both implementations see the SAME canonical path and pristine seed state.
// Calls within each implementation are sequential, so edit/read/glob observe
// prior writes, not a Promise.all race or the other implementation's mutations.
async function compareTools(root: string, calls: readonly Call[], extra: Record<string, string> = {}) {
  await reset(root, extra);
  const expected = runPython("tools", { calls, workdir: root }) as string[];
  const expectedFiles = await snapshot(root);
  await reset(root, extra);
  const workspace = await createWorkspace(root);
  const registry = new ToolRegistry({
    context: new ToolContext({ workspace, locks: new FileLockRegistry() }),
  });
  for (const tool of s02Tools()) registry.register(tool);
  const actual: string[] = [];
  for (const call of calls) actual.push(await registry.invoke(call.name, call.kwargs));
  assert.deepEqual(await snapshot(root), expectedFiles, "filesystem effects");
  return { actual, expected };
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const node = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`;

test("s02 Python parity: sequential tool fixtures and filesystem effects", optional, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cw-s02-parity-")));
  const cases: { name: string; calls: Call[]; extra?: Record<string, string> }[] = [
    { name: "bash pipeline", calls: [{ name: "bash", kwargs: { command: "printf s02 | tr a-z A-Z" } }] },
    { name: "bash stdout then stderr on nonzero exit", calls: [{ name: "bash", kwargs: { command: "printf err >&2; printf out; exit 7" } }] },
    { name: "bash empty output", calls: [{ name: "bash", kwargs: { command: "exit 3" } }] },
    { name: "bash workspace cwd", calls: [{ name: "bash", kwargs: { command: "cat README.md" } }] },
    { name: "bash dangerous substring policy", calls: ["sudo true", "rm -rf /", "shutdown", "reboot", "> /dev/null"].map(
      (command) => ({ name: "bash", kwargs: { command } }),
    ) },
    { name: "bash Python whitespace and universal newlines", calls: [{ name: "bash", kwargs: {
      command: node("process.stdout.write('\\u0085hi\\r\\nthere\\rbye\\u001c')"),
    } }] },
    { name: "bash code-point truncation", calls: [{ name: "bash", kwargs: {
      command: node("process.stdout.write('\\u{1f680}'.repeat(50005))"),
    } }] },
    { name: "read trailing newline", calls: [{ name: "read_file", kwargs: { path: "a.txt" } }] },
    { name: "read positive limit and omitted count", calls: [{ name: "read_file", kwargs: { path: "a.txt", limit: 2 } }] },
    { name: "read limit at and above line count", calls: [3, 10].map(
      (limit) => ({ name: "read_file", kwargs: { path: "a.txt", limit } }),
    ) },
    { name: "read Unicode content", calls: [{ name: "read_file", kwargs: { path: "unicode.txt" } }] },
    { name: "read universal splitlines", extra: { "lines.txt": "a\r\nb\rc\u0085d\u2028e\u2029f\n" },
      calls: [{ name: "read_file", kwargs: { path: "lines.txt" } }] },
    { name: "read in-workspace symlink", calls: [{ name: "read_file", kwargs: { path: "inside-link" } }] },
    { name: "reject lexical path escape", calls: [{ name: "read_file", kwargs: { path: "../outside.txt" } }] },
    { name: "reject symlink path escape", calls: [{ name: "read_file", kwargs: { path: "outside-link" } }] },
    { name: "write creates parents then read and glob", calls: [
      { name: "write_file", kwargs: { path: "out/deep/c.txt", content: "new content" } },
      { name: "read_file", kwargs: { path: "out/deep/c.txt" } },
      { name: "glob", kwargs: { pattern: "out/**/*.txt" } },
    ] },
    { name: "write overwrites existing file", calls: [
      { name: "write_file", kwargs: { path: "a.txt", content: "replacement" } },
      { name: "read_file", kwargs: { path: "a.txt" } },
    ] },
    { name: "edit only first occurrence then read", calls: [
      { name: "edit_file", kwargs: { path: "nested/b.txt", old_text: "AAA", new_text: "YYY" } },
      { name: "read_file", kwargs: { path: "nested/b.txt" } },
    ] },
    { name: "edit replacement is literal", calls: [
      { name: "edit_file", kwargs: { path: "nested/b.txt", old_text: "AAA", new_text: "$& $` $' $$" } },
      { name: "read_file", kwargs: { path: "nested/b.txt" } },
    ] },
    { name: "edit missing text leaves file unchanged", calls: [
      { name: "edit_file", kwargs: { path: "a.txt", old_text: "absent", new_text: "x" } },
    ] },
    { name: "edit empty search inserts at start", calls: [
      { name: "edit_file", kwargs: { path: "README.md", old_text: "", new_text: "prefix:" } },
      { name: "read_file", kwargs: { path: "README.md" } },
    ] },
    { name: "glob recursive sorted matches", calls: [{ name: "glob", kwargs: { pattern: "**/*.txt" } }] },
    { name: "glob no matches", calls: [{ name: "glob", kwargs: { pattern: "**/*.missing" } }] },
    { name: "glob filters escaping symlink", calls: [{ name: "glob", kwargs: { pattern: "outside-link" } }] },
    { name: "glob match cap", extra: Object.fromEntries(
      Array.from({ length: 205 }, (_, i) => [`many/${String(i).padStart(3, "0")}.txt`, "x"]),
    ), calls: [{ name: "glob", kwargs: { pattern: "many/*.txt" } }] },
  ];
  try {
    assert.ok(cases.length >= 15);
    for (const sample of cases) {
      await t.test(sample.name, async () => {
        const { actual, expected } = await compareTools(root, sample.calls, sample.extra);
        assert.deepEqual(actual, expected);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("s02 intentional contracts: UTF-8 byte counts, empty reads and platform I/O errors", optional, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cw-s02-contracts-")));
  try {
    await t.test("write reports UTF-8 bytes, Python reports code points", async () => {
      const { actual, expected } = await compareTools(root, [
        { name: "write_file", kwargs: { path: "emoji.txt", content: "\u{1f680}\u{1f680}\u00e9" } },
        { name: "read_file", kwargs: { path: "emoji.txt" } },
      ]);
      assert.deepEqual(expected, ["Wrote 3 bytes to emoji.txt", "\u{1f680}\u{1f680}\u00e9"]);
      assert.deepEqual(actual, ["Wrote 10 bytes to emoji.txt", "\u{1f680}\u{1f680}\u00e9"]);
    });
    await t.test("empty read uses production placeholder, Python returns empty string", async () => {
      const { actual, expected } = await compareTools(root, [
        { name: "read_file", kwargs: { path: "empty.txt" } },
        { name: "write_file", kwargs: { path: "new-empty.txt", content: "" } },
        { name: "read_file", kwargs: { path: "new-empty.txt" } },
      ]);
      assert.deepEqual(expected, ["", "Wrote 0 bytes to new-empty.txt", ""]);
      assert.deepEqual(actual, ["(no output)", "Wrote 0 bytes to new-empty.txt", "(no output)"]);
    });
    for (const name of ["read_file", "edit_file"]) {
      await t.test(`${name} preserves native missing-file error details`, async () => {
        const { actual, expected } = await compareTools(root, [{
          name, kwargs: { path: "missing.txt", ...(name === "edit_file" ? { old_text: "a", new_text: "b" } : {}) },
        }]);
        assert.equal(expected.length, 1);
        assert.equal(actual.length, 1);
        assert.match(expected[0]!, /^Error: \[Errno 2\] No such file or directory: /);
        assert.match(actual[0]!, /^Error: .*ENOENT.*no such file or directory/);
        assert.ok(expected[0]!.includes(join(root, "missing.txt")));
        assert.ok(actual[0]!.includes(join(root, "missing.txt")));
        assert.notEqual(actual[0], expected[0]);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface LoopResult {
  messages: Conversation;
  requests: ModelRequest[];
  commands: string[];
  names: string[];
  logs: string;
}

function turn(calls: readonly Call[], stop_reason: ModelResponse["stop_reason"] = "tool_use"): ModelResponse {
  return {
    content: [
      { type: "text", text: "working", citations: null },
      ...calls.map((call, i) => ({
        type: "tool_use" as const, id: `call-${i}`, name: call.name,
        input: call.kwargs, caller: { type: "direct" as const },
      })),
    ],
    stop_reason,
  };
}

// Assert raw logs, including ANSI escapes, without normalizing either stream.
// The CLI-style hook adds magenta names; the agent also logs bash commands.
function expectedLogs(messages: Conversation, implementation: "python" | "typescript", cliHook = false): string {
  const lines: string[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const calls = message.content.filter((block) => block.type === "tool_use");
    if (calls.length === 0) continue;
    const results = messages[i + 1]?.content;
    assert.ok(Array.isArray(results));
    for (let j = 0; j < calls.length; j += 1) {
      const call = calls[j]!;
      const result: Exclude<Conversation[number]["content"], string>[number] = results[j]!;
      assert.equal(result.type, "tool_result");
      assert.ok(result.type === "tool_result" && typeof result.content === "string");
      if (implementation === "python") lines.push(`\x1b[33m> ${call.name}\x1b[0m`);
      else if (call.name === "bash") {
        lines.push(`\x1b[33m$ ${(call.input as { command: string }).command}\x1b[0m`);
      }
      if (implementation === "typescript" && cliHook) lines.push(`\x1b[35m> ${call.name}\x1b[0m`);
      lines.push(Array.from(result.content).slice(0, 200).join(""));
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

// Prompt text (system prompt and tool descriptions) is an approved production
// divergence: CodeWeaver ships Chinese prompts while the lesson ships English
// ones. Replace the text with a placeholder before comparing request structure
// so the difference is normalized, never silently ignored: the language of both
// sides is asserted separately in the loop test below.
const PROMPT_PLACEHOLDER = "<prompt text>";
const CJK = /[\u4e00-\u9fff]/u;

function normalizePromptText(request: ModelRequest): unknown {
  const clone = structuredClone(request) as ModelRequest & {
    system?: unknown;
    tools?: readonly { readonly description?: unknown }[];
  };
  if (clone.system !== undefined) clone.system = PROMPT_PLACEHOLDER as never;
  clone.tools = (clone.tools ?? []).map((tool) => ({
    ...tool,
    description: PROMPT_PLACEHOLDER,
  })) as never;
  return clone;
}

test("s02 Python parity: complete requests, history and dispatch order; explicit CLI log contracts", optional, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cw-s02-loop-")));
  const done: ModelResponse = {
    content: [{ type: "text", text: "done", citations: null }], stop_reason: "end_turn",
  };
  const cases: { name: string; responses: ModelResponse[]; cliHook?: boolean }[] = [
    { name: "empty content ends loop despite tool_use stop reason", responses: [{ content: [], stop_reason: "tool_use" }] },
    { name: "empty text ends loop", responses: [{ content: [{ type: "text", text: "", citations: null }], stop_reason: "tool_use" }] },
    { name: "ordinary final answer", responses: [done] },
    { name: "all five tools in one ordered batch despite end_turn", responses: [
      turn([
        { name: "bash", kwargs: { command: "first" } },
        { name: "write_file", kwargs: { path: "out.txt", content: "AAA AAA" } },
        { name: "edit_file", kwargs: { path: "out.txt", old_text: "AAA", new_text: "BBB" } },
        { name: "read_file", kwargs: { path: "out.txt" } },
        { name: "glob", kwargs: { pattern: "*.txt" } },
        { name: "bash", kwargs: { command: "second" } },
      ], "end_turn"), done,
    ] },
    { name: "multiple rounds preserve earlier history snapshots", responses: [
      turn([{ name: "write_file", kwargs: { path: "out.txt", content: "hello" } }]),
      turn([
        { name: "read_file", kwargs: { path: "out.txt" } },
        { name: "edit_file", kwargs: { path: "out.txt", old_text: "hello", new_text: "done" } },
      ]),
      turn([{ name: "read_file", kwargs: { path: "out.txt" } }]), done,
    ] },
    { name: "unknown tool and recoverable tool errors continue", responses: [
      turn([
        { name: "not_registered", kwargs: {} },
        { name: "read_file", kwargs: { path: "../outside.txt" } },
        { name: "edit_file", kwargs: { path: "README.md", old_text: "missing", new_text: "x" } },
        { name: "bash", kwargs: { command: "after errors" } },
      ]), done,
    ] },
    { name: "Unicode log preview truncates code points without truncating history", responses: [
      turn([{ name: "bash", kwargs: { command: "\u{1f680}".repeat(210) } }]), done,
    ] },
    { name: "CLI-style hooks use magenta names and retain extra bash command output", cliHook: true, responses: [
      turn([
        { name: "bash", kwargs: { command: "cli command" } },
        { name: "read_file", kwargs: { path: "README.md" } },
      ]), done,
    ] },
  ];
  try {
    for (const sample of cases) {
      await t.test(sample.name, async () => {
        const initial: Conversation = [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
          { role: "user", content: "hello" },
        ];
        await reset(root);
        const expected = runPython("loop", {
          responses: sample.responses, workdir: root, messages: initial,
        }) as LoopResult;
        const expectedFiles = await snapshot(root);
        await reset(root);
        const actual: LoopResult = {
          messages: structuredClone(initial), requests: [], names: [], commands: [], logs: "",
        };
        const queue = structuredClone(sample.responses);
        const workspace = await createWorkspace(root);
        const registry = new ToolRegistry({
          context: new ToolContext({ workspace, locks: new FileLockRegistry() }),
          hooks: { before: ({ name }) => {
            actual.names.push(name);
            if (sample.cliHook) actual.logs += `\x1b[35m> ${name}\x1b[0m\n`;
          } },
        });
        for (const tool of s02Tools(
          new BashStubTool((command) => { actual.commands.push(command); }),
        )) registry.register(tool);
        // The old `log` collector lives on the presenter now: it prints the bash
        // `$ command` line and the 200 code point result previews, including the
        // blocked results. The registry logger is deliberately left unset, just
        // as this test built its registry without one before: its diagnostics
        // are hook errors and the `Unknown:` line the loop already previews.
        await new AgentLoop({
          model: "test-model", system: systemPrompt(root), registry, workspaceRoot: workspace.root,
          presenter: new ConsoleToolPresenter({ log: (line) => { actual.logs += `${line}\n`; } }),
          client: { messages: { async create(request) {
            actual.requests.push(structuredClone(request));
            const response = queue.shift();
            assert.ok(response, "unexpected extra model request");
            return response;
          } } },
        }).run(new Session(actual.messages));
        assert.equal(queue.length, 0, "all scripted model responses consumed");
        assert.deepEqual(actual.messages, expected.messages, "complete conversation");
        assert.equal(actual.requests.length, expected.requests.length, "request count");
        for (let i = 0; i < actual.requests.length; i += 1) {
          assert.deepEqual(
            normalizePromptText(actual.requests[i]!),
            normalizePromptText(expected.requests[i]!),
            `request ${i + 1} structure with prompt text normalized`,
          );
        }
        const actualPrompts = actual.requests[0]!;
        const expectedPrompts = expected.requests[0] as ModelRequest;
        assert.match(String(actualPrompts.system), CJK, "production system prompt is Chinese");
        assert.ok(!CJK.test(String(expectedPrompts.system)), "lesson system prompt stays English");
        for (const tool of actualPrompts.tools ?? []) {
          const name = (tool as { readonly name?: string }).name;
          const description = (tool as { readonly description?: unknown }).description;
          assert.match(String(description), CJK, `production description for ${name} is Chinese`);
        }
        for (const tool of expectedPrompts.tools ?? []) {
          const name = (tool as { readonly name?: string }).name;
          const description = (tool as { readonly description?: unknown }).description;
          assert.ok(!CJK.test(String(description)), `lesson description for ${name} stays English`);
        }
        const attemptedNames = sample.responses.flatMap((response) => response.content
          .filter((block) => block.type === "tool_use").map((block) => block.name));
        assert.deepEqual(actual.names, attemptedNames, "all attempts, including unknown tools, emit hooks");
        assert.deepEqual(actual.names.filter((name) => name !== "not_registered"), expected.names, "known handler dispatch order");
        assert.deepEqual(actual.commands, expected.commands, "bash command order");
        assert.deepEqual(await snapshot(root), expectedFiles, "filesystem effects");
        assert.equal(expected.logs, expectedLogs(expected.messages, "python"), "Python CLI log contract");
        assert.equal(actual.logs, expectedLogs(actual.messages, "typescript", sample.cliHook), "production log contract");
        if (sample.cliHook) assert.notEqual(actual.logs, expected.logs, "CLI logging intentionally differs");
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
