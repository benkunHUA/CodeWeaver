/** One scanned skill: the catalog entry plus the full document. */
export interface Skill {
  readonly name: string;
  readonly description: string;
  /** Raw SKILL.md text, YAML frontmatter included. */
  readonly content: string;
}

/** Narrow port used by the load_skill tool and by prompt assembly. */
export interface SkillLibrary {
  /** Catalog text for the system prompt: one `- name: description` line per skill. */
  catalog(): string;
  /** Full SKILL.md content, or an `Error: Unknown skill ...` string. */
  load(name: string): string;
}

/** Input of the load_skill tool. */
export interface LoadSkillInput {
  readonly name: string;
}
