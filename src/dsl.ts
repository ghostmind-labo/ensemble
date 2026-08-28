/**
 * The scene format — v2, TypeScript.
 *
 * A scene is ONE .ts file default-exporting a declarative object. Declarative is
 * the load-bearing word: because it is data (with functions only in `when`), the
 * validator can inspect it and the viewer can draw it without executing anything.
 * An imperative script could do neither.
 *
 * `scene()` is an identity function. Its entire job is carrying these types, so
 * that authoring — by a human or by a model — gets autocomplete and type errors
 * before a single token is spent.
 */

import type { ZodTypeAny, TypeOf } from "zod";
import type { ResearchSpec } from "./research.ts";

export type { ResearchSpec };

export type State = Record<string, unknown>;

/**
 * The shape contract for the blackboard: state key → zod schema.
 *
 * Why zod rather than a TypeScript type: a node's outputs arrive as JSON parsed
 * from the model's reply, and TypeScript is erased at run time, so a type alone
 * cannot reject `score: "banana"`. A schema does three jobs at once — it is
 * rendered INTO the node's output contract (models comply far better when shown
 * the shape), it validates what came back (a mismatch is fed to the model as the
 * retry reason), and it carries the static type so `when` predicates are typed.
 */
export type StateSchema = Record<string, ZodTypeAny>;

/**
 * The blackboard as your schemas describe it.
 *
 * Schema'd keys are typed; the index signature keeps unschema'd keys usable, so
 * adding `state` to an existing scene is never a breaking change. Note the keys
 * are typed as always-present for ergonomics (`s.score < 8` rather than
 * `s.score! < 8`) — at run time a key not yet written is `undefined`, so gate on
 * keys the upstream node actually wrote.
 */
export type TypedState<S extends StateSchema> = { [K in keyof S]: TypeOf<S[K]> } & Record<string, unknown>;

/**
 * Where a node executes.
 *
 * - `"model"` (default): a direct OpenRouter HTTP call. Fast, streams tokens,
 *   no local dependencies. No tools, no skills, no MCP — pure think.
 * - `"agent"`: our own tool-calling loop. Gets read-only built-in tools plus any
 *   MCP servers it allowlists, and loops until the model stops asking for tools.
 *   Pure do. (In a scene with a `research` block it also gets `write_file` /
 *   `edit_file`, scoped to `research.edit`.)
 * - `"ask"`: no model call at all. The run **pauses** here until something outside
 *   it supplies the node's `outputs` — a human in the viewer, or an agent calling
 *   `resume_run` with answers. Pure wait.
 * - `"fn"`: a plain function over state — the deterministic neuron. No tokens,
 *   no pause: `fn(state)` returns the node's outputs, validated against the
 *   scene's schemas exactly like model output. Pure compute.
 * - `"experiment"`: the autoresearch step. Requires a scene-level `research`
 *   block. Measures the artefact under study, keeps or reverts it, appends to
 *   results.tsv. Pure measure.
 */
// The built-ins keep autocomplete; `string & {}` admits any runtime mounted
// with registerRuntime() — a runtime is an object, not a member of an enum.
export type NodeRuntime = "model" | "agent" | "ask" | "fn" | "experiment" | (string & {});

export interface NodeSpec {
  /** `openrouter/<vendor>/<model>`, e.g. "openrouter/anthropic/claude-sonnet-5". */
  model?: string;
  runtime?: NodeRuntime;
  /** System-style instruction for this node. */
  prompt?: string;
  /**
   * ask nodes only — what to ask whoever answers. Shown in the viewer and
   * returned by `run_status`, so it must make sense with no other context.
   */
  question?: string;
  /**
   * ask nodes only — park on EVERY entry, not only while outputs are absent.
   * The default (presence-based) asks once and then falls through forever,
   * which is right for a one-time approval and wrong for a loop that must
   * collect a fresh answer each round (a quiz, an iterative review).
   */
  always?: boolean;
  /**
   * fn nodes only — the computation. Receives the CURRENT blackboard (read it
   * freely; `inputs` remain documentation for the graph view) and returns the
   * node's outputs. Keep it pure: throwing fails the node.
   */
  fn?: (state: State) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** State keys injected into the node's prompt as context. */
  inputs?: string[];
  /** State keys harvested from the node's fenced json block. */
  outputs?: string[];
  /** agent nodes only — skill allowlist from the central registry. `[]` = none. */
  skills?: string[];
  /** agent nodes only — MCP server allowlist. */
  mcp?: string[];
  /** agent nodes only — opt a built-in tool out, e.g. { grep: false }. */
  tools?: Record<string, boolean>;
  /** agent nodes only — max tool-calling turns before giving up (default 12). */
  maxTurns?: number;
  /** experiment nodes only — state key logged as the note in results.tsv (e.g. "hypothesis"). */
  note?: string;
  description?: string;
  temperature?: number;
}

export interface EdgeSpec<S extends StateSchema = StateSchema> {
  from: string;
  to: string;
  /**
   * Real code, not a string. Evaluated against the state blackboard after `from`
   * completes. Keep it a pure predicate — throwing fails the run. Declare `state`
   * on the scene and this is typed: `(s) => s.score < 8`, no casts or guards.
   */
  when?: (state: TypedState<S>) => boolean;
  /** How many times this edge may be taken before it stops matching. */
  maxLoops?: number;
}

export interface SceneSpec<S extends StateSchema = StateSchema> {
  name: string;
  description?: string;
  /**
   * Shape contract for the blackboard, shared by every node — the structure a
   * node's `outputs` must respect. Optional and additive: keys with no schema
   * behave exactly as before (presence-checked only).
   */
  state?: S;
  /**
   * Turns the scene into an autoresearch loop (Karpathy's pattern): names the
   * ONE artefact agents may edit, the command that measures it, and the
   * budget. Declaring this is what grants agent nodes their scoped
   * `write_file`/`edit_file` tools and what `runtime: "experiment"` runs.
   */
  research?: ResearchSpec;
  defaults?: {
    model?: string;
    runtime?: NodeRuntime;
    tools?: Record<string, boolean>;
    temperature?: number;
  };
  nodes: Record<string, NodeSpec>;
  /** Named sets of nodes that run concurrently, with a fan-in barrier. */
  groups?: Record<string, string[]>;
  edges?: Array<EdgeSpec<S>>;
  entry: string;
  exit?: string;
}

/**
 * Identity with types — see module docs.
 *
 * The generic is inferred from `state`, which is what makes `when` predicates
 * typed without any annotation at the call site.
 */
export function scene<S extends StateSchema = Record<string, never>>(spec: SceneSpec<S>): SceneSpec<S> {
  return spec;
}
