/**
 * Edge kinds — how a run decides where to go next, as an object.
 *
 * Edges were already objects in shape (`{ from, to, when, maxLoops }`); what
 * they lacked was a registry. The *selection* — which of several matching edges
 * wins — was a loop inside the engine, so a new topology meant editing the
 * engine. That is the one place the "everything is an object" rule was still
 * broken.
 *
 * Note what does NOT change: `when` stays a function-valued PROPERTY of an
 * edge, not a separately mounted object. In this paradigm objects carry
 * identity and composition while functions are the behaviour-carrying leaves on
 * them — `edge.when`, `node.fn`, `runtime.call`, `tool.run`, `backend.parse`.
 * A kind is an object because it has identity and rules; a predicate is a leaf.
 *
 * `sequential` is the built-in and the default: declaration order, first match
 * wins. A scene picks another with a top-level `edgeKind`.
 */
import type { ZodTypeAny } from "zod";
import type { EdgeSpec, State } from "./dsl.ts";
import type { RunEvent } from "./events.ts";

export interface EdgeSelectArgs {
  edges: EdgeSpec[];
  /** The node (or group) that just finished. */
  cursor: string;
  /** Every node in the finished target — a group member may be an edge source. */
  members: string[];
  /** The blackboard. Predicates get a shallow copy, never this. */
  state: State;
  /**
   * How many times each edge (BY INDEX) has been taken. Mutated by the kind and
   * journalled by the engine, so a loop budget survives a stop and resume.
   */
  taken: Map<number, number>;
  emit: (event: RunEvent) => void;
}

export interface EdgeSelection {
  /** Where to go next. Absent means "no edge matched" — the exit, or a stall. */
  next?: string;
  /** A fatal problem, e.g. a predicate that threw. Ends the run. */
  error?: string;
}

export interface EdgeKind {
  name: string;
  summary: string;
  /** Edge properties this kind accepts, beyond `from` and `to`. */
  fields: Record<string, ZodTypeAny>;
  /** Per-edge validation problems (messages, not exceptions). */
  check?: (edge: EdgeSpec, index: number, edges: EdgeSpec[]) => string[];
  select: (args: EdgeSelectArgs) => EdgeSelection;
}

export const EDGE_KINDS: Record<string, EdgeKind> = {};

/** Mounts an edge kind — same groundwork rule as runtimes, tools and backends. */
export function registerEdgeKind(kind: EdgeKind): void {
  EDGE_KINDS[kind.name] = kind;
}

/** Renders a `when` predicate for the viewer and the terminal. */
export function conditionLabel(fn: (state: never) => boolean): string {
  return String(fn).replace(/^\s*\(?\s*\w*\s*\)?\s*=>\s*/, "").trim().slice(0, 80);
}

/**
 * Evaluates one edge's `when` against a SHALLOW COPY of the blackboard.
 *
 * The copy is why a predicate cannot corrupt state by assigning to its
 * argument. It is shallow, so a nested object is still shared — predicates are
 * documented as pure, and a throw is a run failure rather than a silent skip:
 * a condition that errors is a bug in the scene, and hiding it would route the
 * run somewhere the author never intended.
 */
function holds(edge: EdgeSpec, state: State): { ok: boolean } | { error: string } {
  if (!edge.when) return { ok: true };
  try {
    return { ok: Boolean((edge.when as (s: State) => boolean)({ ...state })) };
  } catch (err) {
    return {
      error:
        `condition on ${edge.from}→${edge.to} threw: ${(err as Error).message} — ` +
        `when() must be a pure predicate over state`,
    };
  }
}

/** Shared by every kind: does this edge leave the target that just finished? */
const fromHere = (edge: EdgeSpec, cursor: string, members: string[]): boolean =>
  edge.from === cursor || members.includes(edge.from);

/**
 * Has this edge's loop budget run out? Counts by INDEX, not by `from→to`, so
 * two edges between the same pair keep separate budgets.
 */
function overBudget(edge: EdgeSpec, index: number, taken: Map<number, number>): boolean {
  if (edge.maxLoops === undefined) return false;
  return (taken.get(index) ?? 0) >= edge.maxLoops;
}

export const sequentialEdges: EdgeKind = {
  name: "sequential",
  summary: "declaration order, first match wins — one edge out of every node",
  fields: {},
  select: ({ edges, cursor, members, state, taken, emit }) => {
    for (const [index, edge] of edges.entries()) {
      if (!fromHere(edge, cursor, members)) continue;

      const verdict = holds(edge, state);
      if ("error" in verdict) return { error: verdict.error };
      if (!verdict.ok) continue;

      if (overBudget(edge, index, taken)) {
        emit({ type: "edge", from: edge.from, to: edge.to, skipped: true });
        continue;
      }
      if (edge.maxLoops !== undefined) taken.set(index, (taken.get(index) ?? 0) + 1);

      emit({
        type: "edge",
        from: cursor,
        to: edge.to,
        ...(edge.when ? { when: conditionLabel(edge.when) } : {}),
      });
      return { next: edge.to };
    }
    return {};
  },
};

registerEdgeKind(sequentialEdges);
