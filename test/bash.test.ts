import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { COMMAND_TIMEOUT_MS, OUTPUT_LIMIT, runBash, sliceCharacters } from "../src/bash.js";

export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function nodeCommand(source: string): string {
  return `${quote(process.execPath)} -e ${quote(source)}`;
}

test("captures stdout before stderr and ignores nonzero exit status", async () => {
  assert.equal(await runBash("printf ' err ' >&2; printf ' out '; exit 7"), "out  err");
  assert.equal(await runBash("exit 9"), "(no output)");
  assert.equal(await runBash("printf '  \\n\\t'"), "(no output)");
});

test("shell syntax, cwd, filesystem effects and per-command cwd isolation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-ts-bash-"));
  try {
    assert.equal(await runBash("printf hello | tr a-z A-Z > result.txt; cat result.txt", { cwd }), "HELLO");
    assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "HELLO");
    await runBash("mkdir child; cd child", { cwd });
    assert.equal(await runBash("cat result.txt", { cwd }), "HELLO");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("UTF-8, invalid bytes and universal newlines match Python text output", async () => {
  assert.equal(
    await runBash(nodeCommand("process.stdout.write(Buffer.from([0xe4,0xb8,0xad,0xff,13,10,65,13,66]))")),
    "\u4e2d\ufffd\nA\nB",
  );
  assert.equal(await runBash(nodeCommand("process.stdout.write('\\u0085hello\\u001c')")), "hello");
});

test("caps large output at 50000 Unicode characters, without exec's default buffer cap", async () => {
  assert.equal(
    await runBash(nodeCommand("process.stdout.write('\\u{1f680}'.repeat(300000))")),
    "\u{1f680}".repeat(OUTPUT_LIMIT),
  );
  assert.equal(sliceCharacters("a\u{1f680}b", 2), "a\u{1f680}");
});

test("preserves the exact dangerous substring blacklist", async () => {
  for (const command of ["rm -rf /", "sudo true", "shutdown", "reboot", "> /dev/null", "echo sudo"]) {
    assert.equal(await runBash(command), "Error: Dangerous command blocked");
  }
});

test("timeout kills a stalled command and reports the configured duration", async () => {
  assert.equal(COMMAND_TIMEOUT_MS, 120_000);
  assert.equal(
    await runBash(`exec ${nodeCommand("setInterval(() => {}, 1000)")}`, { timeoutMs: 100 }),
    "Error: Timeout (0.1s)",
  );
});

test("missing cwd returns an OS error; missing commands return shell stderr", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-ts-missing-"));
  await rm(cwd, { recursive: true });
  assert.match(await runBash("true", { cwd }), /^Error: /);
  assert.match(await runBash("__s01_nonexistent_command__"), /not found/);
});
