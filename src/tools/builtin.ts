/**
 * Built-in tools.
 *
 * Deliberately **read-only and few**. There is no `bash`, no `write`, no `edit`.
 * A shell tool is the single largest attack surface an agent can have, and a
 * hastily-written one is worse than none — anything that needs to mutate the
 * world should go through an MCP server whose author sandboxed it on purpose.
 *
 * Every path is confined to the run's root directory.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, relative, sep } from "node:path";

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
];

export const BUILTIN_NAMES = BUILTIN_TOOLS.map((t) => t.name);
