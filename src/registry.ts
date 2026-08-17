/**
 * The central catalog.
 *
 * Skills are shared with Claude Code (same SKILL.md format and locations);
 * MCP servers are configured in ensemble.json. We only discover what is there so scenes can reference entries by
 * name and `graph validate` can reject typos before a run burns tokens.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
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
  sources: Sources;
}

/**
 * Which registries to inherit, and where else to look.
 *
 * Inheriting Claude Code's skills and MCP servers is the default because it is
 * almost always what someone wants — but "almost always" is not "always". A team
 * shipping a repo may want *only* its own definitions, with no dependence on
 * whatever happens to be on the machine. `sources` in ensemble.json turns each
 * inherited location off, and `skillDirs` adds your own.
 */
export interface Sources {
  claudeSkills: boolean;
  opencodeSkills: boolean;
  agentsSkills: boolean;
  claudeMcp: boolean;
  /** Extra skill directories, relative to the project (or absolute). */
  skillDirs: string[];
}

const DEFAULT_SOURCES: Sources = {
  claudeSkills: true,
  opencodeSkills: true,
  agentsSkills: true,
  claudeMcp: true,
  skillDirs: [],
};

function readSources(cwd: string): Sources {
  const merged = { ...DEFAULT_SOURCES };
  // Later entries win, so project beats global and the convention beats legacy.
  for (const file of [
    join(homedir(), ".config", "ensemble", "ensemble.json"),
    join(cwd, "ensemble.json"),
    join(cwd, ".ensemble", "ensemble.json"),
  ]) {
    const config = readJson(file);
    const raw = config?.["sources"];
    if (typeof raw !== "object" || raw === null) continue;
    const src = raw as Record<string, unknown>;
    for (const key of ["claudeSkills", "opencodeSkills", "agentsSkills", "claudeMcp"] as const) {
      if (typeof src[key] === "boolean") merged[key] = src[key] as boolean;
    }
    if (Array.isArray(src["skillDirs"])) merged.skillDirs = src["skillDirs"] as string[];
  }
  return merged;
}

/**
 * Directories scanned for skills. The defaults are the same six Claude Code and
 * opencode use, so existing skills work unchanged; `sources` can switch any of
 * them off. Earlier entries win, so project beats global and your own
 * `skillDirs` beat everything.
 */
function skillRoots(cwd: string, sources: Sources): Array<{ dir: string; label: string }> {
  const home = homedir();
  const roots: Array<{ dir: string; label: string }> = [];

  // Yours first — an explicit location should never lose to an inherited one.
  for (const dir of sources.skillDirs) {
    roots.push({ dir: isAbsolute(dir) ? dir : join(cwd, dir), label: `custom:${dir}` });
  }

  if (sources.opencodeSkills) roots.push({ dir: join(cwd, ".opencode", "skills"), label: "project:.opencode" });
  if (sources.claudeSkills) roots.push({ dir: join(cwd, ".claude", "skills"), label: "project:.claude" });
  if (sources.agentsSkills) roots.push({ dir: join(cwd, ".agents", "skills"), label: "project:.agents" });
  if (sources.opencodeSkills) roots.push({ dir: join(home, ".config", "opencode", "skills"), label: "global:opencode" });
  if (sources.claudeSkills) roots.push({ dir: join(home, ".claude", "skills"), label: "global:.claude" });
  if (sources.agentsSkills) roots.push({ dir: join(home, ".agents", "skills"), label: "global:.agents" });

  return roots;
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

function collectSkills(cwd: string, sources: Sources): { skills: Map<string, Skill>; problems: string[] } {
  const skills = new Map<string, Skill>();
  const problems: string[] = [];

  for (const { dir, label } of skillRoots(cwd, sources)) {
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
 * MCP servers, gathered from five places in precedence order:
 *
 *   1. ./.ensemble/ensemble.json          (this project, ours — the convention)
 *   2. ./ensemble.json                    (this project, ours — legacy location)
 *   3. ./.mcp.json                        (this project, Claude Code's format)
 *   4. ~/.config/ensemble/ensemble.json   (global, ours)
 *   5. ~/.claude.json → mcpServers        (global, Claude Code's)
 *
 * Everything a project owns lives under `.ensemble/` — scenes, runs, and config —
 * so `.ensemble/ensemble.json` is the place to put it. The bare `./ensemble.json`
 * still loads so existing projects keep working.
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

/**
 * Loads `.env` from the project root, once, if present.
 *
 * The whole point of `${VAR}` interpolation below is that ensemble.json can be
 * committed while the secret is not. That only holds if the secret has somewhere
 * convenient to live — so a gitignored `.env` beside the config is read
 * automatically. Real environment variables always win over the file.
 */
let envLoaded = false;
function loadDotEnv(cwd: string): void {
  if (envLoaded) return;
  envLoaded = true;
  // Beside the config either way: `.ensemble/.env` for the convention layout,
  // `./.env` for the legacy one.
  const file = [join(cwd, ".ensemble", ".env"), join(cwd, ".env")].find((f) => existsSync(f));
  if (!file) return;
  try {
    const before = { ...process.env };
    process.loadEnvFile(file);
    // Node's loader overwrites; restore anything that was already set so an
    // explicitly exported variable beats a stale line in the file.
    for (const [key, value] of Object.entries(before)) {
      if (value !== undefined) process.env[key] = value;
    }
  } catch {
    /* a malformed .env should not stop the whole registry from loading */
  }
}

/** Names referenced by `${VAR}` in a config but absent from the environment. */
export const missingEnv = new Set<string>();

/**
 * Expands `${VAR}` and `${VAR:-fallback}` throughout a config value.
 *
 * Without this, the only way to give a server a token is to hardcode it — which
 * makes the file uncommittable. A missing variable is recorded and expanded to
 * an empty string rather than left as the literal `${VAR}`, because sending
 * "Bearer ${GITHUB_TOKEN}" to a server produces a baffling 401 instead of a
 * clear "you forgot to set GITHUB_TOKEN".
 */
function expandEnv<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
      const found = process.env[name];
      if (found !== undefined && found !== "") return found;
      if (fallback !== undefined) return fallback;
      missingEnv.add(name);
      return "";
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandEnv(v);
    return out as unknown as T;
  }
  return value;
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    // Tolerate // comments so a jsonc-ish config still loads.
    const raw = JSON.parse(readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;
    return expandEnv(raw);
  } catch {
    return undefined;
  }
}

function collectMcp(cwd: string, sources: Sources): { mcp: Map<string, McpServer>; configPath?: string } {
  const home = homedir();
  const files: Array<{ file: string; key: string; label: string }> = [
    { file: join(cwd, ".ensemble", "ensemble.json"), key: "mcp", label: "project:.ensemble/ensemble.json" },
    { file: join(cwd, "ensemble.json"), key: "mcp", label: "project:ensemble.json" },
    { file: join(cwd, ".mcp.json"), key: "mcpServers", label: "project:.mcp.json" },
    { file: join(home, ".config", "ensemble", "ensemble.json"), key: "mcp", label: "global:ensemble.json" },
    { file: join(home, ".claude.json"), key: "mcpServers", label: "global:claude" },
    // `.mcp.json` and `~/.claude.json` are Claude Code's; sources can drop them.
  ].filter((src) => sources.claudeMcp || !src.label.includes("claude"));

  const mcp = new Map<string, McpServer>();
  let configPath: string | undefined;

  for (const { file, key, label } of files) {
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
  loadDotEnv(cwd);
  missingEnv.clear();
  const sources = readSources(cwd);
  const { mcp, configPath } = collectMcp(cwd, sources);
  const { skills, problems } = collectSkills(cwd, sources);
  for (const name of missingEnv) {
    problems.push(`config references \${${name}} but ${name} is not set — export it or add it to .env`);
  }
  return { skills, mcp, configPath, problems, sources };
}
