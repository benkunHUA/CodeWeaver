import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NO_SKILLS_CATALOG,
  parseFrontmatter,
  SkillLoader,
} from "../src/skills/index.js";
import { subagentPrompt, systemPrompt } from "../src/agent/systemPrompt.js";
import { loadRuntimeConfig } from "../src/config.js";
import { TodoStore } from "../src/planning/index.js";
import type { SubagentLauncher } from "../src/subagent/types.js";
import { FileLockRegistry } from "../src/tools/core/FileLockRegistry.js";
import { ToolContext } from "../src/tools/core/ToolContext.js";
import { TaskTool } from "../src/tools/TaskTool.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { createDefaultTools } from "../src/tools/createDefaultTools.js";
import { createWorkspace } from "../src/workspace.js";

const WITH_FRONTMATTER = [
  "---",
  "name: agent-builder",
  "description: Build AI agents for any domain.",
  "---",
  "",
  "# Agent Builder",
  "",
  "Body text.",
  "",
].join("\n");

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "codeweaver-skills-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSkill(root: string, subdir: string, text: string): Promise<void> {
  await mkdir(join(root, subdir), { recursive: true });
  await writeFile(join(root, subdir, "SKILL.md"), text, "utf8");
}

test("parseFrontmatter returns empty metadata and the raw text when absent", () => {
  const text = "Just content\nwith a second line\n";
  assert.deepEqual(parseFrontmatter(text), { metadata: {}, body: text });
});

test("parseFrontmatter returns empty metadata when the closing --- is missing", () => {
  const text = "---\nname: lonely\n";
  assert.deepEqual(parseFrontmatter(text), { metadata: {}, body: text });
});

test("parseFrontmatter reads name and description from the frontmatter", () => {
  const { metadata, body } = parseFrontmatter(WITH_FRONTMATTER);
  assert.equal(metadata["name"], "agent-builder");
  assert.equal(metadata["description"], "Build AI agents for any domain.");
  assert.equal(body, "# Agent Builder\n\nBody text.");
});

test("parseFrontmatter parses a block scalar description across multiple lines", () => {
  const text = [
    "---",
    "name: blocked",
    "description: |",
    "  line one",
    "  line two",
    "---",
    "",
    "Body.",
  ].join("\n");
  const { metadata, body } = parseFrontmatter(text);
  assert.equal(metadata["description"], "line one\nline two\n");
  assert.equal(body, "Body.");
});

test("parseFrontmatter preserves quoted values verbatim", () => {
  const text = [
    "---",
    'name: "quoted-name"',
    "description: 'single quoted'",
    "---",
  ].join("\n");
  const { metadata, body } = parseFrontmatter(text);
  assert.equal(metadata["name"], "quoted-name");
  assert.equal(metadata["description"], "single quoted");
  assert.equal(body, "");
});

test("parseFrontmatter falls back to empty metadata for invalid YAML", () => {
  const text = "---\nname: [unclosed\n---\n";
  assert.deepEqual(parseFrontmatter(text), { metadata: {}, body: "" });
});

test("parseFrontmatter falls back to empty metadata for a non-mapping document", () => {
  const text = "---\n- a\n- b\n---\nbody";
  assert.deepEqual(parseFrontmatter(text), { metadata: {}, body: "body" });
});

test("parseFrontmatter trims whitespace around the body", () => {
  const text = "---\nname: trimmed\n---\n\n\nbody line\n\n";
  const { body } = parseFrontmatter(text);
  assert.equal(body, "body line");
});

test("scan only accepts */SKILL.md and ignores a top-level SKILL.md", async () => {
  await withTempDir(async (root) => {
    await writeSkill(root, "alpha", "---\nname: alpha\ndescription: Alpha.\n---\n");
    await writeFile(join(root, "SKILL.md"), "---\nname: top\ndescription: Top.\n---\n");
    const loader = await SkillLoader.scan({ dir: root });
    assert.equal(loader.size, 1);
    assert.deepEqual(loader.list().map((skill) => skill.name), ["alpha"]);
  });
});

test("scan orders skills by ascending subdirectory name", async () => {
  await withTempDir(async (root) => {
    await writeSkill(root, "charlie", "---\nname: charlie\ndescription: C.\n---\n");
    await writeSkill(root, "alpha", "---\nname: alpha\ndescription: A.\n---\n");
    await writeSkill(root, "bravo", "---\nname: bravo\ndescription: B.\n---\n");
    const loader = await SkillLoader.scan({ dir: root });
    assert.deepEqual(loader.list().map((skill) => skill.name), ["alpha", "bravo", "charlie"]);
  });
});

test("scan falls back to the directory name when frontmatter name is missing or blank", async () => {
  await withTempDir(async (root) => {
    await writeSkill(root, "no-name", "---\ndescription: Has description.\n---\n");
    await writeSkill(root, "blank-name", "---\nname: '   '\ndescription: Blank name.\n---\n");
    const loader = await SkillLoader.scan({ dir: root });
    assert.deepEqual(loader.list().map((skill) => skill.name), ["blank-name", "no-name"]);
  });
});

test("scan derives the description from the first body line, stripping hashes and collapsing whitespace", async () => {
  await withTempDir(async (root) => {
    const content = "---\nname: derived\n---\n#   Derived    title\nsecond line\n";
    await writeSkill(root, "derived", content);
    const loader = await SkillLoader.scan({ dir: root });
    assert.equal(loader.list()[0]?.description, "Derived title");
  });
});

test("scan collapses a block scalar description into a single line", async () => {
  await withTempDir(async (root) => {
    const content = [
      "---",
      "name: blocky",
      "description: |",
      "  first line",
      "  second line",
      "---",
      "",
      "Body.",
    ].join("\n");
    await writeSkill(root, "blocky", content);
    const loader = await SkillLoader.scan({ dir: root });
    assert.equal(loader.list()[0]?.description, "first line second line");
  });
});

test("scan skips a SKILL.md symlink that escapes the skills directory", async () => {
  await withTempDir(async (root) => {
    const skillsDir = join(root, "skills");
    await mkdir(join(skillsDir, "leak"), { recursive: true });
    const outside = join(root, "outside.md");
    await writeFile(outside, "---\nname: leak\ndescription: Outside.\n---\n", "utf8");
    await symlink(outside, join(skillsDir, "leak", "SKILL.md"));
    const loader = await SkillLoader.scan({ dir: skillsDir });
    assert.equal(loader.size, 0);
    assert.equal(loader.catalog(), NO_SKILLS_CATALOG);
  });
});

test("scan accepts a SKILL.md symlink that points inside the skills directory", async () => {
  await withTempDir(async (root) => {
    const skillsDir = join(root, "skills");
    await writeSkill(skillsDir, "real", "---\ndescription: Real.\n---\nBody.\n");
    await mkdir(join(skillsDir, "link"), { recursive: true });
    await symlink(join(skillsDir, "real", "SKILL.md"), join(skillsDir, "link", "SKILL.md"));
    const loader = await SkillLoader.scan({ dir: skillsDir });
    assert.equal(loader.size, 2);
    assert.equal(loader.load("link"), loader.load("real"));
  });
});

test("scan lets a later duplicate name override an earlier one", async () => {
  await withTempDir(async (root) => {
    await writeSkill(root, "first", "---\nname: dup\ndescription: First.\n---\nFirst body.\n");
    await writeSkill(root, "second", "---\nname: dup\ndescription: Second.\n---\nSecond body.\n");
    const loader = await SkillLoader.scan({ dir: root });
    assert.equal(loader.size, 1);
    assert.equal(loader.load("dup"), "---\nname: dup\ndescription: Second.\n---\nSecond body.\n");
  });
});

test("scan returns an empty loader when the directory does not exist", async () => {
  const loader = await SkillLoader.scan({ dir: join(tmpdir(), "codeweaver-missing-skills") });
  assert.equal(loader.size, 0);
  assert.deepEqual(loader.list(), []);
  assert.equal(loader.catalog(), NO_SKILLS_CATALOG);
});

test("catalog renders one name and description line per skill", async () => {
  await withTempDir(async (root) => {
    await writeSkill(root, "alpha", "---\nname: alpha\ndescription: First skill summary\n---\nBody A\n");
    await writeSkill(root, "beta", "---\nname: beta\n---\n# Beta title\nmore text\n");
    await writeSkill(root, "gamma", "---\ndescription: |\n  Gamma\n  description\n---\nBody C\n");
    const loader = await SkillLoader.scan({ dir: root });
    assert.equal(
      loader.catalog(),
      ["- alpha: First skill summary", "- beta: Beta title", "- gamma: Gamma description"].join("\n"),
    );
  });
});

test("load returns the full raw document including frontmatter", async () => {
  await withTempDir(async (root) => {
    await writeSkill(root, "agent", WITH_FRONTMATTER);
    const loader = await SkillLoader.scan({ dir: root });
    assert.equal(loader.load("agent-builder"), WITH_FRONTMATTER);
  });
});

test("load reports the available names for an unknown skill", async () => {
  await withTempDir(async (root) => {
    await writeSkill(root, "a", "---\nname: a\ndescription: A.\n---\n");
    await writeSkill(root, "b", "---\nname: b\ndescription: B.\n---\n");
    const loader = await SkillLoader.scan({ dir: root });
    assert.equal(loader.load("nope"), "Error: Unknown skill 'nope'. Available: a, b");
  });
});

test("load reports none when the library is empty", async () => {
  const loader = await SkillLoader.scan({ dir: join(tmpdir(), "codeweaver-missing-skills") });
  assert.equal(loader.load("nope"), "Error: Unknown skill 'nope'. Available: none");
});

const DEMO_SKILL = [
  "---",
  "name: demo",
  "description: Demo skill summary.",
  "---",
  "",
  "# Demo",
  "",
  "Body text.",
  "",
].join("\n");

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("assembly mirrors config: parent gets task while both loops share one skill library", async () => {
  await withTempDir(async (root) => {
    await writeSkill(join(root, "skills"), "demo", DEMO_SKILL);
    const workspace = await createWorkspace(root);
    const skills = await SkillLoader.scan({ dir: join(workspace.root, "skills") });
    const locks = new FileLockRegistry();
    const logger = (): void => {};
    const launcher: SubagentLauncher = { run: async (prompt) => `delegated: ${prompt}` };

    // Mirrors loadRuntimeConfig(): the parent and the child share `locks` and
    // `skills` but own their TODO state.
    const childContext = new ToolContext({ workspace, locks, todos: new TodoStore(), skills, logger });
    const childRegistry = new ToolRegistry({ context: childContext, logger });
    for (const tool of createDefaultTools()) childRegistry.register(tool);

    const parentContext = new ToolContext({
      workspace,
      locks,
      todos: new TodoStore(),
      subagents: launcher,
      skills,
      logger,
    });
    const parentRegistry = new ToolRegistry({ context: parentContext, logger });
    for (const tool of createDefaultTools()) parentRegistry.register(tool);
    parentRegistry.register(new TaskTool());

    const parentNames = parentRegistry.list().map((tool) => tool.name);
    const childNames = childRegistry.list().map((tool) => tool.name);
    assert.equal(parentNames.length, 8);
    assert.equal(childNames.length, 7);
    assert.ok(parentNames.includes("task"));
    assert.ok(!childNames.includes("task"));

    assert.equal(parentContext.skills, childContext.skills);
    assert.equal(parentContext.skills, skills);
    assert.equal(parentContext.locks, childContext.locks);
    assert.notEqual(parentContext.todos, childContext.todos);

    // The subagent can load skills through its own registry.
    assert.equal(await childRegistry.invoke("load_skill", { name: "demo" }), DEMO_SKILL);

    const catalog = skills.catalog();
    assert.ok(systemPrompt(root, catalog).includes("- demo: Demo skill summary."));
    assert.ok(subagentPrompt(root, catalog).includes("- demo: Demo skill summary."));
  });
});

test("loadRuntimeConfig scans the workspace skills directory into the registry", async () => {
  const previous = {
    model: process.env.MODEL_ID,
    key: process.env.ANTHROPIC_API_KEY,
    root: process.env.CODEWEAVER_ROOT,
  };
  const root = await mkdtemp(join(tmpdir(), "codeweaver-runtime-"));
  try {
    await writeSkill(join(root, "skills"), "demo", DEMO_SKILL);
    // Fake credentials are enough: loadConfig() only checks that they exist.
    // A repository-root `.env` is loaded with `override: true`, so it may
    // replace these values; either way MODEL_ID is set, and a genuine missing
    // MODEL_ID would make this call throw and fail the test loudly.
    process.env.MODEL_ID = "test-model";
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.CODEWEAVER_ROOT = root;

    const runtime = await loadRuntimeConfig();

    assert.equal(runtime.skills.size, 1);
    assert.equal(runtime.skills.catalog(), "- demo: Demo skill summary.");

    const names = runtime.registry.list().map((tool) => tool.name);
    assert.equal(names.length, 8);
    assert.ok(names.includes("task"));
    assert.ok(names.includes("load_skill"));
  } finally {
    restoreEnv("MODEL_ID", previous.model);
    restoreEnv("ANTHROPIC_API_KEY", previous.key);
    restoreEnv("CODEWEAVER_ROOT", previous.root);
    await rm(root, { recursive: true, force: true });
  }
});
