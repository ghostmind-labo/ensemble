/**
 * Built-in tools.
 *
 * Five read-only (`read_file`, `list_files`, `glob`, `grep`, `fetch_url`) and
 * three that mutate (`write_file`, `edit_file`, `bash`).
 *
 * The write tools were held back for a long time on the argument that a shell
 * is the single largest attack surface an agent can have. That argument is
 * still true; what changed is the conclusion. Without them an agent node could
 * read and report but never *build*, which meant the only way to get real work
 * done was to rent someone else's coding agent — and renting one costs both
 * money and control of the prompt. The bet is that a small, confined, auditable
 * write surface we own beats a large one we do not.
 *
 * The confinement is the whole safety story, so it is worth stating plainly:
 * every path goes through `confine()` and cannot leave the root, and `bash`
 * runs with `cwd` at the root under a wall-clock timeout with a process-group
 * kill. `bash` does NOT sandbox the command itself — a command that reaches
 * outside the root (curl, ssh, a global npm install) will do so. Disarm it
 * scene-wide with `defaults: { tools: { bash: false } }`, or per node.
 *
 * Research mode deliberately narrows this: it replaces `write_file`/`edit_file`
 * with versions scoped to the artefact under study and removes `bash` outright,
 * because a proposer that can shell out can rewrite its own evaluator.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, relative, dirname, sep } from "node:path";
import { spawnBounded } from "../process.ts";

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, root: string): Promise<string> | string;
}

/** Rejects anything that escapes the root — `../` traversal, absolute paths, symlink hops. */
function confine(root: string, candidate: string): string {
  const abs = resolve(root, candidate);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || (rel !== "" && rel.split(sep)[0] === "..")) {
    throw new Error(`path escapes the project root: ${candidate}`);
  }
  return abs;
}

/**
 * Tool output is re-sent to the model on EVERY subsequent turn, so a generous
 * cap is not generosity — it is a multiplier. A single 100KB read across ten
 * turns is ~250k tokens of resend. Keep results small; the model can ask again
 * with a narrower query.
 */
const MAX_BYTES = 20_000;

/**
 * How long a `bash` command may run before it is killed, and the ceiling on a
 * per-call override. Long enough for a test suite, short enough that a command
 * waiting on input dies rather than consuming the node's whole wall clock.
 */
const BASH_TIMEOUT_MS = 120_000;
const BASH_TIMEOUT_MAX_MS = 600_000;

/** Turns `**\/*.ts` style patterns into a RegExp. Supports **, *, ?. */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") i++; // `**/` also matches zero directories
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") out += "[^/]";
    else out += (ch as string).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const SKIP = new Set(["node_modules", ".git", "dist", ".ensemble", ".opencode"]);

function walk(dir: string, root: string, out: string[], depth = 0): void {
  if (depth > 12 || out.length > 5000) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry) || entry.startsWith(".DS")) continue;
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, root, out, depth + 1);
    else out.push(relative(root, abs));
  }
}

export const BUILTIN_TOOLS: BuiltinTool[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the project. Returns at most 100KB. Paths are relative to the project root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the project root" } },
      required: ["path"],
    },
    run: (args, root) => {
      const file = confine(root, String(args["path"] ?? ""));
      if (!existsSync(file)) return `no such file: ${args["path"]}`;
      if (statSync(file).isDirectory()) return `${args["path"]} is a directory — use list_files`;
      const body = readFileSync(file, "utf8");
      return body.length > MAX_BYTES
        ? `${body.slice(0, MAX_BYTES)}\n… [truncated at ${MAX_BYTES} bytes]`
        : body;
    },
  },
  {
    name: "list_files",
    description:
      "List files in a directory (not recursive). Paths are relative to the project root. Use '.' for the root.",
    inputSchema: {
      type: "object",
      properties: { dir: { type: "string", description: "Directory relative to the project root" } },
      required: ["dir"],
    },
    run: (args, root) => {
      const dir = confine(root, String(args["dir"] ?? "."));
      if (!existsSync(dir)) return `no such directory: ${args["dir"]}`;
      const entries = readdirSync(dir)
        .filter((e) => !SKIP.has(e))
        .map((e) => {
          try {
            return statSync(join(dir, e)).isDirectory() ? `${e}/` : e;
          } catch {
            return e;
          }
        });
      return entries.length > 0 ? entries.sort().join("\n") : "(empty)";
    },
  },
  {
    name: "glob",
    description:
      "Find files matching a glob pattern (e.g. '**/*.ts', 'src/*.json'), searched from the project root.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts" } },
      required: ["pattern"],
    },
    run: (args, root) => {
      const pattern = String(args["pattern"] ?? "");
      if (!pattern) return "pattern is required";
      const re = globToRegExp(pattern);
      const files: string[] = [];
      walk(root, root, files);
      const hits = files.filter((f) => re.test(f)).slice(0, 300);
      return hits.length > 0 ? hits.join("\n") : `no files match ${pattern}`;
    },
  },
  {
    name: "grep",
    description:
      "Search file contents for a regular expression. Returns matching lines with their file and line number.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression" },
        glob: { type: "string", description: "Optional file filter, e.g. **/*.ts" },
      },
      required: ["pattern"],
    },
    run: (args, root) => {
      let re: RegExp;
      try {
        re = new RegExp(String(args["pattern"] ?? ""), "i");
      } catch (err) {
        return `invalid regular expression: ${(err as Error).message}`;
      }
      const filter = args["glob"] ? globToRegExp(String(args["glob"])) : undefined;
      const files: string[] = [];
      walk(root, root, files);

      const hits: string[] = [];
      for (const rel of files) {
        if (filter && !filter.test(rel)) continue;
        if (hits.length >= 200) break;
        let body: string;
        try {
          body = readFileSync(join(root, rel), "utf8");
        } catch {
          continue; // binary or unreadable
        }
        body.split("\n").forEach((line, i) => {
          if (hits.length < 200 && re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
      }
      return hits.length > 0 ? hits.join("\n") : `no matches for ${args["pattern"]}`;
    },
  },
  {
    name: "fetch_url",
    description: "Fetch a URL and return its body as text (max 100KB). HTTP(S) only.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "An http(s) URL" } },
      required: ["url"],
    },
    run: async (args) => {
      const raw = String(args["url"] ?? "");
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return `invalid url: ${raw}`;
      }
      if (!["http:", "https:"].includes(url.protocol)) return "only http(s) URLs are allowed";

      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        const text = await res.text();
        const clipped = text.length > MAX_BYTES ? `${text.slice(0, MAX_BYTES)}\n… [truncated]` : text;
        return `HTTP ${res.status}\n\n${clipped}`;
      } catch (err) {
        return `fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  /* ─────────────────────────── the write half ─────────────────────────── */
  {
    name: "write_file",
    description:
      "Write a file, replacing it entirely if it exists. Creates parent directories. " +
      "Confined to the project root. Prefer edit_file for a small change to a large file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root" },
        content: { type: "string", description: "The complete new file contents" },
      },
      required: ["path", "content"],
    },
    run: (args, root) => {
      const file = confine(root, String(args["path"] ?? ""));
      const content = String(args["content"] ?? "");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
      return `wrote ${relative(root, file)} (${content.length} chars)`;
    },
  },
  {
    name: "edit_file",
    description:
      "Replace one exact, unique snippet in a file with new text. Fails if the snippet is " +
      "missing or appears more than once — widen it to disambiguate. Confined to the project root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root" },
        find: { type: "string", description: "Exact text to replace (must occur exactly once)" },
        replace: { type: "string", description: "Replacement text" },
      },
      required: ["path", "find", "replace"],
    },
    run: (args, root) => {
      const file = confine(root, String(args["path"] ?? ""));
      const find = String(args["find"] ?? "");
      if (!find) return "find must not be empty";
      if (!existsSync(file)) return `no such file: ${relative(root, file)} — use write_file to create it`;
      const body = readFileSync(file, "utf8");
      const first = body.indexOf(find);
      if (first === -1) return `snippet not found in ${relative(root, file)} — read the file and copy the text exactly`;
      if (body.indexOf(find, first + 1) !== -1) {
        return `snippet occurs more than once in ${relative(root, file)} — include more surrounding text`;
      }
      writeFileSync(file, body.slice(0, first) + String(args["replace"] ?? "") + body.slice(first + find.length), "utf8");
      return `edited ${relative(root, file)}`;
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command from the project root and return its combined output. " +
      "Use it to build, test, typecheck, or inspect — this is how you VERIFY a change " +
      "you just made rather than assuming it worked. Times out; there is no interactive " +
      "input, so never run a command that waits for a prompt.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command, e.g. \"npm test\"" },
        timeout: { type: "number", description: `Seconds before the command is killed (default ${BASH_TIMEOUT_MS / 1000})` },
      },
      required: ["command"],
    },
    run: async (args, root) => {
      const command = String(args["command"] ?? "").trim();
      if (!command) return "command must not be empty";
      const seconds = Number(args["timeout"]);
      const timeoutMs = Number.isFinite(seconds) && seconds > 0
        ? Math.min(seconds * 1000, BASH_TIMEOUT_MAX_MS)
        : BASH_TIMEOUT_MS;

      const res = await spawnBounded(command, { cwd: root, timeoutMs, shell: true, maxOutput: MAX_BYTES });
      // Exit status is part of the answer, not an exception: a failing test run
      // is exactly the signal the agent asked for.
      const status = res.timedOut
        ? `timed out after ${Math.round(res.ms / 1000)}s (killed)`
        : `exit ${res.exitCode ?? "signal"}`;
      const body = res.output.trim();
      return body ? `[${status}]\n${body}` : `[${status}] (no output)`;
    },
  },
];

/** Names of the tools present at import time. Prefer reading BUILTIN_TOOLS live. */
export const BUILTIN_NAMES = BUILTIN_TOOLS.map((t) => t.name);

/**
 * Mounts a new built-in tool — the same groundwork rule as runtimes and stores:
 * a capability is an object handed to a register function. Every agent node
 * offers it from the next run (opt out per node with `tools: { name: false }`).
 * Keep tools read-only in spirit: agent nodes deliberately have no write/exec
 * built-ins, and a registered tool that mutates state breaks that promise.
 */
export function registerTool(tool: BuiltinTool): void {
  const at = BUILTIN_TOOLS.findIndex((existing) => existing.name === tool.name);
  if (at >= 0) BUILTIN_TOOLS[at] = tool;
  else BUILTIN_TOOLS.push(tool);
}
