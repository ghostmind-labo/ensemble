/**
 * Refine mode — keep-or-revert on the blackboard.
 *
 * The score-gate pattern (writer → judge → loop while `score < target`) has a
 * flaw its own example admits: when the budget runs out, the run ends with the
 * LAST attempt, not the best one, and every revision builds on the previous
 * attempt even when that attempt was a regression. Research mode already has
 * the discipline that fixes this — snapshot the incumbent, keep a candidate
 * only if it beats it, restore it otherwise — but only for a file on disk
 * scored by a shell command.
 *
 * `refine` is that discipline applied to a STATE KEY scored by a NODE. The
 * artefact under study is `candidate` (a draft, a plan, a prompt, a tagline);
 * the measure is whatever node writes `score` — a judge model, or an `fn` that
 * counts something. Each round the refine node:
 *
 *   1. compares the candidate's score with the incumbent's (`best`),
 *   2. KEEPS it — the candidate becomes the incumbent — if it wins by more
 *      than `threshold`, or REVERTS by writing the incumbent back over the
 *      candidate key, so the next revision builds on the best, never on a
 *      regression,
 *   3. counts consecutive non-improving rounds, and sets `converged` once
 *      that reaches `patience` or `best` reaches `target`.
 *
 * Two guarantees follow, and neither holds for a plain score gate. When the
 * loop ends — converged, target hit, or `maxLoops` spent — the candidate key
 * holds the best version seen, because the refine node just wrote it there.
 * And every attempt is scored against the same incumbent it was asked to
 * improve, so a score that moves is attributable to the change that moved it.
 *
 * Everything the node remembers lives on the blackboard (`incumbent`, `best`,
 * `stalled`, `history`), so a refine loop survives a stop and resume, and a
 * later run can start from an earlier run's winner by seeding the candidate
 * key through the scene's `inputs`. It is a compute runtime like `fn`: free,
 * instant, deterministic, and held to the scene's schema contract.
 */
import { z } from "zod";
import type { State } from "./dsl.ts";
import type { RuntimeObject } from "./runtimes/index.ts";

/** What the refine node itself is configured by — the `refine`-only NodeSpec fields. */
export interface RefineSpec {
  /** The state key under refinement — the one thing the loop is improving. */
  candidate: string;
  /** The state key holding the judge's number. Default "score". */
  score?: string;
  /** true → lower is better. Default false. */
  minimize?: boolean;
  /** A candidate must beat the incumbent by MORE than this to be kept. Ties revert. Default 0. */
  threshold?: number;
  /** Consecutive non-improving rounds before `converged`. Default 2. */
  patience?: number;
  /** Once `best` reaches this, `converged` — the score-gate's target, absorbed. */
  target?: number;
}

/** Every key a refine node emits — for docs and the validator's hint. */
export const REFINE_OUTPUTS = [
  "incumbent", "best", "round", "verdict", "kept", "reason", "converged", "stalled", "history", "summary",
];

export type RefineVerdict = "baseline" | "keep" | "revert";

export interface RefineRound {
  round: number;
  score: number;
  verdict: RefineVerdict;
}

const scoreKeyOf = (spec: RefineSpec): string => spec.score ?? "score";

/**
 * One round, as a pure function of the blackboard — the whole decision, with
 * no I/O, so it can be tested and reasoned about without a scene.
 *
 * The first round (no `best` in state) is the BASELINE: whatever the candidate
 * key holds is kept as the incumbent, nothing to beat. That is also how a
 * seeded input becomes the thing under refinement — score it first, then
 * every later candidate is compared against it.
 */
export function decideRefine(node: string, spec: RefineSpec, state: State): State {
  const key = spec.candidate;
  const scoreKey = scoreKeyOf(spec);
  const minimize = spec.minimize === true;
  const threshold = spec.threshold ?? 0;
  const patience = spec.patience ?? 2;

  const candidate = state[key];
  if (candidate === undefined) {
    throw new Error(
      `nothing to refine: state has no "${key}" — the node that writes it must run before "${node}"`,
    );
  }
  const raw = state[scoreKey];
  const score = typeof raw === "number" ? raw : Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(score)) {
    throw new Error(
      `"${scoreKey}" is ${raw === undefined ? "missing" : JSON.stringify(raw)}, not a number — ` +
        `the node that scores "${key}" must write a numeric ${scoreKey}; ` +
        `pin it with state: { ${scoreKey}: z.number() }`,
    );
  }

  const round = (Number(state["round"]) || 0) + 1;
  const previousBest = state["best"] === undefined ? undefined : Number(state["best"]);
  const baseline = previousBest === undefined || !Number.isFinite(previousBest);
  const history = Array.isArray(state["history"]) ? (state["history"] as RefineRound[]) : [];

  const better = (c: number, b: number): boolean => (minimize ? b - c > threshold : c - b > threshold);
  const reached = (b: number): boolean =>
    spec.target !== undefined && (minimize ? b <= spec.target : b >= spec.target);

  let verdict: RefineVerdict;
  let best: number;
  let incumbent: unknown;
  let stalled: number;
  let reason: string;

  if (baseline) {
    verdict = "baseline";
    best = score;
    incumbent = candidate;
    stalled = 0;
    reason = `first candidate scored ${score} — the incumbent every later round must beat`;
  } else if (better(score, previousBest)) {
    verdict = "keep";
    best = score;
    incumbent = candidate;
    stalled = 0;
    reason = `${score} beat the incumbent's ${previousBest}`;
  } else {
    verdict = "revert";
    best = previousBest;
    incumbent = state["incumbent"];
    stalled = (Number(state["stalled"]) || 0) + 1;
    reason =
      score === previousBest
        ? `${score} tied the incumbent — a tie reverts`
        : `${score} did not beat the incumbent's ${previousBest}` +
          (threshold > 0 ? ` by more than ${threshold}` : "");
    // The revert has nothing to restore if the incumbent was never banked —
    // a hand-edited state.json, say. The best we can do is keep what is there.
    if (incumbent === undefined) incumbent = candidate;
  }

  const hitTarget = reached(best);
  const stalledOut = stalled >= patience;
  const converged = hitTarget || stalledOut;
  const why = hitTarget
    ? `target ${spec.target} reached`
    : stalledOut
      ? `no improvement in ${stalled} round${stalled === 1 ? "" : "s"}`
      : "";

  return {
    // The revert made visible: the candidate key always leaves this node
    // holding the incumbent, whether that is the new winner or the old one.
    [key]: incumbent,
    incumbent,
    best,
    round,
    verdict,
    kept: verdict !== "revert",
    reason,
    converged,
    stalled,
    history: [...history, { round, score, verdict }],
    summary:
      `round ${round} · ${verdict} · ${score}${baseline ? "" : ` vs best ${previousBest}`}` +
      (converged ? ` — converged: ${why}` : ""),
  };
}

export const refineRuntime: RuntimeObject = {
  name: "refine",
  summary: "keep the best candidate on the blackboard, revert a regression, stop when the score stops rising",
  badge: "⬆",
  needsModel: false,
  fields: {
    candidate: z.string().min(1),
    score: z.string().min(1),
    minimize: z.boolean(),
    threshold: z.number().min(0),
    patience: z.number().int().min(1),
    target: z.number(),
  },
  // The candidate and its score are read from state by the OBJECT's own
  // rules, not through `inputs` — declaring them here is what lets the data
  // graph prove they are produced and draw where they come from.
  reads: (spec) => {
    const r = spec as unknown as RefineSpec;
    return r.candidate ? [r.candidate, scoreKeyOf(r)] : [scoreKeyOf(r)];
  },
  check: (name, spec, scene) => {
    const problems: string[] = [];
    const r = spec as unknown as RefineSpec;
    if (!r.candidate) {
      problems.push(`node "${name}" is runtime "refine" but names no candidate — the state key under refinement`);
      return problems;
    }
    const outputs = spec.outputs ?? [];
    if (!outputs.includes(r.candidate)) {
      problems.push(
        `node "${name}" refines "${r.candidate}" but does not list it in outputs — the revert writes the ` +
          `incumbent back to "${r.candidate}", and the data graph must show that; add it to outputs`,
      );
    }
    if (r.candidate === scoreKeyOf(r)) {
      problems.push(`node "${name}" names "${r.candidate}" as both candidate and score — they must be different keys`);
    }
    // This node only ever writes the candidate BACK, so its own outputs do not
    // count as an origin: some other node, or the outside world, must write it
    // first. The general dataflow proof cannot see that distinction — to it a
    // producer is a producer — so the object makes the check itself.
    const origins = Object.entries(scene.nodes)
      .filter(([other, n]) => other !== name && (n.outputs ?? []).includes(r.candidate))
      .map(([other]) => other);
    if (origins.length === 0 && !(scene.inputs ?? []).includes(r.candidate)) {
      const produced = [...new Set(Object.entries(scene.nodes)
        .filter(([other]) => other !== name)
        .flatMap(([other, n]) => (n.outputs ?? []).map((k) => `"${k}" (by ${other})`)))];
      problems.push(
        `node "${name}" refines "${r.candidate}" but no other node produces it — the refine node only writes ` +
          `the incumbent back, so something must write "${r.candidate}" first. ` +
          (produced.length ? `Keys produced in this scene: ${produced.join(", ")}.` : "No other node declares any outputs.") +
          ` If it is meant to arrive from outside, declare it: inputs: ["${r.candidate}"] at the scene level.`,
      );
    }
    return problems;
  },
  compute: ({ node, spec, state }) => decideRefine(node, spec as unknown as RefineSpec, state),
};
