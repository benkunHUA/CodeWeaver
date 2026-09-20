import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { agentLoop } from "../src/agent.js";
import { runBash } from "../src/bash.js";
import { createToolRegistry } from "../src/tools/registry.js";
import type { AnthropicTool, Conversation, ModelRequest, ModelResponse } from "../src/types.js";

const source = fileURLToPath(new URL("../../s01_agent_loop/code.py", import.meta.url));
const python = process.env.PYTHON ?? "python3";
const available = existsSync(source) && spawnSync(python, ["--version"]).status === 0;

// Extract the actual lesson functions without importing SDKs, dotenv or secrets.
const oracle = String.raw`
import ast, contextlib, copy, io, json, os, subprocess, sys, types
path = sys.argv[1]
with open(path, encoding="utf-8") as source:
    tree = ast.parse(source.read())
nodes = [
    n for n in tree.body
    if (isinstance(n, ast.FunctionDef) and n.name in ("agent_loop", "run_bash"))
    or (isinstance(n, ast.Assign) and any(
        isinstance(t, ast.Name) and t.id in ("SYSTEM", "TOOLS") for t in n.targets))
]
scope = {"os": os, "subprocess": subprocess}
exec(compile(ast.Module(body=nodes, type_ignores=[]), path, "exec"), scope)
payload = json.load(sys.stdin)
if payload["mode"] == "bash":
    result = [scope["run_bash"](command) for command in payload["commands"]]
else:
    responses = iter(payload["responses"])
    requests, commands = [], []
    def create(**kwargs):
        requests.append(copy.deepcopy(kwargs))
        response = next(responses)
        return types.SimpleNamespace(
            stop_reason=response["stop_reason"],
            content=[types.SimpleNamespace(**block) for block in response["content"]])
    def run(command):
        commands.append(command)
        return "result:" + command
    scope.update(
        client=types.SimpleNamespace(messages=types.SimpleNamespace(create=create)),
        MODEL="test-model", run_bash=run)
    messages = [{"role": "user", "content": "hello"}]
    logs = io.StringIO()
    with contextlib.redirect_stdout(logs):
        scope["agent_loop"](messages)
    result = dict(messages=messages, requests=requests, commands=commands, logs=logs.getvalue())
print(json.dumps(result, default=lambda value: vars(value)))
`;

function reference(payload: unknown): unknown {
  const result = spawnSync(python, ["-c", oracle, source], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout) as unknown;
}

test("Python parity: shell outputs, error policy, Unicode and truncation", {
  skip: available ? false : "Optional: original Python lesson and Python 3 are not present",
}, async () => {
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const node = (s: string) => `${quote(process.execPath)} -e ${quote(s)}`;
  const commands = [
    "printf hello", "printf err >&2", "printf err >&2; printf out; exit 7",
    "exit 3", "printf ' \\n\\t'", "printf 'a\\r\\nb\\rc'",
    "printf hello | tr a-z A-Z",
    "echo sudo", "rm -rf /", "shutdown", "reboot", "> /dev/null",
    "__s01_nonexistent_command__",
    node("process.stdout.write(Buffer.from([0xe4,0xb8,0xad,0xff]))"),
    node("process.stdout.write('\\u{1f680}'.repeat(50005))"),
    node("process.stdout.write('\\u0085hello\\u001c')"),
  ];
  const expected = reference({ mode: "bash", commands });
  const actual = [];
  for (const command of commands) actual.push(await runBash(command));
  assert.deepEqual(actual, expected);
});

test("Python parity: identical requests, history mutations, command order and logs", {
  skip: available ? false : "Optional: original Python lesson and Python 3 are not present",
}, async () => {
  const cases: ModelResponse[][] = [
    [{ content: [], stop_reason: "tool_use" }],
    [{ content: [{ type: "text", text: "", citations: null }], stop_reason: "tool_use" }],
    [{ content: [{ type: "text", text: "finished", citations: null }], stop_reason: "end_turn" }],
    [
      {
        content: [
          { type: "text", text: "working", citations: null },
          { type: "tool_use", id: "a", name: "bash", input: { command: "first" }, caller: { type: "direct" } },
          { type: "tool_use", id: "b", name: "bash", input: { command: "\u{1f680}".repeat(210) }, caller: { type: "direct" } },
        ],
        stop_reason: "end_turn",
      },
      {
        content: [{
          type: "tool_use", id: "c", name: "bash", input: { command: "third" }, caller: { type: "direct" },
        }],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "done", citations: null }], stop_reason: "end_turn" },
    ],
  ];
  for (const responses of cases) {
    const expected = reference({ mode: "loop", responses }) as {
      readonly messages: unknown;
      readonly requests: ModelRequest[];
      readonly commands: readonly string[];
      readonly logs: string;
    };
    const queue = [...responses];
    const requests: ModelRequest[] = [];
    const commands: string[] = [];
    let logs = "";
    const messages: Conversation = [{ role: "user", content: "hello" }];
    const firstRequest = expected.requests[0];
    assert.ok(firstRequest);
    assert.equal(typeof firstRequest.system, "string");
    assert.equal(firstRequest.tools?.length, 1);
    const bashSchema = firstRequest.tools?.[0] as AnthropicTool;
    assert.equal(bashSchema.name, "bash");
    // s01 exposes only bash. Supply its real schema before the request is made;
    // never replace captured request fields to make the comparison pass.
    const registry = createToolRegistry([{
      name: "bash",
      schema: structuredClone(bashSchema),
      handler: async (input: { command: string }) => {
        assert.ok("command" in input);
        commands.push(input.command);
        return `result:${input.command}`;
      },
    }]);
    await agentLoop(messages, {
      model: "test-model",
      system: firstRequest.system as string,
      registry,
      client: { messages: { async create(request) {
        requests.push(structuredClone(request));
        const response = queue.shift();
        assert.ok(response);
        return response;
      } } },
      log: (line) => { logs += `${line}\n`; },
    });
    assert.equal(queue.length, 0);
    assert.deepEqual({ messages, requests, commands, logs }, expected);
  }
});
