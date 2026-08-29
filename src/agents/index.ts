/**
 * Agent backends — the coding agent itself as a mountable object.
 *
 * `runtime: "agent"` is our own loop: cheap, no subprocess, ~250 tokens of
 * scaffolding. It is the right default and most nodes should stay on it. But a
 * node that must genuinely *build* something wants the thing other people have
 * spent years on — a real editing loop, a permission model, LSP, verification.
 * Rather than reimplement that, mount it.
 *
 * A backend is an object with two behaviours: build an invocation, and read the
 * output back. `registerAgentBackend` turns it into a full runtime via
 * `registerRuntime`, so the backend's NAME becomes the runtime name and a node
 * reads `runtime: "opencode"`. Your own backend is the same one call.
 *
 * Why this is not the integration we deleted. The old one (`compile.ts`,
 * removed in fadd5c5) COMPILED scenes into `.opencode/agents/*.md` and handed
 * the CLI the whole node — its prompt, its loop, its output. That is why its
 * personality "competed with the scene's output contract": there was no
 * contract left to compete with. Here the CLI is a callee, not a host. It gets
 * one stateless subprocess per node attempt, handed the engine's own prompt
 * including the `## Required output` block, and the engine parses and retries
 * the result exactly as it does for every other runtime. Nothing is written to
 * disk and no session is carried between calls.
 *
 * The cost is real and should be said plainly: an external CLI carries
 * thousands of tokens of its own scaffolding per call, which is what made
 * renting one expensive the first time. Reach for a backend per node, when the
 * node earns it.
 */
import { z, type ZodTypeAny } from "zod";
import { existsSync } from "node:fs";
import { dirname, resolve, relative, join, sep, delimiter } from "node:path";
import { spawnBounded, type BoundedResult } from "../process.ts";
import { registerRuntime, type RuntimeObject } from "../runtimes/index.ts";
import type { McpServer, Skill } from "../registry.ts";

/** Everything a backend needs to build one invocation. */
export interface AgentCliRequest {
  /** The scene's model ref, verbatim: "openrouter/<vendor>/<model>". */
  model: string;
  /** The complete text to hand the CLI: node prompt, goal, inputs, output contract. */
  prompt: string;
  /** Working directory. Always set on the process; a backend MAY also pass a flag. */
  cwd: string;
  timeoutMs: number;
  /**
   * Folders containing a SKILL.md, for backends that can load external skills.
   *
   * This is how a scene's `defaults.skills` reaches a rented agent instead of
   * stopping at our own loop: the same grant, the same files, both sides.
   */
  skillDirs: string[];
  /** MCP servers granted to this node, straight from ensemble's registry. */
  mcp: McpServer[];
  /** The node's own extra fields, for backend-specific options. */
  spec: Record<string, unknown>;
}

/** What a backend got back. Cost and tokens are best-effort: many CLIs report none. */
export interface AgentCliResult {
  text: string;
  cost?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Set when the run failed in a way the engine should treat as a node error. */
  error?: string;
}

export interface AgentBackend {
  /** Also becomes the runtime name: `runtime: "<name>"`. */
  name: string;
  summary: string;
  /** Node-card glyph. Defaults to a rented-agent marker. */
  badge?: string;
  /** The executable. Absence is a validate-time problem, not a run-time crash. */
  bin: string;
  /** Shown when `bin` is missing, e.g. "brew install sst/tap/opencode". */
  install?: string;
  /** Extra node fields beyond the shared set. */
  fields?: Record<string, ZodTypeAny>;
  command(req: AgentCliRequest): { argv: string[]; env?: Record<string, string> };
  parse(res: BoundedResult): AgentCliResult;
}

export const AGENT_BACKENDS: Record<string, AgentBackend> = {};

/** Fields every backend node accepts, whatever the backend. */
const SHARED_FIELDS: Record<string, ZodTypeAny> = {
  model: z.string(),
  prompt: z.string(),
  skills: z.array(z.string()),
  mcp: z.array(z.string()),
  /** Wall-clock seconds for the subprocess. */
  timeout: z.number().positive().max(3 * 60 * 60),
  /** Run in a subdirectory of the project root. */
  dir: z.string(),
};

const DEFAULT_TIMEOUT_S = 600;

/**
 * Is the binary reachable? Walked by hand rather than shelled out to.
 *
 * `command -v` would need `shell: true`, which concatenates rather than escapes
 * its arguments — a backend name is not user input today, but a lookup that
 * cannot be injected into is one less thing to remember later. It is also
 * faster, which matters because this runs once per node during validate.
 */
function onPath(bin: string): boolean {
  if (bin.includes("/") || bin.includes("\\")) return existsSync(bin);
  const exts = process.platform === "win32"
    ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  return (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => exts.some((ext) => existsSync(join(dir, bin + ext))));
}

/** Confines `dir` to the root the same way the file tools confine a path. */
function workdir(root: string, dir: string | undefined): string {
  if (!dir) return root;
  const abs = resolve(root, dir);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || (rel !== "" && rel.split(sep)[0] === "..")) {
    throw new Error(`dir escapes the project root: ${dir}`);
  }
  return abs;
}

/**
 * Mounts an agent backend as a runtime.
 *
 * The generated runtime is a *calling* one, so it inherits — free — the
 * engine's output contract, its two-attempt retry, per-node cost accounting,
 * the run budget, journalled resume and cancellation. A backend author writes
 * an argv and a parser; the orchestration is already there.
 */
export function registerAgentBackend(backend: AgentBackend): void {
  AGENT_BACKENDS[backend.name] = backend;

  const runtime: RuntimeObject = {
    name: backend.name,
    summary: backend.summary,
    badge: backend.badge ?? "⧉",
    needsModel: true,
    fields: { ...SHARED_FIELDS, ...(backend.fields ?? {}) },

    // Which MCP servers to prewarm is moot — the CLI connects its own — but the
    // engine uses this to decide what to load, and a backend node's grants must
    // still resolve against the registry.
    mcpServers: () => [],

    check: (name, spec, scene, registry) => {
      const problems: string[] = [];
      if (!onPath(backend.bin)) {
        problems.push(
          `node "${name}" is runtime "${backend.name}" but "${backend.bin}" is not on PATH` +
            (backend.install ? ` — install it with: ${backend.install}` : ""),
        );
      }
      const all = <T>(a: T[] | undefined, b: T[] | undefined): T[] => [...new Set([...(b ?? []), ...(a ?? [])])];
      for (const skill of all(spec.skills, scene.defaults.skills)) {
        if (!registry.skills.has(skill)) {
          problems.push(`node "${name}" requests unknown skill "${skill}"`);
        }
      }
      for (const server of all(spec.mcp, scene.defaults.mcp)) {
        if (!registry.mcp.has(server)) {
          problems.push(`node "${name}" requests unknown MCP server "${server}"`);
        }
      }
      return problems;
    },

    call: async (a) => {
      // Backend fields are declared per backend, so NodeSpec cannot know them
      // statically — validation already checked them against `fields`.
      const extra = a.spec as unknown as Record<string, unknown>;
      const model = a.spec.model ?? a.defaults.model ?? "";
      const cwd = workdir(a.root, extra["dir"] as string | undefined);
      const timeoutMs = ((extra["timeout"] as number | undefined) ?? DEFAULT_TIMEOUT_S) * 1000;

      // The node's own instruction first, then everything the engine assembled
      // (goal, upstream state, the required-output block). Same material our
      // own loop gets — which is what keeps the output contract in force.
      const prompt = [
        a.spec.prompt ?? "",
        ...a.messages.map((m) => m.content),
      ].filter(Boolean).join("\n\n");

      const union = <T>(x: T[] | undefined, y: T[] | undefined): T[] => [...new Set([...(y ?? []), ...(x ?? [])])];
      const skillDirs = union(a.spec.skills, a.defaults.skills)
        .map((n) => a.registry.skills.get(n))
        .filter((s): s is Skill => Boolean(s))
        .map((s) => dirname(s.path));
      const mcp = union(a.spec.mcp, a.defaults.mcp)
        .map((n) => a.registry.mcp.get(n))
        .filter((s): s is McpServer => Boolean(s));

      const { argv, env } = backend.command({
        model, prompt, cwd, timeoutMs, skillDirs, mcp, spec: extra,
      });

      const res = await spawnBounded(argv, {
        cwd,
        timeoutMs,
        ...(env ? { env } : {}),
        ...(a.signal ? { signal: a.signal } : {}),
      });

      if (res.timedOut) {
        return {
          text: "", modelID: model, providerID: backend.name,
          cost: 0, tokensIn: 0, tokensOut: 0,
          error: `${backend.name} timed out after ${Math.round(res.ms / 1000)}s — raise the node's \`timeout\` or narrow its job`,
        };
      }

      const out = backend.parse(res);
      // Streaming after the fact is still better than nothing: the viewer and
      // the terminal reporter both render whatever the node produced.
      if (out.text) a.onDelta(out.text);

      return {
        text: out.text.trim(),
        modelID: model,
        providerID: backend.name,
        cost: out.cost ?? 0,
        tokensIn: out.tokensIn ?? 0,
        tokensOut: out.tokensOut ?? 0,
        ...(out.error ? { error: out.error } : {}),
      };
    },
  };

  registerRuntime(runtime);
}
