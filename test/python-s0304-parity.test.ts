import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentLoop } from "../src/agent/AgentLoop.js";
import { Session } from "../src/agent/Session.js";
import { SilentToolPresenter } from "../src/agent/ToolPresenter.js";
import { createDefaultHooks, createSessionSummaryHook } from "../src/hooks/index.js";
import type { HookEvent } from "../src/hooks/index.js";
import {
  ConsoleApprovalPrompt,
  DEFAULT_DENY_LIST,
  DenyAllApprovalPrompt,
  DenyListGate,
  DestructiveCommandRule,
  NO_INTERACTIVE_TERMINAL,
  WorkspaceBoundaryRule,
  containsDestructiveCommand,
  createDefaultPermissionPipeline,
} from "../src/permission/index.js";
import type {
  ApprovalPrompt,
  ApprovalRequest,
  ApprovalResponse,
  GateContext,
  GateOutcome,
  PermissionRequest,
} from "../src/permission/index.js";
import { BashTool } from "../src/tools/BashTool.js";
import { createDefaultTools } from "../src/tools/createDefaultTools.js";
import { FileLockRegistry } from "../src/tools/core/FileLockRegistry.js";
import { ToolContext } from "../src/tools/core/ToolContext.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { createWorkspace } from "../src/workspace.js";
import type { Conversation, ModelResponse } from "../src/types.js";

/**
 * Stands in for the built-in bash tool the way the old `overrides` handler did.
 * It must never run: a denied call is refused before the registry is reached.
 */
class BashStubTool extends BashTool {
  readonly #onRun: () => void;

  constructor(onRun: () => void) {
    super();
    this.#onRun = onRun;
  }

  protected override async run(): Promise<string> {
    this.#onRun();
    return "should never run";
  }
}

const s03Source = fileURLToPath(new URL("../../s03_permission/code.py", import.meta.url));
const s04Source = fileURLToPath(new URL("../../s04_hooks/code.py", import.meta.url));
const candidates = process.env.PYTHON
  ? [process.env.PYTHON]
  : ["python3", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10"];
// s03/s04 use PEP 604 annotations and Path.is_relative_to, both requiring 3.10+.
const python = candidates.find((candidate) =>
  spawnSync(candidate, ["-c", "import sys; sys.exit(sys.version_info < (3, 10))"]).status === 0,
);
const available = existsSync(s03Source) && existsSync(s04Source) && python !== undefined;
const optional = {
  skip: available ? false : "Optional: original s03/s04 lessons and Python 3.10+ are not present",
};

// Shared AST plumbing: every oracle compiles only the lesson nodes it needs, so
// no SDK import, no dotenv, no credentials and no ANTHROPIC_API_KEY are touched.
const PRELUDE = String.raw`
import ast, contextlib, io, json, re, sys, types
from pathlib import Path

path = sys.argv[1]
with open(path, encoding="utf-8") as source:
    tree = ast.parse(source.read())
payload = json.load(sys.stdin)

def take(names):
    return [node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name in names]

def assigns(names):
    return [node for node in tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id in names for target in node.targets)]

def assign_node(nodes, name):
    return next(node for node in nodes
                if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == name for target in node.targets))

def dict_entry(node, key):
    for entry_key, entry_value in zip(node.keys, node.values):
        if isinstance(entry_key, ast.Constant) and entry_key.value == key:
            return entry_value
    raise KeyError(key)

def rule_for(rules_node, tool):
    for entry in rules_node.value.elts:
        tools = dict_entry(entry, "tools")
        if any(isinstance(element, ast.Constant) and element.value == tool
               for element in tools.elts):
            return entry
    raise KeyError(tool)
`;

const S03_ORACLE = PRELUDE + String.raw`
nodes = take({"check_deny_list", "contains_destructive_command", "check_rules",
              "check_permission", "ask_user"})
nodes += assigns({"WORKDIR", "DENY_LIST", "DESTRUCTIVE_COMMAND_WORD", "PERMISSION_RULES"})
scope = {"re": re, "Path": Path}
with contextlib.redirect_stdout(io.StringIO()):
    exec(compile(ast.Module(body=nodes, type_ignores=[]), path, "exec"), scope)

# Lift the bash rule's check expression straight out of PERMISSION_RULES.
rules_node = assign_node(nodes, "PERMISSION_RULES")
workspace_rule = rule_for(rules_node, "read_file")
bash_rule = rule_for(rules_node, "bash")
bash_rule_check = eval(compile(ast.Expression(body=dict_entry(bash_rule, "check")), path, "eval"), scope)

# The denial text agent_loop writes into the tool_result of a blocked call.
denied = []
for loop in take({"agent_loop"}):
    for node in ast.walk(loop):
        if not isinstance(node, ast.If):
            continue
        guards = [call for call in ast.walk(node.test) if isinstance(call, ast.Call)]
        if not any(isinstance(call.func, ast.Name) and call.func.id == "check_permission"
                   for call in guards):
            continue
        for inner in ast.walk(node):
            if not isinstance(inner, ast.Dict):
                continue
            if "content" not in [key.value for key in inner.keys if isinstance(key, ast.Constant)]:
                continue
            value = dict_entry(inner, "content")
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                denied.append(value.value)

with contextlib.redirect_stdout(io.StringIO()):
    mode = payload["mode"]
    if mode == "constants":
        result = {
            "denyList": list(scope["DENY_LIST"]),
            "denied": denied,
            "bashRuleMessage": dict_entry(bash_rule, "message").value,
            "workspaceRuleMessage": dict_entry(workspace_rule, "message").value,
        }
    elif mode == "deny-list":
        result = [scope["check_deny_list"](command) for command in payload["commands"]]
    elif mode == "destructive":
        result = {
            "regex": [scope["contains_destructive_command"](command)
                      for command in payload["commands"]],
            "rule": [bool(bash_rule_check({"command": command})) for command in payload["commands"]],
        }
    elif mode == "outside":
        asked = []
        def fake_ask(tool_name, args, reason):
            asked.append({"toolName": tool_name, "reason": reason})
            return "allow"
        scope["ask_user"] = fake_ask
        block = types.SimpleNamespace(name="write_file", input={"path": payload["path"]})
        result = {
            "checkRules": scope["check_rules"]("write_file", {"path": payload["path"]}),
            "allowed": scope["check_permission"](block),
            "asked": asked,
        }
    elif mode == "ask":
        try:
            result = {"decision": scope["ask_user"](
                "bash", {"command": "rm temp.txt"}, "Potentially destructive command")}
        except EOFError as error:
            result = {"error": type(error).__name__}
    else:
        raise SystemExit("unknown mode: " + mode)
print(json.dumps(result))
`;

const S04_ORACLE = PRELUDE + String.raw`
nodes = take({"register_hook", "contains_destructive_command", "permission_hook", "log_hook",
              "large_output_hook", "context_inject_hook", "summary_hook"})
nodes += assigns({"WORKDIR", "HOOKS", "DENY_LIST"})
# The module-level register_hook(...) calls are the s04 registration order.
registrations = [node for node in tree.body
                 if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                 and isinstance(node.value.func, ast.Name)
                 and node.value.func.id == "register_hook"]
scope = {"re": re, "Path": Path}
summary_logs = io.StringIO()
with contextlib.redirect_stdout(io.StringIO()):
    exec(compile(ast.Module(body=nodes, type_ignores=[]), path, "exec"), scope)
    exec(compile(ast.Module(body=registrations, type_ignores=[]), path, "exec"), scope)
    with contextlib.redirect_stdout(summary_logs):
        scope["summary_hook"](payload["messages"])
result = {
    "hooks": {event: [handler.__name__ for handler in handlers]
              for event, handlers in scope["HOOKS"].items()},
    "registrationCount": len(registrations),
    "summaryLog": summary_logs.getvalue(),
    "denyList": list(scope["DENY_LIST"]),
}
print(json.dumps(result))
`;

function runOracle(oracle: string, source: string, payload: unknown, cwd?: string): unknown {
  assert.ok(python, "Python 3.10+ is required for the s03/s04 reference");
  const result = spawnSync(python, ["-c", oracle, source], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
    ...(cwd === undefined ? {} : { cwd }),
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout) as unknown;
}

function runS03(mode: string, extra: Record<string, unknown> = {}, cwd?: string): unknown {
  return runOracle(S03_ORACLE, s03Source, { mode, ...extra }, cwd);
}

function runS04(mode: string, extra: Record<string, unknown> = {}, cwd?: string): unknown {
  return runOracle(S04_ORACLE, s04Source, { mode, ...extra }, cwd);
}

interface S03Constants {
  readonly denyList: string[];
  readonly denied: string[];
  readonly bashRuleMessage: string;
  readonly workspaceRuleMessage: string;
}

let cachedS03Constants: S03Constants | undefined;

function s03Constants(): S03Constants {
  cachedS03Constants ??= runS03("constants") as S03Constants;
  return cachedS03Constants;
}

function request(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot = "/workspace",
): PermissionRequest {
  return { toolName, input, workspaceRoot };
}

function context(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot = "/workspace",
): GateContext {
  return { request: request(toolName, input, workspaceRoot) };
}

/** Approval prompt that records every consultation and always answers the same. */
class ScriptedApprovalPrompt implements ApprovalPrompt {
  readonly requests: ApprovalRequest[] = [];

  constructor(private readonly response: ApprovalResponse) {}

  async request(approval: ApprovalRequest): Promise<ApprovalResponse> {
    this.requests.push(approval);
    return this.response;
  }
}

function turn(
  calls: readonly { readonly name: string; readonly input: Record<string, unknown> }[],
): ModelResponse {
  return {
    content: [
      { type: "text", text: "working", citations: null },
      ...calls.map((call, index) => ({
        type: "tool_use" as const,
        id: `call-${index}`,
        name: call.name,
        input: call.input,
        caller: { type: "direct" as const },
      })),
    ],
    stop_reason: "tool_use",
  };
}

function finalAnswer(): ModelResponse {
  return { content: [{ type: "text", text: "done", citations: null }], stop_reason: "end_turn" };
}

// -- 1) hard deny list (s03) --

/**
 * Translates the lesson's English deny reason into the Chinese text the production
 * gate prints. This is an intentional divergence (the CLI is Chinese-only), so the
 * mapping is stated here instead of silently dropping the reason comparison. An
 * unexpected lesson wording fails loudly rather than passing through unchanged.
 */
function productionDenyReason(lessonMessage: string): string {
  const match = /^Blocked: '(.+)' is on the deny list$/.exec(lessonMessage);
  assert.ok(match, `unexpected lesson deny reason: ${JSON.stringify(lessonMessage)}`);
  return `已被拒绝：'${match[1]}' 在拒绝列表中`;
}

test("s03 Python parity: hard deny list decisions match DenyListGate", optional, async () => {
  const constants = s03Constants();
  assert.deepEqual(constants.denyList, [...DEFAULT_DENY_LIST], "production keeps the s03 deny list");

  const commands = [
    "rm -rf /",
    "sudo ls",
    "sudo shutdown now",
    "echo reboot",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=disk.img",
    "cat backup > /dev/sda",
    "ls -la",
    "echo sudo is a word",
    "rm -rf build",
    "SUDO ls",
    "echo note",
  ];
  const expected = runS03("deny-list", { commands }) as (string | null)[];
  const gate = new DenyListGate();
  const actual: (GateOutcome | undefined)[] = [];
  for (const command of commands) actual.push(await gate.evaluate(context("bash", { command })));
  assert.deepEqual(
    actual,
    expected.map((message) => (message === null ? undefined : {
      kind: "decide",
      decision: { allowed: false, reason: productionDenyReason(message), gate: "deny-list" },
    })),
  );

  // s03 is a raw substring test, so a deny word inside a sentence still blocks.
  assert.equal(
    expected[commands.indexOf("echo sudo is a word")],
    "Blocked: 'sudo' is on the deny list",
  );
  assert.equal(expected[commands.indexOf("ls -la")], null);
  assert.equal(expected[commands.indexOf("rm -rf build")], null);
  assert.equal(expected[commands.indexOf("SUDO ls")], null, "matching stays case-sensitive");
  // First matching pattern wins, exactly like the production gate.
  assert.equal(
    expected[commands.indexOf("sudo shutdown now")],
    "Blocked: 'sudo' is on the deny list",
  );
  assert.equal(expected[commands.indexOf("rm -rf /")], "Blocked: 'rm -rf /' is on the deny list");
});

// -- 2) destructive command decision (s03) --

test("s03 Python parity: destructive-command decision matches DestructiveCommandRule", optional, () => {
  const commands = [
    "rm temp.txt",
    "ls; rm x",
    "echo rm test",
    "model --version",
    "echo delimiter",
    "echo del test.txt",
    "chmod 777 f",
    "cat > /etc/hosts",
  ];
  const expected = runS03("destructive", { commands }) as { regex: boolean[]; rule: boolean[] };
  const rule = new DestructiveCommandRule();
  // Intentional divergence: the production CLI prints Chinese, the lesson prints English.
  assert.notEqual(rule.message, s03Constants().bashRuleMessage);

  assert.deepEqual(
    commands.map((command) => rule.evaluate(request("bash", { command })) === "ask"),
    expected.rule,
    "DestructiveCommandRule decides exactly like the s03 bash rule",
  );
  assert.deepEqual(
    commands.map((command) => containsDestructiveCommand(command)),
    expected.regex,
    "the word-boundary regex matches s03 contains_destructive_command",
  );

  const asked = expected.rule.map((destructive, index) => (destructive ? commands[index] : null))
    .filter((command): command is string => command !== null);
  assert.deepEqual(asked, [
    "rm temp.txt", "ls; rm x", "echo rm test", "chmod 777 f", "cat > /etc/hosts",
  ]);
  assert.equal(expected.regex[commands.indexOf("echo rm test")], false, "substring list is broader");
  assert.equal(expected.rule[commands.indexOf("echo del test.txt")], false);
});

// -- 3) denial text + pipeline / agent loop integration --

test("s03 Python parity: denial tool_result text equals the s03 literal", optional, async () => {
  const { denied } = s03Constants();
  assert.equal(denied.length, 1, "exactly one denial literal in the s03 agent loop");
  const deniedText = denied[0];
  assert.ok(typeof deniedText === "string" && deniedText.length > 0);

  const root = await mkdtemp(join(tmpdir(), "cw-s0304-denied-"));
  try {
    const pipeline = createDefaultPermissionPipeline({
      workspaceRoot: root,
      approval: new DenyAllApprovalPrompt(),
    });
    assert.deepEqual(await pipeline.check(request("bash", { command: "sudo ls" }, root)), {
      allowed: false, reason: "已被拒绝：'sudo' 在拒绝列表中", gate: "deny-list",
    });
    assert.deepEqual(await pipeline.check(request("bash", { command: "rm temp.txt" }, root)), {
      allowed: false, reason: NO_INTERACTIVE_TERMINAL, gate: "approval",
    });

    const executed: string[] = [];
    const hooks = createDefaultHooks({
      checker: pipeline, workspaceRoot: root, log: () => {}, logger: () => {},
    });
    const queue: ModelResponse[] = [
      turn([
        { name: "bash", input: { command: "sudo ls" } },
        { name: "bash", input: { command: "rm temp.txt" } },
      ]),
      finalAnswer(),
    ];
    const messages: Conversation = [{ role: "user", content: "hello" }];
    const workspace = await createWorkspace(root);
    const registry = new ToolRegistry({
      context: new ToolContext({ workspace, locks: new FileLockRegistry() }),
    });
    for (const tool of createDefaultTools({
      overrides: [new BashStubTool(() => { executed.push("bash"); })],
    })) registry.register(tool);
    await new AgentLoop({
      model: "test-model", system: "test", registry, hooks, workspaceRoot: root,
      // This case asserted an empty log sink, so nothing is presented.
      presenter: new SilentToolPresenter(),
      client: { messages: { async create() {
        const response = queue.shift();
        assert.ok(response, "unexpected extra model request");
        return response;
      } } },
    }).run(new Session(messages));

    assert.equal(queue.length, 0);
    const toolResults: string[] = [];
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === "tool_result") toolResults.push(String(block.content));
      }
    }
    assert.deepEqual(toolResults, [deniedText, deniedText]);
    assert.deepEqual(executed, [], "a denied call never reaches the tool registry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// -- 4) hook events, registration order and session summary (s04) --

const HOOK_NAMES: Readonly<Record<string, string>> = {
  context_inject_hook: "workspace-context",
  permission_hook: "permission",
  log_hook: "log",
  large_output_hook: "large-output",
  summary_hook: "session-summary",
};

const HOOK_EVENTS: readonly HookEvent[] = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

test("s04 Python parity: hook events, registration order and session summary", optional, async () => {
  const messages: Conversation = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "working", citations: null }] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "1", content: "first" },
      { type: "text", text: "ignored" },
      { type: "tool_result", tool_use_id: "2", content: "second" },
    ] },
    { role: "user", content: "plain string content" },
  ];
  const expected = runS04("summary", { messages }) as {
    hooks: Record<string, string[]>;
    registrationCount: number;
    summaryLog: string;
    denyList: string[];
    destructiveWords: string[];
  };

  assert.deepEqual(
    Object.keys(expected.hooks).sort(),
    [...HOOK_EVENTS].sort(),
    "the lesson registers hooks on exactly the four production events",
  );
  assert.equal(expected.registrationCount, 5);
  assert.deepEqual(expected.hooks.PreToolUse, ["permission_hook", "log_hook"]);
  assert.deepEqual(expected.hooks.UserPromptSubmit, ["context_inject_hook"]);
  assert.deepEqual(expected.hooks.PostToolUse, ["large_output_hook"]);
  assert.deepEqual(expected.hooks.Stop, ["summary_hook"]);

  const root = await mkdtemp(join(tmpdir(), "cw-s0304-hooks-"));
  try {
    const bus = createDefaultHooks({
      checker: { async check() { return { allowed: true, reason: "", gate: "test" }; } },
      workspaceRoot: root,
      log: () => {},
      logger: () => {},
    });
    // s05 appends `todo-plan` after `large-output` on PostToolUse, so the
    // production list holds the s04 handlers plus exactly one extra handler.
    const s04PostToolUse = (expected.hooks.PostToolUse ?? []).map(
      (name) => HOOK_NAMES[name] as string,
    );
    assert.ok(!s04PostToolUse.includes("todo-plan"), "s04 does not register todo-plan");
    for (const event of HOOK_EVENTS) {
      const pythonHandlers = expected.hooks[event];
      assert.ok(pythonHandlers, event);
      const s04Names = pythonHandlers.map((name) => HOOK_NAMES[name] as string);
      assert.deepEqual(
        bus.listHandlers(event).filter((name) => s04Names.includes(name)),
        s04Names,
        `${event} keeps the s04 handler order`,
      );
    }
    assert.deepEqual(
      bus.listHandlers("PostToolUse").filter((name) => !s04PostToolUse.includes(name)),
      ["todo-plan"],
      "s05 adds exactly one PostToolUse handler: todo-plan",
    );
    assert.equal(
      HOOK_EVENTS.reduce((total, event) => total + bus.listHandlers(event).length, 0),
      6,
      "five s04 hooks plus the s05 todo-plan hook",
    );
    // The permission handler must win the race against the logger on PreToolUse.
    const order = bus.listHandlers("PreToolUse");
    const permissionIndex = order.indexOf(HOOK_NAMES.permission_hook as string);
    const logIndex = order.indexOf(HOOK_NAMES.log_hook as string);
    assert.ok(permissionIndex !== -1 && logIndex !== -1);
    assert.ok(permissionIndex < logIndex, "permission handler runs before the log handler");

    // Same fixture: s04 summary_hook and the production Stop hook agree.
    const pythonCount = Number(/session used (\d+) tool calls/.exec(expected.summaryLog)?.[1]);
    assert.equal(pythonCount, 2);
    const logs: string[] = [];
    await createSessionSummaryHook({ log: (line) => logs.push(line) })({ messages, workspaceRoot: root });
    const productionCount = Number(/共 (\d+) 次工具调用/.exec(logs[0] ?? "")?.[1]);
    assert.equal(productionCount, pythonCount);

    // Documented lesson drift: s04 dropped the last s03 deny pattern while
    // production still ships the full s03 list (asserted in the deny-list test).
    assert.deepEqual(
      expected.denyList,
      s03Constants().denyList.filter((pattern) => pattern !== "> /dev/sda"),
      "s04 permission_hook omits '> /dev/sda'",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// -- 5) declared divergences between the lessons and production --

test("s03 divergences: workspace escape asks in the lesson, denies in production", optional, async () => {
  const constants = s03Constants();
  const root = await mkdtemp(join(tmpdir(), "cw-s0304-jail-"));
  try {
    const escaping = { path: "../outside.txt" };
    const lesson = runS03("outside", { path: escaping.path }, root) as {
      checkRules: string | null;
      allowed: boolean;
      asked: { toolName: string; reason: string }[];
    };
    // s03: the rule matches and the user is asked; with a yes the call proceeds.
    assert.equal(lesson.checkRules, constants.workspaceRuleMessage);
    assert.deepEqual(lesson.asked, [{
      toolName: "write_file", reason: constants.workspaceRuleMessage,
    }]);
    assert.equal(lesson.allowed, true);

    // production: the jail is a hard boundary, so the rule denies outright.
    const rule = new WorkspaceBoundaryRule();
    assert.equal(rule.evaluate(request("write_file", escaping, root)), "deny");
    assert.equal(rule.message, "访问工作区之外的路径");
    // The wording is an intentional, separately asserted divergence.
    assert.notEqual(rule.message, constants.workspaceRuleMessage);

    const approval = new ScriptedApprovalPrompt({ decision: "allow" });
    const pipeline = createDefaultPermissionPipeline({ workspaceRoot: root, approval });
    assert.deepEqual(await pipeline.check(request("write_file", escaping, root)), {
      allowed: false, reason: rule.message, gate: "rules",
    });
    assert.equal(approval.requests.length, 0, "an allow-by-default user cannot relax the jail");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("s03 divergences: non-interactive approval fails closed instead of raising", optional, async () => {
  const lesson = runS03("ask") as { decision?: string; error?: string };
  // s03 calls input(); with no TTY the read raises EOFError and the loop dies.
  assert.equal(lesson.decision, undefined);
  assert.equal(lesson.error, "EOFError");

  let asked = false;
  const prompt = new ConsoleApprovalPrompt({
    isInteractive: false,
    log: () => {},
    question: async () => {
      asked = true;
      return "y";
    },
  });
  const root = await mkdtemp(join(tmpdir(), "cw-s0304-tty-"));
  try {
    const pipeline = createDefaultPermissionPipeline({ workspaceRoot: root, approval: prompt });
    const decision = await pipeline.check(request("bash", { command: "rm temp.txt" }, root))
      .then((value) => value, () => null);
    assert.deepEqual(decision, {
      allowed: false, reason: NO_INTERACTIVE_TERMINAL, gate: "approval",
    });
    assert.equal(NO_INTERACTIVE_TERMINAL, "没有交互式终端，无法确认");
    assert.equal(asked, false, "a non-interactive prompt never reads stdin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
