import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function runProcess(cwd: string, input: string, env: NodeJS.ProcessEnv) {
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

test("TR-3.2: compiled CLI uses real SDK, local dotenv override, bash+read+write tools and multi-turn state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-ts-cli-"));
  const requests: Array<{ body: Record<string, unknown>; key: unknown; auth: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({
      body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
      key: req.headers["x-api-key"],
      auth: req.headers.authorization,
    });
    const first = [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "seed.txt" } }];
    const second = [{ type: "tool_use", id: "call_2", name: "write_file", input: { path: "out.txt", content: "pong" } }];
    const third = [{ type: "tool_use", id: "call_3", name: "bash", input: { command: "printf cli-tool-ok" } }];
    const content = requests.length === 1 ? first : requests.length === 2 ? second : requests.length === 3 ? third : [{ type: "text", text: requests.length === 4 ? "first answer" : "second answer" }];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `msg_${requests.length}`, type: "message", role: "assistant",
      model: "local-test", content,
      stop_reason: requests.length <= 3 ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  try {
    await writeFile(join(cwd, "seed.txt"), "seeded");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(join(cwd, ".env"), "MODEL_ID=from-dotenv\nANTHROPIC_API_KEY=local-fake-key\n");
    const result = await runProcess(cwd, "first question\nsecond question\nq\n", {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_API_KEY: "must-be-overridden",
      ANTHROPIC_AUTH_TOKEN: "must-be-removed",
      MODEL_ID: "must-be-overridden",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /\x1b\[35m> read_file\x1b\[0m/);
    assert.match(result.stdout, /\x1b\[35m> write_file\x1b\[0m/);
    assert.match(result.stdout, /\x1b\[35m> bash\x1b\[0m/);
    assert.match(result.stdout, /\x1b\[33m\$ printf cli-tool-ok\x1b\[0m/);
    assert.match(result.stdout, /cli-tool-ok/);
    assert.match(result.stdout, /first answer/);
    assert.match(result.stdout, /second answer/);
    assert.match(result.stdout, /输入问题后按回车发送，输入 q 退出。/);
    assert.match(result.stdout, /CodeWeaver >> /);
    assert.ok(!result.stdout.includes("\x01") && !result.stdout.includes("\x02"));
    assert.equal(requests.length, 5);
    for (const request of requests) {
      assert.equal(request.body.model, "from-dotenv");
      assert.equal(request.body.max_tokens, 8000);
      assert.equal(request.key, "local-fake-key");
      assert.equal(request.auth, undefined);
      assert.equal(Array.isArray(request.body.tools) ? request.body.tools.length : 0, 7);
    }
    assert.equal((requests[0]?.body.messages as unknown[]).length, 1);
    const thirdHistory = requests[2]?.body.messages as unknown[];
    const fifthHistory = requests[4]?.body.messages as unknown[];
    assert.deepEqual(thirdHistory[4], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_2", content: "Wrote 4 bytes to out.txt" }],
    });
    assert.equal(fifthHistory.length, 9);
    assert.deepEqual(fifthHistory[8], { role: "user", content: "second question" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
});

test("quit aliases, blank lines and EOF exit without model requests", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-ts-exit-"));
  try {
    for (const input of [" q \n", "EXIT\n", "\n", ""]) {
      const result = await runProcess(cwd, input, {
        ANTHROPIC_API_KEY: "fake-key", MODEL_ID: "test-model",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /输入问题后按回车发送，输入 q 退出。/);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("missing model or credentials fails early with a useful error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-ts-config-"));
  try {
    const noModel = await runProcess(cwd, "", {});
    assert.equal(noModel.code, 1);
    assert.match(noModel.stderr, /MODEL_ID is required/);
    const noKey = await runProcess(cwd, "", { MODEL_ID: "test-model" });
    assert.equal(noKey.code, 1);
    assert.match(noKey.stderr, /ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
