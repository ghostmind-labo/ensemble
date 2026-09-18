/**
 * Skills — instructions that live on disk, not in the graph.
 *
 * A skill is a folder with a `SKILL.md`: frontmatter naming it and describing
 * when it applies, then a body of instructions. That is the Claude Code
 * convention, and this reads it unchanged so a project's existing skills work
 * with no porting.
 *
 * Why they belong here at all, given this library runs no agent loop: choosing
 * a skill IS a classification, and a bad one is expensive. TypeSafe measured
 * the case — picking at most one skill out of 182 — and found an agent working
 * from truncated index entries loaded the wrong skill 16.8% of the time, against
 * 7.3% when a System One model ranked them first. So skills arrive as two
 * ordinary pieces rather than a new mechanism:
 *
 *   `skillOptions()` turns a registry into `choice` criteria — a decide node
 *   picks one, and because skills are LOCAL FILES the options can be enumerated
 *   offline, so the graph stays complete and `validate` stays free. This is the
 *   difference from a model catalogue, which needs the network and therefore
 *   must never be enumerated in a choice.
 *
 *   `skills:` on a model node inlines the chosen body into its prompt. No loop,
 *   no tool calls — the skill is instructions, and instructions are text.
 *
 * Precedence is project, then global, then plugin: the nearest definition of a
 * name wins, so a project can override a skill it inherited.
 *
 * The format is the Agent Skills open standard (agentskills.io) — opened by
 * Anthropic in December 2025 and since adopted across ~40 agent products. That
 * is why this reads Claude Code's directories and Codex's and Gemini CLI's
 * without caring which wrote them: they are all the same two required fields.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type SkillScope = "project" | "global" | "plugin";

export interface Skill {
  /** 1–64 chars, lowercase alphanumeric and single hyphens, matching the folder. */
  name: string;
  /** When to use it, max 1024 chars. What a `choice` shows, and often all a decider sees. */
  description: string;
  /** The instructions themselves, frontmatter stripped. */
  body: string;
  /** Optional spec fields, kept because a graph may want to report on them. */
  license?: string;
  /** Environment requirements the skill declares — packages, network, a product. */
  compatibility?: string;
  metadata?: Record<string, string>;
  /** Space-separated pre-approved tools. Experimental in the spec. */
  allowedTools?: string;
  scope: SkillScope;
  /** The SKILL.md this came from. */
  path: string;
}

/** Spec limits, enforced by `validateSkill`. */
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;
const NAME_RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillSources {
  /** Project root. Defaults to the working directory. */
  project?: string;
  /** Home directory. Defaults to the real one. */
  home?: string;
  /** Extra roots to scan, each holding `<name>/SKILL.md`. Highest precedence. */
  dirs?: string[];
  /** Also scan installed Claude Code plugins. Default true. */
  plugins?: boolean;
}

/** `---\nname: x\ndescription: y\n---\nbody` — a hand parser, to stay dependency-free. */
export function parseSkill(text: string, path: string, scope: SkillScope): Skill | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ""));
  if (!match) return undefined;
  const [, front = "", body = ""] = match;

  const fields: Record<string, string> = {};
  let key: string | undefined;
  for (const line of front.split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair) {
      key = pair[1]!.toLowerCase();
      fields[key] = pair[2]!.trim();
    } else if (key && /^\s+\S/.test(line)) {
      // a folded continuation, which long descriptions use
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  const unquote = (value = ""): string =>
    /^(['"])[\s\S]*\1$/.test(value) ? value.slice(1, -1) : value;

  const name = unquote(fields["name"]) || basename(dirname(path));
  if (!name) return undefined;

  // `metadata:` is a nested map in the spec; the flat parser above sees its
  // children as their own keys, so collect the indented block separately.
  const metadata: Record<string, string> = {};
  const nested = /^metadata:\s*$([\s\S]*?)(?=^\S|\Z)/m.exec(front);
  for (const line of (nested?.[1] ?? "").split(/\r?\n/)) {
    const pair = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.+)$/.exec(line);
    if (pair) metadata[pair[1]!] = unquote(pair[2]!.trim());
  }

  return {
    name,
    description: unquote(fields["description"] ?? ""),
    body: body.trim(),
    ...(fields["license"] ? { license: unquote(fields["license"]) } : {}),
    ...(fields["compatibility"] ? { compatibility: unquote(fields["compatibility"]) } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...(fields["allowed-tools"] ? { allowedTools: unquote(fields["allowed-tools"]) } : {}),
    scope,
    path,
  };
}

/**
 * Check a skill against the published spec.
 *
 * Returns problems as strings, the same shape `validate` uses. Worth running
 * over a skill you wrote, because a name a client rejects is a skill that
 * silently never loads.
 */
export function validateSkill(skill: Skill): string[] {
  const problems: string[] = [];
  if (!skill.name) problems.push("a skill needs a name");
  else if (skill.name.length > NAME_MAX) problems.push(`name is ${skill.name.length} chars; the spec allows ${NAME_MAX}`);
  else if (!NAME_RULE.test(skill.name)) {
    problems.push(
      `name "${skill.name}" is not valid — lowercase letters, digits and single hyphens only, ` +
        `and it may not start or end with one`,
    );
  }
  const folder = basename(dirname(skill.path));
  if (folder && skill.name && folder !== skill.name) {
    problems.push(`name "${skill.name}" does not match its folder "${folder}" — the spec requires they agree`);
  }
  if (!skill.description) problems.push(`skill "${skill.name}" has no description — it is what a decider reads`);
  else if (skill.description.length > DESCRIPTION_MAX) {
    problems.push(`description is ${skill.description.length} chars; the spec allows ${DESCRIPTION_MAX}`);
  }
  if (skill.compatibility && skill.compatibility.length > COMPATIBILITY_MAX) {
    problems.push(`compatibility is ${skill.compatibility.length} chars; the spec allows ${COMPATIBILITY_MAX}`);
  }
  return problems;
}

function scan(root: string, scope: SkillScope): Skill[] {
  if (!existsSync(root)) return [];
  const found: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const file = join(root, entry, "SKILL.md");
    try {
      if (!statSync(file).isFile()) continue;
      const skill = parseSkill(readFileSync(file, "utf8"), file, scope);
      if (skill) found.push(skill);
    } catch {
      // unreadable or not a skill folder — skip it rather than fail a run
    }
  }
  return found;
}

/** `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md` */
function scanPlugins(home: string): Skill[] {
  const cache = join(home, ".claude", "plugins", "cache");
  if (!existsSync(cache)) return [];
  const found: Skill[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      if (entry === "skills") found.push(...scan(child, "plugin"));
      else walk(child, depth + 1);
    }
  };
  walk(cache, 0);
  return found;
}

/**
 * Every skill visible from here, nearest definition winning.
 *
 * Synchronous and local on purpose: it has to be safe to call at module scope,
 * so a runner can hand the result to `skillOptions()` and still be validated
 * and serialised offline.
 */
export function loadSkills(sources: SkillSources = {}): Skill[] {
  const project = resolve(sources.project ?? process.cwd());
  const home = sources.home ?? homedir();

  const roots: Array<[string, SkillScope]> = [
    ...(sources.dirs ?? []).map((dir): [string, SkillScope] => [resolve(dir), "project"]),
    [join(project, ".ensemble", "skills"), "project"],
    [join(project, ".claude", "skills"), "project"],
    [join(home, ".ensemble", "skills"), "global"],
    [join(home, ".claude", "skills"), "global"],
  ];

  const byName = new Map<string, Skill>();
  for (const [root, scope] of roots) {
    for (const skill of scan(root, scope)) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  if (sources.plugins !== false) {
    for (const skill of scanPlugins(home)) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const findSkill = (skills: readonly Skill[], name: string): Skill | undefined =>
  skills.find((skill) => skill.name === name);

export interface SkillOptionsConfig {
  /** Keep at most this many. Choice accepts 255; the default leaves headroom. */
  max?: number;
  /** Trim each description to this many characters. Every option costs input tokens. */
  chars?: number;
  /** Add an escape hatch option, so the decider can decline. Strongly recommended. */
  none?: string | false;
}

/**
 * A registry, as `choice` criteria.
 *
 * Two details carry most of the measured benefit. Descriptions are trimmed,
 * because every option is input tokens and a skill's own description is often a
 * paragraph. And a `none` option is added by default: suggesting nothing beats
 * suggesting wrong, and a choice with no way out has to pick something.
 */
export function skillOptions(
  skills: readonly Skill[],
  config: SkillOptionsConfig = {},
): Record<string, { what: string }> {
  const max = Math.min(config.max ?? 200, 254);
  const chars = config.chars ?? 180;
  const trim = (text: string): string =>
    text.length <= chars ? text : `${text.slice(0, chars - 1).trimEnd()}…`;

  const options: Record<string, { what: string }> = {};
  for (const skill of skills.slice(0, max)) {
    options[skill.name] = { what: trim(skill.description) || `The "${skill.name}" skill.` };
  }
  if (config.none !== false) {
    options["none"] = {
      what: config.none ?? "No skill here fits the request; answer without one.",
    };
  }
  return options;
}

/** Skill bodies, ready to prepend to a prompt. */
export function renderSkills(skills: readonly Skill[]): string {
  return skills
    .map((skill) => `<skill name="${skill.name}">\n${skill.body}\n</skill>`)
    .join("\n\n");
}
