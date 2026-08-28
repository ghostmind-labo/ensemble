/**
 * The runtime registry — every way a node can execute, as an OBJECT.
 *
 * The groundwork rule of this codebase: everything is an object, and adding a
 * capability means adding an object (or a property to one), never editing the
 * engine. A runtime object declares, in one place:
 *
 *   - `fields`  — which NodeSpec properties it accepts, with their zod shapes.
 *                 The validator composes each node's legal surface from this,
 *                 so a new property is ONE line here, not edits in four files.
 *   - `check`   — its own semantic validation (an ask node must collect
 *                 something; a model node must reach OpenRouter).
 *   - `park` or `call` — how it executes. `park` runtimes decide instantly
 *                 from state (wait or pass); `call` runtimes make model calls
 *                 and get the engine's shared retry/extraction loop for free.
 *
 * The engine holds no runtime-specific branches: it looks the object up and
 *   uses whichever face it exposes. `registerRuntime()` is exported so library
 * users can mount their own (a webhook runtime, a human-via-slack runtime)
 * without forking anything.
 */
import { z, type ZodTypeAny } from "zod";
import type { NodeSpec, State } from "../dsl.ts";
import type { Registry, Skill } from "../registry.ts";
import type { McpHub } from "../mcp.ts";
import type { NodeResult } from "./model.ts";
import type { ToolCallEvent } from "./agent.ts";
import { callModel } from "./model.ts";
import { callAgent } from "./agent.ts";
import { BUILTIN_TOOLS } from "../tools/builtin.ts";
import { renderInputs } from "../state.ts";
import { experimentRuntime } from "../research.ts";
import type { Scene } from "../scene.ts";
import type { BuiltinTool } from "../tools/builtin.ts";

/** What a parked node is waiting for — re-exported through the engine. */
export interface PendingAsk {
  node: string;
  question: string;
  outputs: string[];
  context?: string;
}

export interface RuntimeParkArgs {
  node: string;
  spec: NodeSpec;
  state: State;
  /** Nodes that already passed once this process — how `always` re-parks. */
  consumed: Set<string>;
}

export interface RuntimeCallArgs {
  node: string;
  spec: NodeSpec;
  defaults: { model?: string; temperature?: number };
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  registry: Registry;
  hub: () => Promise<McpHub>;
  root: string;
  /** Tools contributed by the scene's active capabilities (e.g. research's scoped writes). */
  extraTools?: BuiltinTool[];
  costLimit?: number;
  onDelta: (delta: string) => void;
  onToolCall: (event: ToolCallEvent) => void;
  signal?: AbortSignal;
}

export interface RuntimeComputeArgs {
  node: string;
  spec: NodeSpec;
  state: State;
  root: string;
  runDir: string;
  /** Active capability blocks by name — how a runtime reads the block it serves. */
  capabilities: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface RuntimeObject {
  name: string;
  /** One line for docs and error messages. */
  summary: string;
  /** Shown on node cards: ⚡ / ⛭ / ⏸. */
  badge: string;
  /** Node properties this runtime accepts, beyond the common set. */
  fields: Record<string, ZodTypeAny>;
  /** Whether validation must ensure a model is resolvable for this node. */
  needsModel: boolean;
  /** Runtime-specific validation problems (messages, not exceptions). */
  check?: (name: string, spec: NodeSpec, scene: Scene, registry: Registry) => string[];
  /** MCP servers a node of this runtime wants prewarmed (engine connects lazily). */
  mcpServers?: (spec: NodeSpec) => string[];
  /** Waiting runtimes: park the run or pass through — no model call. */
  park?: (args: RuntimeParkArgs) => { values: State } | { pending: PendingAsk };
  /** Computing runtimes: a deterministic function over state — no model call. */
  compute?: (args: RuntimeComputeArgs) => State | Promise<State>;
  /** Calling runtimes: one attempt; the engine owns retries and extraction. */
  call?: (args: RuntimeCallArgs) => Promise<NodeResult>;
}

/* ────────────────────────────── model ────────────────────────────── */

const modelRuntime: RuntimeObject = {
  name: "model",
  summary: "one direct OpenRouter call — pure think",
  badge: "⚡",
  needsModel: true,
  fields: {
    model: z.string(),
    prompt: z.string(),
    temperature: z.number().min(0).max(2),
  },
  check: (name, spec, scene) => {
    const model = spec.model ?? scene.defaults.model;
    return model && !model.startsWith("openrouter/")
      ? [
          `node "${name}" is runtime "model" but its model "${model}" is not "openrouter/…" — ` +
            `direct calls go through OpenRouter; use runtime: "agent" for other providers`,
        ]
      : [];
  },
  call: async (a) => {
    const temperature = a.spec.temperature ?? a.defaults.temperature;
    return callModel({
      model: a.spec.model ?? a.defaults.model ?? "",
      ...(a.spec.prompt ? { system: a.spec.prompt } : {}),
      messages: a.messages,
      ...(temperature !== undefined ? { temperature } : {}),
      onDelta: a.onDelta,
      ...(a.signal ? { signal: a.signal } : {}),
    });
  },
};

/* ────────────────────────────── agent ────────────────────────────── */

const agentRuntime: RuntimeObject = {
  name: "agent",
  summary: "our tool-calling loop: built-ins + allowlisted MCP — pure do",
  badge: "⛭",
  needsModel: true,
  fields: {
    model: z.string(),
    prompt: z.string(),
    temperature: z.number().min(0).max(2),
    skills: z.array(z.string()),
    mcp: z.array(z.string()),
    tools: z.record(z.boolean()),
    maxTurns: z.number().int().positive().max(50),
  },
  mcpServers: (spec) => spec.mcp ?? [],
  check: (name, spec, _defaults, registry) => {
    const problems: string[] = [];
    for (const skill of spec.skills ?? []) {
      if (!registry.skills.has(skill)) {
        const known = [...registry.skills.keys()].sort().join(", ") || "none installed";
        problems.push(`node "${name}" requests unknown skill "${skill}" — registry has: ${known}`);
      }
    }
    for (const server of spec.mcp ?? []) {
      if (!registry.mcp.has(server)) {
        const known = [...registry.mcp.keys()].sort().join(", ") || "none configured";
        problems.push(`node "${name}" requests unknown MCP server "${server}" — registry has: ${known}`);
      }
    }
    return problems;
  },
  call: async (a) => {
    const temperature = a.spec.temperature ?? a.defaults.temperature;
    const wanted = a.spec.mcp ?? [];
    const hub = wanted.length > 0 ? await a.hub() : undefined;
    const skills = (a.spec.skills ?? [])
      .map((name) => a.registry.skills.get(name))
      .filter((s): s is Skill => Boolean(s));

    return callAgent({
      model: a.spec.model ?? a.defaults.model ?? "",
      ...(a.spec.prompt ? { system: a.spec.prompt } : {}),
      messages: a.messages,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(a.costLimit !== undefined ? { costLimit: a.costLimit } : {}),
      mcp: wanted,
      // `tools: { grep: false }` opts a built-in out; default is all of them.
      builtins: BUILTIN_TOOLS.map((tool) => tool.name).filter((n) => a.spec.tools?.[n] !== false),
      // Capability-contributed tools (research's scoped writes are the first).
      // Per-node opt-out works the same way as for built-ins.
      extraTools: (a.extraTools ?? []).filter((t) => a.spec.tools?.[t.name] !== false),
      skills,
      hub,
      root: a.root,
      maxTurns: a.spec.maxTurns ?? 12,
      onDelta: a.onDelta,
      onToolCall: a.onToolCall,
      ...(a.signal ? { signal: a.signal } : {}),
    });
  },
};

/* ─────────────────────────────── ask ─────────────────────────────── */

const askRuntime: RuntimeObject = {
  name: "ask",
  summary: "no model call — parks the run until a human or agent supplies its outputs",
  badge: "⏸",
  needsModel: false,
  fields: {
    question: z.string(),
    always: z.boolean(),
  },
  check: (name, spec) =>
    (spec.outputs ?? []).length === 0
      ? [
          `node "${name}" is runtime "ask" but declares no outputs — ` +
            `an ask node exists to collect state keys, so it must name at least one`,
        ]
      : [],
  park: ({ node, spec, state, consumed }) => {
    const outputs = spec.outputs ?? [];
    const missing = outputs.filter((key) => state[key] === undefined);
    // `always` nodes pass at most ONCE per process: the entry that consumed a
    // resume's answers. Re-entering (a loop's next round) parks again even
    // though last round's keys are still in state — otherwise a quiz would ask
    // its first question and then play itself.
    const satisfied = missing.length === 0 && !(spec.always && consumed.has(node));
    if (satisfied) {
      consumed.add(node);
      return { values: {} };
    }
    const wanted = spec.always ? outputs : missing;
    const context = renderInputs(state, spec.inputs ?? []);
    return {
      pending: {
        node,
        question: spec.question ?? `Provide: ${wanted.join(", ")}`,
        outputs: wanted,
        ...(context ? { context: context.slice(0, 2000) } : {}),
      },
    };
  },
};

/* ─────────────────────────────── fn ──────────────────────────────── */

const fnRuntime: RuntimeObject = {
  name: "fn",
  summary: "a plain function over state — deterministic, free, instant",
  badge: "λ",
  needsModel: false,
  fields: {
    fn: z.custom<(state: State) => unknown>((v) => typeof v === "function", "must be a function"),
  },
  check: (name, spec) => {
    const problems: string[] = [];
    if (typeof spec.fn !== "function") {
      problems.push(`node "${name}" is runtime "fn" but declares no fn — the function IS the node`);
    }
    if ((spec.outputs ?? []).length === 0) {
      problems.push(`node "${name}" is runtime "fn" but declares no outputs — its return value would be discarded`);
    }
    return problems;
  },
  compute: async ({ spec, state }) => {
    const result = await spec.fn!({ ...state });
    return (result ?? {}) as State;
  },
};

/* ───────────────────────────── registry ───────────────────────────── */

export const RUNTIMES: Record<string, RuntimeObject> = {
  model: modelRuntime,
  agent: agentRuntime,
  ask: askRuntime,
  fn: fnRuntime,
  experiment: experimentRuntime,
};

/** Node properties every runtime shares; everything else belongs to an object. */
export const COMMON_FIELDS = new Set(["runtime", "inputs", "outputs", "description"]);

/**
 * Mounts a new runtime. This is the groundwork paying off: a new way for nodes
 * to execute is an object handed to this function — no engine edits, no schema
 * edits, no validator edits.
 */
export function registerRuntime(runtime: RuntimeObject): void {
  RUNTIMES[runtime.name] = runtime;
}
