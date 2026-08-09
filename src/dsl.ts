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

export type State = Record<string, unknown>;

/**
 * Where a node executes.
 *
 * - `"model"` (default): a direct OpenRouter HTTP call. Fast, streams tokens,
 *   no local dependencies. No tools, no skills, no MCP — pure think.
 * - `"agent"`: our own tool-calling loop. Gets read-only built-in tools plus any
 *   MCP servers it allowlists, and loops until the model stops asking for tools.
 *   Pure do.
 */
export type NodeRuntime = "model" | "agent";

export interface NodeSpec {
  /** `openrouter/<vendor>/<model>`, e.g. "openrouter/anthropic/claude-sonnet-5". */
  model?: string;
  runtime?: NodeRuntime;
  /** System-style instruction for this node. */
  prompt?: string;
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
  description?: string;
  temperature?: number;
}

export interface EdgeSpec {
  from: string;
  to: string;
  /**
   * Real code, not a string. Evaluated against the state blackboard after `from`
   * completes. Keep it a pure predicate — throwing fails the run.
   */
  when?: (state: State) => boolean;
  /** How many times this edge may be taken before it stops matching. */
  maxLoops?: number;
}

export interface SceneSpec {
  name: string;
  description?: string;
  defaults?: {
    model?: string;
    runtime?: NodeRuntime;
    tools?: Record<string, boolean>;
    temperature?: number;
  };
  nodes: Record<string, NodeSpec>;
  /** Named sets of nodes that run concurrently, with a fan-in barrier. */
  groups?: Record<string, string[]>;
  edges?: EdgeSpec[];
  entry: string;
  exit?: string;
}

/** Identity with types — see module docs. */
export function scene(spec: SceneSpec): SceneSpec {
  return spec;
}
