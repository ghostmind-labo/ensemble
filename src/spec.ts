/**
 * The vocabulary — everything you write down, and nothing that runs.
 *
 * A runner is data: three kinds of node, one kind of edge, and a map of
 * handlers. Keeping it data is what lets `validate` prove things about it and
 * `graph` serialise it without executing a line, which in turn is what makes
 * the emitted picture complete rather than a recording of one lucky path.
 *
 * The division of labour that the whole design rests on:
 *
 *   `on:`   branches on MEANING     — a declared option of a decide node.
 *                                     Static, enumerable, drawable, provable.
 *   `when:` branches on ARITHMETIC  — ordinary TypeScript over numbers, dates
 *                                     and counts, because Jev is documented as
 *                                     unreliable at exactly those.
 */
import type { Question } from "./questions.ts";
import type { JevConfig } from "./jev.ts";

export type State = Record<string, unknown>;

/* ─────────────────────────────── handlers ─────────────────────────────── */

export interface HandlerContext {
  readonly state: Readonly<State>;
  readonly goal: string;
  /** Aborts on budget, cancellation, or the caller's own signal. Pass it to your fetch. */
  readonly signal: AbortSignal;
  /**
   * What this step cost, and what served it.
   *
   * The runner never calls a model, so it cannot know either — report them and
   * the run record stays honest about where the money went. Optional: skip it
   * and the step simply records no cost.
   */
  report(info: { cost?: number; meta?: Record<string, unknown> }): void;
}

/** Your code. The runner calls it and does not look inside. */
export type Handler = (ctx: HandlerContext) => unknown | Promise<unknown>;

/* ───────────────────────────────── nodes ──────────────────────────────── */

export interface DecideNode {
  /** The questions, asked together in one request and answered independently. */
  decide: Record<string, Question>;
  /**
   * The ONLY state keys sent to the decider. Required, and not documentation:
   * accuracy is documented to fall as irrelevant detail grows, so the filter is
   * the feature. `goal` is a key like any other here: list it to send it.
   */
  reads: string[];
  /**
   * Below `min` confidence, go to `to` instead of taking any edge.
   * `on` must name a choice or score question — a noul reports no confidence.
   */
  gate?: { on: string; min: number; to: string };
  label?: string;
}

export interface WorkNode {
  /** A key of the runner's `work` map. */
  work: string;
  /** Declared for the data graph; the handler still sees the whole state. */
  reads?: string[];
  /**
   * One key takes the handler's return value directly. Several keys destructure
   * it. Omit it for a node that only has an effect.
   */
  writes?: string[];
  label?: string;
}

export interface CodeNode {
  /** Deterministic, free, instant. Where every judgement about a NUMBER belongs. */
  code: (state: Readonly<State>) => unknown | Promise<unknown>;
  reads?: string[];
  writes?: string[];
  label?: string;
}

export type NodeSpec = DecideNode | WorkNode | CodeNode;

export const isDecide = (node: NodeSpec): node is DecideNode => "decide" in node;
export const isWork = (node: NodeSpec): node is WorkNode => "work" in node;
export const isCode = (node: NodeSpec): node is CodeNode => "code" in node;

/* ───────────────────────────────── edges ──────────────────────────────── */

export interface Edge {
  from: string;
  to: string;
  /** A branch on meaning — see `parseBranch` for the grammar. */
  on?: string;
  /** A branch on arithmetic. Keep it pure; throwing fails the run. */
  when?: (state: State) => boolean;
  /** How many times this edge may be taken before it stops matching. */
  maxLoops?: number;
}

/**
 * The `on` grammar, in full:
 *
 *   "kind=photo"    a choice answered with that option
 *   "needs_text"    a noul at or above 0.5
 *   "!needs_text"   a noul below 0.5
 *   "needs_text>=0.7"   an explicit threshold: >=, >, <=, <
 *
 * A score has no `on` form on purpose. A score is a number, and numbers belong
 * in `when`.
 */
export type Branch =
  | { kind: "option"; key: string; option: string }
  | { kind: "threshold"; key: string; op: ">=" | ">" | "<=" | "<"; value: number };

const BRANCH = /^\s*(!?)\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:(>=|<=|>|<|=)\s*(.+?))?\s*$/;

export function parseBranch(on: string): Branch {
  const match = BRANCH.exec(on);
  if (!match) throw new TypeError(`cannot parse on: ${JSON.stringify(on)}`);
  const bang = match[1] ?? "";
  const key = match[2] ?? "";
  const op = match[3] as ">=" | "<=" | ">" | "<" | "=" | undefined;
  const rest = match[4];

  if (!op) return { kind: "threshold", key, op: bang ? "<" : ">=", value: 0.5 };
  if (bang) throw new TypeError(`on: ${JSON.stringify(on)} — "!" cannot be combined with "${op}"`);
  if (op === "=") {
    if (!rest) throw new TypeError(`on: ${JSON.stringify(on)} — nothing after "="`);
    return { kind: "option", key, option: rest };
  }
  const value = Number(rest);
  if (!Number.isFinite(value)) {
    throw new TypeError(`on: ${JSON.stringify(on)} — "${rest}" is not a number`);
  }
  return { kind: "threshold", key, op, value };
}

/** Does this branch hold, given the blackboard? */
export function branchHolds(branch: Branch, state: Readonly<State>): boolean {
  const value = state[branch.key];
  if (branch.kind === "option") return value === branch.option;
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  switch (branch.op) {
    case ">=":
      return n >= branch.value;
    case ">":
      return n > branch.value;
    case "<=":
      return n <= branch.value;
    case "<":
      return n < branch.value;
  }
}

/* ───────────────────────────────── runner ─────────────────────────────── */

export interface RunnerSpec {
  name: string;
  description?: string;
  /** Keys supplied from outside the run. `goal` is always one. */
  inputs?: string[];
  /** Your workers, by name. */
  work?: Record<string, Handler>;
  nodes: Record<string, NodeSpec>;
  edges?: Edge[];
  entry: string;
  /** The state key returned as `result`. Defaults to the last step's value. */
  result?: string;
  jev?: JevConfig;
}

/* ──────────────────────────── derived facts ───────────────────────────── */

/** Keys present before any node runs. */
export const externalKeys = (spec: RunnerSpec): string[] => [
  ...new Set(["goal", ...(spec.inputs ?? [])]),
];

/** The state keys a node writes. A decide node writes one per question. */
export function writesOf(node: NodeSpec): string[] {
  return isDecide(node) ? Object.keys(node.decide) : (node.writes ?? []);
}

/** The state keys a node reads, as declared. */
export function readsOf(node: NodeSpec): string[] {
  return isDecide(node) ? node.reads : (node.reads ?? []);
}

/** key → the nodes that write it. */
export function producers(spec: RunnerSpec): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, node] of Object.entries(spec.nodes)) {
    for (const key of writesOf(node)) (out[key] ??= []).push(name);
  }
  return out;
}

/** Stable id for an edge — its declaration index. What a run record points at. */
export const edgeId = (index: number): string => `e${index}`;

/**
 * Learn which keys a predicate reads by running it once against a recording
 * proxy. Every access is captured — dotted, bracketed, destructured or `in` —
 * and the predicate sees `undefined` throughout, exactly as it would before the
 * first write. A throw is swallowed: we want its reads, not its verdict.
 *
 * This is how a branch that is opaque CODE still earns a place in the data
 * graph and a truthful label in the emitted picture.
 */
export function probeReads(when: (state: State) => boolean): string[] {
  const seen = new Set<string>();
  const proxy = new Proxy({} as State, {
    get: (_target, key) => {
      if (typeof key === "string") seen.add(key);
      return undefined;
    },
    has: (_target, key) => {
      if (typeof key === "string") seen.add(key);
      return false;
    },
  });
  try {
    when(proxy);
  } catch {
    // the reads were recorded before it threw
  }
  return [...seen];
}
