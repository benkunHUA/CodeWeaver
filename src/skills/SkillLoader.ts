import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import type { Skill, SkillLibrary } from "./types.js";

export const NO_SKILLS_CATALOG = "(no skills found)";

export interface SkillLoaderOptions {
  readonly dir: string;
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** True when `manifest` resolves to a real file inside `root` (its realpath). */
async function isFileInside(manifest: string, root: string): Promise<boolean> {
  let stats;
  try {
    stats = await stat(manifest);
  } catch {
    return false;
  }
  if (!stats.isFile()) {
    return false;
  }
  const resolved = await realpath(manifest);
  const rel = relative(root, resolved);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function resolveName(metadata: Readonly<Record<string, unknown>>, fallback: string): string {
  const raw = metadata["name"];
  const name = typeof raw === "string" ? raw.trim() : "";
  return name || fallback;
}

/** Mirrors Python's `" ".join(str(description).lstrip("# ").split())`. */
function normalizeDescription(value: string): string {
  return value
    .replace(/^[# ]+/u, "")
    .split(/\s+/u)
    .filter((part) => part !== "")
    .join(" ");
}

function resolveDescription(metadata: Readonly<Record<string, unknown>>, body: string): string {
  const raw = metadata["description"];
  const description = typeof raw === "string" ? raw.trim() : "";
  const firstLine = body.split("\n", 1)[0] ?? "";
  return normalizeDescription(description || firstLine);
}

async function scanSkills(dir: string): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  const root = await realpath(dir);
  const names = entries.map((entry) => entry.name).sort(compareNames);
  for (const entryName of names) {
    const manifest = join(dir, entryName, "SKILL.md");
    if (!(await isFileInside(manifest, root))) {
      continue;
    }
    const content = await readFile(manifest, "utf8");
    const { metadata, body } = parseFrontmatter(content);
    const name = resolveName(metadata, entryName);
    const description = resolveDescription(metadata, body);
    // A later directory with the same name replaces the earlier entry while
    // keeping its original position, matching Python's dict assignment.
    skills.set(name, { name, description, content });
  }
  return skills;
}

/**
 * Scans `skills/<subdir>/SKILL.md` once and serves the catalog plus full documents.
 * Entries are read in ascending subdirectory order and, when two directories
 * resolve to the same skill name, the later scan wins.
 */
export class SkillLoader implements SkillLibrary {
  readonly #skills: ReadonlyMap<string, Skill>;

  private constructor(skills: ReadonlyMap<string, Skill>) {
    this.#skills = skills;
  }

  /** Scans the skills directory once and returns a ready loader. */
  static async scan(options: SkillLoaderOptions): Promise<SkillLoader> {
    return new SkillLoader(await scanSkills(options.dir));
  }

  catalog(): string {
    if (this.#skills.size === 0) {
      return NO_SKILLS_CATALOG;
    }
    return [...this.#skills.values()]
      .map((skill) => `- ${skill.name}: ${skill.description}`)
      .join("\n");
  }

  load(name: string): string {
    const skill = this.#skills.get(name);
    if (skill) {
      return skill.content;
    }
    const available = [...this.#skills.keys()].join(", ") || "none";
    return `Error: Unknown skill '${name}'. Available: ${available}`;
  }

  list(): readonly Skill[] {
    return [...this.#skills.values()];
  }

  get size(): number {
    return this.#skills.size;
  }
}
