/**
 * The central catalog.
 *
 * Skills and MCP servers are NOT owned by this project — opencode already stores
 * them globally. We only discover what is there so scenes can reference entries by
 * name and `graph validate` can reject typos before a run burns tokens.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

export interface Skill {
  name: string;
  description: string;
  path: string;
  /** Which of the six search roots this came from, for `graph skills` output. */
  source: string;
}

export interface McpServer {
  name: string;
  type: string;
  enabled: boolean;
}

export interface Registry {
  skills: Map<string, Skill>;
  mcp: Map<string, McpServer>;
  configPath: string | undefined;
  /**
   * Directories that look like skills but could not be loaded (broken symlink,
   * missing SKILL.md, bad frontmatter). Surfaced rather than silently dropped —
   * a skill that vanishes without a word is worse than one that errors loudly.
   */
  problems: string[];
}

/**
 * The six directories opencode itself scans, in its documented precedence order.
 * Project-local entries win over global ones, so later writes must not clobber
 * earlier ones — see the `has()` guard in collectSkills.
 */
function skillRoots(cwd: string): Array<{ dir: string; label: string }> {
  const home = homedir();
  return [
    { dir: join(cwd, ".opencode", "skills"), label: "project:.opencode" },
    { dir: join(cwd, ".claude", "skills"), label: "project:.claude" },
    { dir: join(cwd, ".agents", "skills"), label: "project:.agents" },
    { dir: join(home, ".config", "opencode", "skills"), label: "global:opencode" },
    { dir: join(home, ".claude", "skills"), label: "global:.claude" },
    { dir: join(home, ".agents", "skills"), label: "global:.agents" },
  ];
}

/** opencode's frontmatter contract: `name` and `description` required. */
function readSkill(
  dir: string,
  name: string,
  source: string,
): { skill: Skill } | { problem: string } {
  const file = join(dir, name, "SKILL.md");
  if (!existsSync(file)) return { problem: `${join(dir, name)}: no SKILL.md` };

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { problem: `${file}: unreadable (${(err as Error).message})` };
  }

  // Leading whitespace before the opening `---` is tolerated: real skills in the
  // wild have it (e.g. a stray space), and Claude Code loads them fine.
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n\s*---/.exec(raw);
  if (!match?.[1]) return { problem: `${file}: no YAML frontmatter block` };

  let fm: unknown;
  try {
    fm = parseYaml(match[1]);
  } catch (err) {
    return { problem: `${file}: malformed frontmatter (${(err as Error).message})` };
  }
  if (typeof fm !== "object" || fm === null) {
    return { problem: `${file}: frontmatter is not a mapping` };
  }

  const { name: fmName, description } = fm as Record<string, unknown>;
  return {
    skill: {
      name: typeof fmName === "string" && fmName.length > 0 ? fmName : name,
      description: typeof description === "string" ? description : "",
      path: file,
      source,
    },
  };
}

function collectSkills(cwd: string): { skills: Map<string, Skill>; problems: string[] } {
  const skills = new Map<string, Skill>();
  const problems: string[] = [];

  for (const { dir, label } of skillRoots(cwd)) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(dir, entry);
      try {
        // statSync follows symlinks, so a broken link throws here rather than
        // reporting a directory — that is exactly the case we want to report.
        if (!statSync(path).isDirectory()) continue;
      } catch {
        problems.push(`${path}: broken symlink or unreadable`);
        continue;
      }

      const outcome = readSkill(dir, entry, label);
      if ("problem" in outcome) {
        problems.push(outcome.problem);
        continue;
      }
      // First writer wins — preserves opencode's project-over-global precedence.
      if (!skills.has(outcome.skill.name)) skills.set(outcome.skill.name, outcome.skill);
    }
  }

  return { skills, problems };
}

/** MCP servers live in opencode.json / opencode.jsonc, project first then global. */
function collectMcp(cwd: string): { mcp: Map<string, McpServer>; configPath?: string } {
  const home = homedir();
  const candidates = [
    join(cwd, "opencode.json"),
    join(cwd, "opencode.jsonc"),
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".config", "opencode", "opencode.jsonc"),
  ];

  const mcp = new Map<string, McpServer>();
  let configPath: string | undefined;

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let config: Record<string, unknown>;
    try {
      // Tolerate .jsonc comments; opencode accepts them.
      const text = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
      config = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }

    configPath ??= file;
    const block = config["mcp"];
    if (typeof block !== "object" || block === null) continue;

    for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
      if (mcp.has(name)) continue;
      const server = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
      mcp.set(name, {
        name,
        type: typeof server["type"] === "string" ? (server["type"] as string) : "local",
        // opencode treats a missing `enabled` as true.
        enabled: server["enabled"] !== false,
      });
    }
  }

  return { mcp, configPath };
}

export function loadRegistry(cwd: string = process.cwd()): Registry {
  const { mcp, configPath } = collectMcp(cwd);
  const { skills, problems } = collectSkills(cwd);
  return { skills, mcp, configPath, problems };
}
