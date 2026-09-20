import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  APPROVAL_QUESTION,
  ApprovalGate,
  ConsoleApprovalPrompt,
  DEFAULT_DENY_LIST,
  DenyAllApprovalPrompt,
  DenyListGate,
  DestructiveCommandRule,
  NO_INTERACTIVE_TERMINAL,
  PermissionGate,
  PermissionPipeline,
  RuleGate,
  WorkspaceBoundaryRule,
  containsDestructiveCommand,
  createDefaultPermissionPipeline,
  createPermissionPipeline,
  defaultPermissionRules,
} from "../src/permission/index.js";
import type {
  ApprovalPrompt,
  ApprovalRequest,
  ApprovalResponse,
  GateContext,
  GateOutcome,
  PermissionRequest,
  PermissionRule,
} from "../src/permission/index.js";

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

/** Stub gate that records every call, mirroring the shape Task 2 will provide. */
class RecordingGate extends PermissionGate {
  readonly name: string;
  readonly calls: GateContext[] = [];
  private readonly behavior: (context: GateContext) => GateOutcome | undefined;

  constructor(
    name: string,
    behavior: (context: GateContext) => GateOutcome | undefined = () => undefined,
  ) {
    super();
    this.name = name;
    this.behavior = behavior;
  }

  async evaluate(context_: GateContext): Promise<GateOutcome | undefined> {
    this.calls.push(context_);
    return this.behavior(context_);
  }
}

test("DenyListGate keeps the s03 deny list verbatim and in order", () => {
  assert.deepEqual([...DEFAULT_DENY_LIST], [
    "rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda",
  ]);
});

for (const pattern of DEFAULT_DENY_LIST) {
  test(`DenyListGate blocks bash command containing ${JSON.stringify(pattern)}`, async () => {
    const gate = new DenyListGate();
    assert.equal(gate.name, "deny-list");
    const command = `echo start && ${pattern}`;
    assert.deepEqual(await gate.evaluate(context("bash", { command })), {
      kind: "decide",
      decision: {
        allowed: false,
        reason: `Blocked: '${pattern}' is on the deny list`,
        gate: "deny-list",
      },
    });
  });
}

test("DenyListGate reports the first matching pattern and ignores other tools", async () => {
  const gate = new DenyListGate();
  assert.deepEqual(await gate.evaluate(context("bash", { command: "echo ok; sudo ls" })), {
    kind: "decide",
    decision: {
      allowed: false,
      reason: "Blocked: 'sudo' is on the deny list",
      gate: "deny-list",
    },
  });
  assert.equal(await gate.evaluate(context("read_file", { command: "sudo ls" })), undefined);
  assert.equal(await gate.evaluate(context("bash", { command: "ls -la" })), undefined);
  // Non-string commands are treated as an empty command, not as a hit.
  assert.equal(await gate.evaluate(context("bash", { command: 42 })), undefined);
  assert.equal(await gate.evaluate(context("bash", {})), undefined);
  // Matching is case-sensitive, like s03.
  assert.equal(await gate.evaluate(context("bash", { command: "SUDO ls" })), undefined);
});

test("DenyListGate accepts a custom deny list", async () => {
  const gate = new DenyListGate(["nope"]);
  assert.deepEqual(await gate.evaluate(context("bash", { command: "echo nope" })), {
    kind: "decide",
    decision: { allowed: false, reason: "Blocked: 'nope' is on the deny list", gate: "deny-list" },
  });
  assert.equal(await gate.evaluate(context("bash", { command: "sudo ls" })), undefined);
});

test("WorkspaceBoundaryRule denies escapes and allows in-workspace paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-perm-rule-"));
  try {
    const rule = new WorkspaceBoundaryRule();
    assert.equal(rule.name, "workspace-boundary");
    assert.deepEqual([...rule.tools], ["read_file", "write_file", "edit_file"]);
    assert.equal(rule.message, "Access outside workspace");

    assert.equal(rule.evaluate(request("write_file", { path: "../outside.txt" }, root)), "deny");
    assert.equal(rule.evaluate(request("write_file", { path: "/etc/passwd" }, root)), "deny");
    assert.equal(rule.evaluate(request("edit_file", { path: "a/../../x" }, root)), "deny");
    assert.equal(rule.evaluate(request("read_file", { path: "src/agent.ts" }, root)), undefined);
    assert.equal(rule.evaluate(request("read_file", { path: "./a/b.txt" }, root)), undefined);
    assert.equal(rule.evaluate(request("write_file", { path: `${root}/inside.txt` }, root)), undefined);
    // Missing / non-string paths are not this rule's business.
    assert.equal(rule.evaluate(request("write_file", {}, root)), undefined);
    assert.equal(rule.evaluate(request("write_file", { path: 42 }, root)), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("containsDestructiveCommand mirrors the s03 regex semantics", () => {
  for (const command of ["rm temp.txt", "rm -rf build", "ls; rm x", "echo ok\nrm x", "echo ok; DeL x"]) {
    assert.equal(containsDestructiveCommand(command), true, command);
  }
  for (const command of ["model --version", "echo delimiter", "echo del test.txt", "ls -la", ""]) {
    assert.equal(containsDestructiveCommand(command), false, command);
  }
});

test("DestructiveCommandRule asks on destructive commands and abstains otherwise", () => {
  const rule = new DestructiveCommandRule();
  assert.equal(rule.name, "destructive-command");
  assert.deepEqual([...rule.tools], ["bash"]);
  assert.equal(rule.message, "Potentially destructive command");

  for (const command of ["rm temp.txt", "rm -rf build", "ls; rm x", "echo rm test"]) {
    assert.equal(rule.evaluate(request("bash", { command })), "ask", command);
  }
  for (const command of ["model --version", "echo delimiter", "echo del test.txt"]) {
    assert.equal(rule.evaluate(request("bash", { command })), undefined, command);
  }
  assert.equal(rule.evaluate(request("bash", { command: "echo x > /etc/hosts" })), "ask");
  assert.equal(rule.evaluate(request("bash", { command: "chmod 777 z" })), "ask");
  assert.equal(rule.evaluate(request("bash", { command: 42 })), undefined);
  assert.equal(rule.evaluate(request("bash", {})), undefined);
});

test("defaultPermissionRules registers workspace-boundary before destructive-command", () => {
  assert.deepEqual(
    defaultPermissionRules.map((rule) => rule.name),
    ["workspace-boundary", "destructive-command"],
  );
});

test("RuleGate maps deny/ask and only consults rules that cover the tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-perm-gate-"));
  try {
    const gate = new RuleGate();
    assert.equal(gate.name, "rules");

    assert.deepEqual(await gate.evaluate(context("write_file", { path: "../escape.txt" }, root)), {
      kind: "decide",
      decision: { allowed: false, reason: "Access outside workspace", gate: "rules" },
    });
    assert.deepEqual(await gate.evaluate(context("bash", { command: "rm -rf build" })), {
      kind: "ask",
      reason: "Potentially destructive command",
      gate: "rules",
    });
    assert.equal(await gate.evaluate(context("read_file", { path: "src/agent.ts" }, root)), undefined);
    assert.equal(await gate.evaluate(context("glob", { pattern: "**/*.ts" })), undefined);

    const globOnly = new RuleGate([
      { name: "glob-only", tools: ["glob"], message: "never for bash", evaluate: () => "deny" },
    ]);
    assert.equal(await globOnly.evaluate(context("bash", { command: "ls" })), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RuleGate lets the first matching rule win and maps all three actions", async () => {
  const askRule: PermissionRule = {
    name: "ask-rule", tools: ["bash"], message: "ask message", evaluate: () => "ask",
  };
  const denyRule: PermissionRule = {
    name: "deny-rule", tools: ["bash"], message: "deny message", evaluate: () => "deny",
  };
  const allowRule: PermissionRule = {
    name: "allow-rule", tools: ["bash"], message: "allow message", evaluate: () => "allow",
  };
  const input = context("bash", { command: "ls" });

  assert.deepEqual(await new RuleGate([askRule, denyRule]).evaluate(input), {
    kind: "ask", reason: "ask message", gate: "rules",
  });
  assert.deepEqual(await new RuleGate([denyRule, askRule]).evaluate(input), {
    kind: "decide",
    decision: { allowed: false, reason: "deny message", gate: "rules" },
  });
  assert.deepEqual(await new RuleGate([allowRule, denyRule]).evaluate(input), {
    kind: "decide",
    decision: { allowed: true, reason: "", gate: "rules" },
  });
  assert.equal(await new RuleGate([]).evaluate(input), undefined);
});

test("PermissionPipeline runs gates in order and short-circuits on a decision", async () => {
  const first = new RecordingGate("first", () => ({
    kind: "decide",
    decision: { allowed: false, reason: "blocked", gate: "first" },
  }));
  const second = new RecordingGate("second");
  const third = new RecordingGate("third");
  const pipeline = new PermissionPipeline([first, second, third]);

  assert.deepEqual([...pipeline.listGates()], ["first", "second", "third"]);
  assert.deepEqual(await pipeline.check(request("bash", { command: "ls" })), {
    allowed: false, reason: "blocked", gate: "first",
  });
  assert.equal(first.calls.length, 1, "first gate runs");
  assert.equal(second.calls.length, 0, "gates after a decision must not run");
  assert.equal(third.calls.length, 0, "gates after a decision must not run");
});

test("PermissionPipeline forwards a pending ask to later gates and fails closed when none resolves", async () => {
  const asking = new RecordingGate("rules", () => ({
    kind: "ask", reason: "Potentially destructive command", gate: "rules",
  }));
  const sink = new RecordingGate("approval");
  const pipeline = createPermissionPipeline([asking, sink]);

  assert.deepEqual(await pipeline.check(request("bash", { command: "rm -rf build" })), {
    allowed: false, reason: "unresolved permission request", gate: "pipeline",
  });
  assert.equal(sink.calls.length, 1);
  assert.deepEqual(sink.calls[0]?.ask, { reason: "Potentially destructive command", gate: "rules" });
  assert.equal(sink.calls[0]?.request.toolName, "bash");

  const abstaining = new RecordingGate("quiet");
  assert.deepEqual(await new PermissionPipeline([abstaining]).check(request("bash", { command: "ls" })), {
    allowed: true, reason: "", gate: "default",
  });
  assert.equal(abstaining.calls[0]?.ask, undefined);
});

test("PermissionPipeline fails closed when a gate throws", async () => {
  const before = new RecordingGate("before");
  const exploding = new RecordingGate("exploding", () => {
    throw new Error("boom");
  });
  const after = new RecordingGate("after");
  const pipeline = new PermissionPipeline([before, exploding, after]);

  assert.deepEqual(await pipeline.check(request("bash", { command: "ls" })), {
    allowed: false, reason: "permission gate error: boom", gate: "exploding",
  });
  assert.equal(before.calls.length, 1);
  assert.equal(after.calls.length, 0);

  const throwingValue = new RecordingGate("throwing-value", () => {
    throw "bang";
  });
  assert.deepEqual(await new PermissionPipeline([throwingValue]).check(request("bash", { command: "ls" })), {
    allowed: false, reason: "permission gate error: bang", gate: "throwing-value",
  });
});

test("default gate order composes as deny-list, rules, approval", async () => {
  const approval = new RecordingGate("approval", (context_) => (context_.ask === undefined
    ? undefined
    : { kind: "decide", decision: { allowed: true, reason: "", gate: "approval" } }));
  const pipeline = createPermissionPipeline([new DenyListGate(), new RuleGate(), approval]);
  assert.deepEqual([...pipeline.listGates()], ["deny-list", "rules", "approval"]);

  assert.deepEqual(await pipeline.check(request("bash", { command: "sudo ls" })), {
    allowed: false, reason: "Blocked: 'sudo' is on the deny list", gate: "deny-list",
  });
  assert.equal(approval.calls.length, 0, "a deny must not reach the approval gate");

  assert.deepEqual(await pipeline.check(request("bash", { command: "ls -la" })), {
    allowed: true, reason: "", gate: "default",
  });
  assert.equal(approval.calls.length, 1);
  assert.equal(approval.calls[0]?.ask, undefined);

  assert.deepEqual(await pipeline.check(request("bash", { command: "rm -rf build" })), {
    allowed: true, reason: "", gate: "approval",
  });
  assert.deepEqual(approval.calls[1]?.ask, {
    reason: "Potentially destructive command", gate: "rules",
  });
});

// -- Task 2: user approval gate --

/** Approval prompt whose single response (or failure) is fixed up front. */
class ScriptedApprovalPrompt implements ApprovalPrompt {
  readonly requests: ApprovalRequest[] = [];
  private readonly outcome: ApprovalResponse | Error;

  constructor(outcome: ApprovalResponse | Error) {
    this.outcome = outcome;
  }

  async request(request_: ApprovalRequest): Promise<ApprovalResponse> {
    this.requests.push(request_);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

function askContext(
  toolName = "bash",
  input: Record<string, unknown> = { command: "rm x" },
): GateContext {
  return {
    request: request(toolName, input),
    ask: { reason: "Potentially destructive command", gate: "rules" },
  };
}

test("ConsoleApprovalPrompt allows y/yes answers and prints the s03 banner", async () => {
  assert.equal(APPROVAL_QUESTION, "   Allow? [y/N] ");
  for (const answer of ["y", " Y ", "yes", "YES"]) {
    const lines: string[] = [];
    let asked = "";
    const prompt = new ConsoleApprovalPrompt({
      isInteractive: true,
      log: (message) => { lines.push(message); },
      question: async (promptText) => { asked = promptText; return answer; },
    });

    const response = await prompt.request({
      toolName: "bash", input: { command: "rm x" }, reason: "Potentially destructive command",
    });
    assert.deepEqual(response, { decision: "allow" }, answer);
    assert.equal(asked, "   Allow? [y/N] ", answer);
    assert.equal(lines.length, 2, answer);
    assert.equal(lines[0], "\n\x1b[33m[permission] Potentially destructive command\x1b[0m", answer);
    assert.equal(lines[1], `   Tool: bash(${JSON.stringify({ command: "rm x" })})`, answer);
    assert.ok(lines[0]?.includes("[permission]"), answer);
    assert.ok(lines[1]?.includes("Tool: "), answer);
  }
});

test("ConsoleApprovalPrompt denies anything that is not y/yes", async () => {
  for (const answer of ["n", "", "whatever", "no", "yep"]) {
    const prompt = new ConsoleApprovalPrompt({
      isInteractive: true,
      log: () => {},
      question: async () => answer,
    });
    assert.deepEqual(
      await prompt.request({ toolName: "bash", input: { command: "rm x" }, reason: "why" }),
      { decision: "deny" },
      JSON.stringify(answer),
    );
  }
});

test("ConsoleApprovalPrompt never prompts without an interactive terminal", async () => {
  const lines: string[] = [];
  let asked = false;
  const prompt = new ConsoleApprovalPrompt({
    isInteractive: false,
    log: (message) => { lines.push(message); },
    question: async () => { asked = true; return "y"; },
  });

  assert.deepEqual(await prompt.request({ toolName: "bash", input: { command: "rm x" }, reason: "why" }), {
    decision: "deny", reason: "no interactive terminal",
  });
  assert.equal(asked, false, "a non-interactive prompt must not read stdin");
  assert.deepEqual(lines, [], "a non-interactive prompt must not print");
  assert.equal(NO_INTERACTIVE_TERMINAL, "no interactive terminal");
});

test("ConsoleApprovalPrompt fails closed when the question rejects", async () => {
  const failing = new ConsoleApprovalPrompt({
    isInteractive: true,
    log: () => {},
    question: async () => { throw new Error("readline closed"); },
  });
  const response = await failing.request({ toolName: "bash", input: {}, reason: "why" });
  assert.equal(response.decision, "deny");
  assert.ok(response.reason?.startsWith("approval prompt failed:"), response.reason);
  assert.equal(response.reason, "approval prompt failed: readline closed");

  const throwingValue = new ConsoleApprovalPrompt({
    isInteractive: true,
    log: () => {},
    question: async () => { throw "eof"; },
  });
  assert.deepEqual(await throwingValue.request({ toolName: "bash", input: {}, reason: "why" }), {
    decision: "deny", reason: "approval prompt failed: eof",
  });
});

test("DenyAllApprovalPrompt denies every request without printing", async () => {
  const prompt = new DenyAllApprovalPrompt();
  assert.deepEqual(await prompt.request({ toolName: "bash", input: { command: "rm x" }, reason: "why" }), {
    decision: "deny", reason: "no interactive terminal",
  });
  assert.deepEqual(await prompt.request({ toolName: "glob", input: {}, reason: "why" }), {
    decision: "deny", reason: NO_INTERACTIVE_TERMINAL,
  });
});

test("ApprovalGate abstains when no gate raised an ask", async () => {
  const prompt = new ScriptedApprovalPrompt({ decision: "allow" });
  const gate = new ApprovalGate(prompt);

  assert.equal(gate.name, "approval");
  assert.equal(await gate.evaluate(context("bash", { command: "rm x" })), undefined);
  assert.equal(await gate.evaluate(context("glob", { pattern: "*.ts" })), undefined);
  assert.equal(prompt.requests.length, 0, "abstaining must not consult the prompt");
});

test("ApprovalGate maps allow/deny responses onto approval decisions", async () => {
  const allowing = new ScriptedApprovalPrompt({ decision: "allow" });
  assert.deepEqual(await new ApprovalGate(allowing).evaluate(askContext()), {
    kind: "decide",
    decision: { allowed: true, reason: "", gate: "approval" },
  });
  assert.deepEqual(allowing.requests, [{
    toolName: "bash", input: { command: "rm x" }, reason: "Potentially destructive command",
  }]);

  const denying = new ScriptedApprovalPrompt({ decision: "deny" });
  assert.deepEqual(await new ApprovalGate(denying).evaluate(askContext()), {
    kind: "decide",
    decision: { allowed: false, reason: "Permission denied by user", gate: "approval" },
  });

  const nonInteractive = new ScriptedApprovalPrompt({
    decision: "deny", reason: "no interactive terminal",
  });
  assert.deepEqual(await new ApprovalGate(nonInteractive).evaluate(askContext()), {
    kind: "decide",
    decision: { allowed: false, reason: "no interactive terminal", gate: "approval" },
  });
});

test("ApprovalGate fails closed when the prompt throws", async () => {
  const gate = new ApprovalGate(new ScriptedApprovalPrompt(new Error("prompt broke")));
  assert.deepEqual(await gate.evaluate(askContext()), {
    kind: "decide",
    decision: { allowed: false, reason: "permission gate error: prompt broke", gate: "approval" },
  });
});

test("createDefaultPermissionPipeline wires deny-list, rules and approval in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-perm-default-"));
  try {
    const approval = new ScriptedApprovalPrompt({ decision: "deny" });
    const pipeline = createDefaultPermissionPipeline({ workspaceRoot: root, approval });
    assert.deepEqual([...pipeline.listGates()], ["deny-list", "rules", "approval"]);

    // A destructive bash command reaches the approval gate.
    assert.deepEqual(await pipeline.check(request("bash", { command: "rm temp.txt" }, root)), {
      allowed: false, reason: "Permission denied by user", gate: "approval",
    });
    assert.equal(approval.requests.length, 1);
    assert.equal(approval.requests[0]?.toolName, "bash");
    assert.equal(approval.requests[0]?.reason, "Potentially destructive command");
    assert.deepEqual(approval.requests[0]?.input, { command: "rm temp.txt" });

    // The deny list short-circuits before approval is ever consulted.
    assert.deepEqual(await pipeline.check(request("bash", { command: "sudo ls" }, root)), {
      allowed: false, reason: "Blocked: 'sudo' is on the deny list", gate: "deny-list",
    });
    assert.equal(approval.requests.length, 1, "a deny-list hit must not ask the user");

    // No rule triggers -> default allow, still no approval call.
    assert.deepEqual(await pipeline.check(request("glob", { pattern: "*.ts" }, root)), {
      allowed: true, reason: "", gate: "default",
    });
    assert.equal(approval.requests.length, 1);

    // A rule denial is final and does not ask either.
    assert.deepEqual(await pipeline.check(request("write_file", { path: "../x.txt" }, root)), {
      allowed: false, reason: "Access outside workspace", gate: "rules",
    });
    assert.equal(approval.requests.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createDefaultPermissionPipeline lets an approved command through", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-perm-approved-"));
  try {
    const approval = new ScriptedApprovalPrompt({ decision: "allow" });
    const pipeline = createDefaultPermissionPipeline({ workspaceRoot: root, approval });

    assert.deepEqual(await pipeline.check(request("bash", { command: "rm temp.txt" }, root)), {
      allowed: true, reason: "", gate: "approval",
    });
    assert.equal(approval.requests.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createDefaultPermissionPipeline denies when approval is non-interactive", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-perm-noninteractive-"));
  try {
    const pipeline = createDefaultPermissionPipeline({
      workspaceRoot: root,
      approval: new DenyAllApprovalPrompt(),
    });

    assert.deepEqual(await pipeline.check(request("bash", { command: "rm temp.txt" }, root)), {
      allowed: false, reason: "no interactive terminal", gate: "approval",
    });
    assert.deepEqual(await pipeline.check(request("bash", { command: "ls -la" }, root)), {
      allowed: true, reason: "", gate: "default",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createDefaultPermissionPipeline honours an explicit gate override", async () => {
  const root = await mkdtemp(join(tmpdir(), "cw-perm-gates-"));
  try {
    const pipeline = createDefaultPermissionPipeline({
      workspaceRoot: root,
      approval: new DenyAllApprovalPrompt(),
      gates: [new DenyListGate()],
    });

    assert.deepEqual([...pipeline.listGates()], ["deny-list"]);
    assert.deepEqual(await pipeline.check(request("bash", { command: "sudo ls" }, root)), {
      allowed: false, reason: "Blocked: 'sudo' is on the deny list", gate: "deny-list",
    });
    assert.deepEqual(await pipeline.check(request("bash", { command: "rm temp.txt" }, root)), {
      allowed: true, reason: "", gate: "default",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ask that no gate resolves is denied instead of silently allowed", async () => {
  const asking = new RecordingGate("rules", () => ({
    kind: "ask", reason: "Potentially destructive command", gate: "rules",
  }));
  const decision = await new PermissionPipeline([asking]).check(
    request("bash", { command: "rm -rf build" }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.gate, "pipeline");
  assert.match(decision.reason, /unresolved permission request/);

  const root = await mkdtemp(join(tmpdir(), "cw-perm-unresolved-"));
  try {
    // The default chain still resolves the same ask through the approval gate.
    const approval = new ScriptedApprovalPrompt({ decision: "allow" });
    const pipeline = createDefaultPermissionPipeline({ workspaceRoot: root, approval });
    assert.deepEqual(await pipeline.check(request("bash", { command: "rm temp.txt" }, root)), {
      allowed: true, reason: "", gate: "approval",
    });
    assert.equal(approval.requests.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
