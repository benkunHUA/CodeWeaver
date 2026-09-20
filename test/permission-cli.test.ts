import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { agentLoop } from "../src/agent.js";
import { createDefaultHooks, type HookBus } from "../src/hooks/index.js";
import {
  APPROVAL_QUESTION,
  ConsoleApprovalPrompt,
  createDefaultPermissionPipeline,
} from "../src/permission/index.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import type { Conversation, ModelClient, ModelRequest, ModelResponse } from "../src/types.js";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const text = (value: string): ContentBlock => ({
  type: "text", text: value, citations: null,
});

const bashCall = (id: string, command: string): ContentBlock => ({
  type: "tool_use", id, name: "bash", input: { command }, caller: { type: "direct" },
});

function fakeClient(responses: ModelResponse[]) {
  const requests: ModelRequest[] = [];
  const client: ModelClient = {
    messages: {
      async create(request) {
        requests.push(structuredClone(request));
        const response = responses.shift();
        assert.ok(response, "Unexpected extra model turn");
        return response;
      },
    },
  };
  return { client, requests };
}

interface ScriptedSession {
  readonly hooks: HookBus;
  readonly logs: string[];
  readonly asked: string[];
}

/**
 * Production-shaped wiring except for the one thing a piped test process
 * cannot provide: an interactive terminal. The approval answer is scripted
 * through the prompt's injectable `question`, and every console line the
 * user would see is collected instead of printed.
 */
function scriptedSession(workspaceRoot: string, answer: string): ScriptedSession {
  const logs: string[] = [];
  const asked: string[] = [];
  const approval = new ConsoleApprovalPrompt({
    isInteractive: true,
    log: (message) => { logs.push(message); },
    question: async (promptText) => { asked.push(promptText); return answer; },
  });
  const pipeline = createDefaultPermissionPipeline({ workspaceRoot, approval });
  const hooks = createDefaultHooks({
    checker: pipeline,
    workspaceRoot,
    log: (message) => { logs.push(message); },
    logger: (message) => { logs.push(message); },
  });
  return { hooks, logs, asked };
}

/** Content of the first tool_result block of one conversation turn. */
function toolResultContent(messages: Conversation, turnIndex: number): string {
  const content = messages[turnIndex]?.content;
  if (!Array.isArray(content)) throw new Error(`messages[${turnIndex}] must be a block array`);
  const block = content.find((candidate) => candidate.type === "tool_result");
  if (block === undefined || block.type !== "tool_result") {
    throw new Error("expected a tool_result block");
  }
  const result: unknown = block.content;
  if (typeof result !== "string") throw new Error("expected a string tool_result content");
  return result;
}

async function runCliProcess(cwd: string, input: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [entry], {
    cwd, env: { PATH: process.env.PATH, ...env }, timeout: 15_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, stdout, stderr };
}

test("permission path 1: an interactive denial reports Permission denied. and leaves every file in place", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "cw-perm-cli-reject-"));
  try {
    const tempPath = join(workspaceRoot, "temp.txt");
    await writeFile(tempPath, "keep me");
    const { hooks, logs, asked } = scriptedSession(workspaceRoot, "n");
    const { client } = fakeClient([
      { content: [bashCall("call_1", "rm temp.txt")], stop_reason: "tool_use" },
      { content: [text("done")], stop_reason: "end_turn" },
    ]);
    const messages: Conversation = [{ role: "user", content: "remove temp.txt" }];
    const registry = await createDefaultRegistry({ root: workspaceRoot });
    await agentLoop(messages, {
      client, model: "test-model", registry, hooks, workspaceRoot,
      log: (message) => { logs.push(message); },
    });

    assert.equal(toolResultContent(messages, 2), "Permission denied.");
    // The user was actually asked, with the s03 banner and question.
    assert.equal(asked.length, 1);
    assert.equal(asked[0], APPROVAL_QUESTION);
    assert.match(asked[0] ?? "", /Allow\? \[y\/N\]/);
    assert.ok(
      logs.some((line) => line.includes("[permission] Potentially destructive command")),
      `expected the approval banner, got ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((line) => line.includes("[blocked] Permission denied by user")),
      `expected the denial to be reported, got ${JSON.stringify(logs)}`,
    );
    // A denied call must never touch the workspace.
    assert.ok((await stat(tempPath)).isFile());
    assert.deepEqual(await readdir(workspaceRoot), ["temp.txt"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("permission path 2: an interactive approval really executes the destructive command", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "cw-perm-cli-approve-"));
  try {
    const victimPath = join(workspaceRoot, "victim.txt");
    await writeFile(victimPath, "delete me");
    const { hooks, logs, asked } = scriptedSession(workspaceRoot, "y");
    const { client } = fakeClient([
      { content: [bashCall("call_1", "rm victim.txt")], stop_reason: "tool_use" },
      { content: [text("done")], stop_reason: "end_turn" },
    ]);
    const messages: Conversation = [{ role: "user", content: "remove victim.txt" }];
    const registry = await createDefaultRegistry({ root: workspaceRoot });
    await agentLoop(messages, {
      client, model: "test-model", registry, hooks, workspaceRoot,
      log: (message) => { logs.push(message); },
    });

    const result = toolResultContent(messages, 2);
    assert.notEqual(result, "Permission denied.");
    assert.ok(!result.startsWith("Error:"), `the bash tool must run, got ${JSON.stringify(result)}`);
    assert.equal(result, "(no output)", "rm prints nothing on success");
    // The user saw the banner and the question before answering "y".
    assert.equal(asked.length, 1);
    assert.equal(asked[0], APPROVAL_QUESTION);
    assert.ok(
      logs.some((line) => line.includes("[permission] Potentially destructive command")),
      `expected the approval banner, got ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((line) => line.includes("$ rm victim.txt")),
      `expected the approved command to be echoed, got ${JSON.stringify(logs)}`,
    );
    // Approval is not cosmetic: the file is gone and nothing else appeared.
    await assert.rejects(stat(victimPath), /ENOENT/);
    assert.deepEqual(await readdir(workspaceRoot), []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("permission path 3: the real CLI without a TTY auto-denies instead of waiting for input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cw-perm-cli-notty-"));
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
    const first = bodies.length === 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `msg_${bodies.length}`, type: "message", role: "assistant", model: "local-test",
      content: first ? [bashCall("call_1", "rm victim2.txt")] : [text("nothing was deleted")],
      stop_reason: first ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  try {
    const victimPath = join(cwd, "victim2.txt");
    await writeFile(victimPath, "delete me");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected the mock server to listen on a TCP port");
    }

    const result = await runCliProcess(cwd, "delete victim2.txt\nq\n", {
      MODEL_ID: "local-test",
      ANTHROPIC_API_KEY: "local-fake-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    });

    // `code` would be null if the 15s spawn timeout had to kill a hung CLI.
    assert.equal(result.code, 0, `the CLI must exit on EOF, stderr: ${result.stderr}`);
    assert.equal(result.stderr, "");
    // The existing interactive UX is untouched.
    assert.match(result.stdout, /CodeWeaver >> /);
    assert.match(result.stdout, /输入问题后按回车发送，输入 q 退出。/);
    // Without a TTY the approval gate denies immediately: no prompt, no read.
    assert.ok(!result.stdout.includes("Allow? [y/N]"), result.stdout);
    assert.match(result.stdout, /\[blocked\] no interactive terminal/);

    assert.equal(bodies.length, 2, "one blocked tool turn, then the closing answer");
    const messages: unknown = (bodies[1] as { readonly messages?: unknown }).messages;
    if (!Array.isArray(messages)) throw new Error("expected the follow-up request to carry messages");
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[2], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "Permission denied." }],
    });
    // The pre-existing file survives the rejected command.
    assert.ok((await stat(victimPath)).isFile());
    assert.deepEqual(await readdir(cwd), ["victim2.txt"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ConsoleApprovalPrompt prefers an injected question provider over stdin", async () => {
  const asked: string[] = [];
  const approving = new ConsoleApprovalPrompt({ isInteractive: true, log: () => {} });
  approving.setQuestionProvider(async (promptText) => {
    asked.push(promptText);
    return "y";
  });

  assert.deepEqual(
    await approving.request({
      toolName: "bash", input: { command: "rm x" }, reason: "Potentially destructive command",
    }),
    { decision: "allow" },
  );
  // The provider answered, so the fallback readline on process.stdin never ran:
  // an actual stdin read inside a piped test process could not yield an approval.
  assert.deepEqual(asked, [APPROVAL_QUESTION]);

  let calls = 0;
  const denying = new ConsoleApprovalPrompt({
    isInteractive: true,
    log: () => {},
    // A constructor-injected question must not win over the shared provider.
    question: async () => "y",
  });
  denying.setQuestionProvider(async () => {
    calls += 1;
    return "n";
  });
  assert.deepEqual(await denying.request({ toolName: "bash", input: {}, reason: "why" }), {
    decision: "deny",
  });
  assert.equal(calls, 1, "the shared provider is consulted exactly once");
});
