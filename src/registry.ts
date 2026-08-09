/**
 * The central catalog.
 *
 * Skills are shared with Claude Code (same SKILL.md format and locations);
 * MCP servers are configured in ensemble.json. We only discover what is there so scenes can reference entries by
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
  type: "local" | "remote";
  enabled: boolean;
  /** Where this definition came from, for `ensemble mcp` output. */
  source: string;
  /** local: argv, e.g. ["npx","-y","@modelcontextprotocol/server-filesystem","."] */
  command?: string[];
  environment?: Record<string, string>;
  /** remote: the server URL */
  url?: string;
  headers?: Record<string, string>;
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
 * The six directories we scan for skills — the same ones Claude Code and
 * opencode use, so existing skills work unchanged.
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

/**
 * MCP servers, gathered from four places in precedence order:
 *
 *   1. ./ensemble.json                    (this project, ours)
 *   2. ./.mcp.json                        (this project, Claude Code's format)
 *   3. ~/.config/ensemble/ensemble.json   (global, ours)
 *   4. ~/.claude.json → mcpServers        (global, Claude Code's)
 *
 * Reading Claude Code's config is deliberate: a user who already wired up MCP
 * servers there should not have to re-declare them. The two formats differ
 * slightly — Claude splits `command` and `args`, and calls remote servers
 * "http" — so they are normalised here rather than at the point of use.
 *
 * First definition wins, so a name declared in ensemble.json overrides the same
 * name inherited from Claude Code.
 */
function normalise(name: string, raw: unknown, source: string): McpServer | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const cfg = raw as Record<string, unknown>;

  const declared = typeof cfg["type"] === "string" ? (cfg["type"] as string) : undefined;
  const url = typeof cfg["url"] === "string" ? (cfg["url"] as string) : undefined;
  // Claude says "http"/"sse"; we say "remote". A url implies remote either way.
  const isRemote = declared === "remote" || declared === "http" || declared === "sse" || Boolean(url);

  // Ours: command: ["npx","-y","pkg"].  Claude's: command: "npx", args: ["-y","pkg"].
  let command: string[] | undefined;
  if (Array.isArray(cfg["command"])) command = cfg["command"] as string[];
  else if (typeof cfg["command"] === "string") {
    command = [cfg["command"] as string, ...((cfg["args"] as string[] | undefined) ?? [])];
  }

  const env = (cfg["environment"] ?? cfg["env"]) as Record<string, string> | undefined;

  return {
    name,
    type: isRemote ? "remote" : "local",
    enabled: cfg["enabled"] !== false,
    source,
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(env && typeof env === "object" ? { environment: env } : {}),
    ...(typeof cfg["headers"] === "object" && cfg["headers"]
      ? { headers: cfg["headers"] as Record<string, string> }
      : {}),
  };
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    // Tolerate // comments so a jsonc-ish config still loads.
    return JSON.parse(readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function collectMcp(cwd: string): { mcp: Map<string, McpServer>; configPath?: string } {
  const home = homedir();
  const sources: Array<{ file: string; key: string; label: string }> = [
    { file: join(cwd, "ensemble.json"), key: "mcp", label: "project:ensemble.json" },
    { file: join(cwd, ".mcp.json"), key: "mcpServers", label: "project:.mcp.json" },
    { file: join(home, ".config", "ensemble", "ensemble.json"), key: "mcp", label: "global:ensemble.json" },
    { file: join(home, ".claude.json"), key: "mcpServers", label: "global:claude" },
  ];

  const mcp = new Map<string, McpServer>();
  let configPath: string | undefined;

  for (const { file, key, label } of sources) {
    const config = readJson(file);
    if (!config) continue;

    const block = config[key];
    if (typeof block !== "object" || block === null) continue;

    configPath ??= file;
    for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
      if (mcp.has(name)) continue; // first source wins
      const server = normalise(name, value, label);
      if (server) mcp.set(name, server);
    }
  }

  return { mcp, configPath };
}

export function loadRegistry(cwd: string = process.cwd()): Registry {
  const { mcp, configPath } = collectMcp(cwd);
  const { skills, problems } = collectSkills(cwd);
  return { skills, mcp, configPath, problems };
}
