/**
 * Does the neuron fire right, and does it know when it doesn't?
 *
 * `validate` proves a graph's wiring and a dry run proves its plumbing, but
 * neither says whether a decision is any GOOD. That is the question that
 * decides whether ensemble belongs in a system at all, so it gets its own
 * instrument rather than a hope.
 *
 * Two things are measured, and the second is the one that matters here.
 * Accuracy: given labelled cases, how often is the answer right. Calibration:
 * when Jev says 0.9, is it right nine times in ten. A decider that is often
 * wrong but knows it is still useful, because a gate can send its unsure cases
 * to a safe exit. One that is confidently wrong is not, and no gate can save
 * it. So the report also prices every gate: keep answers above this
 * confidence, and this is how many you keep and how many of those are right.
 *
 * It tests decide nodes in isolation, the way you would test one neuron: the
 * case supplies exactly the state the node reads, and nothing else runs. No
 * handler fires, no model is called, and a case set costs about $0.00002 a
 * case. A case set with a problem is refused before anything is spent.
 */
import { jev, type Decider } from "./jev.ts";
import type { Answer, Question } from "./questions.ts";
import { isDecide, type RunnerSpec, type State } from "./spec.ts";

export interface Case {
  /** The state the decide node reads. Every key in its `reads` must be here. */
  inputs: State;
  /**
   * The right answer per question, by `node.key` or a bare key when only one
   * node asks it. A choice takes an option name, a noul `true`/`false`, a score
   * its 0-based level.
   */
  expect: Record<string, string | number | boolean>;
}

export interface CalibrateOptions {
  decider?: Decider;
  /** Stop asking once this much has been spent, in USD. */
  budget?: number;
  /** Decider calls in flight at once. Default 4. */
  concurrency?: number;
  signal?: AbortSignal;
}

export interface GatePrice {
  min: number;
  /** Share of cases a gate at `min` lets through. The rest go to the unsure path. */
  keeps: number;
  /** Accuracy on the cases it lets through, or null when it lets none through. */
  accuracy: number | null;
}

export interface Miss {
  case: number;
  expected: string | number | boolean;
  got: string | number;
  confidence: number;
}

export interface QuestionReport {
  node: string;
  key: string;
  type: Question["type"];
  n: number;
  accuracy: number;
  /** Mean confidence. For a noul, how far P(yes) sits from 0.5, rescaled to 0.5–1. */
  confidence: number;
  /** Expected calibration error: the average gap between confidence and accuracy, 10 bins. 0 is honest. */
  gap: number;
  /** Noul only: mean squared distance between P(yes) and the truth. 0 is perfect, 0.25 is a coin. */
  brier?: number;
  /** Score only: mean distance from the right level. */
  meanError?: number;
  /** Choice and score only, since only those can be gated. */
  gates?: GatePrice[];
  misses: Miss[];
}

export interface Calibration {
  runner: string;
  cases: number;
  /** Decider calls made. One per case per decide node it tests. */
  asked: number;
  cost: number;
  /** Set when the budget ran out before every case was asked. */
  stopped?: "budget" | "cancelled";
  questions: QuestionReport[];
}

/** The case set is wrong. Nothing was asked, so nothing was spent. */
export class CalibrationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`the case set has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  - ${problems.join("\n  - ")}`);
    this.name = "CalibrationError";
    this.problems = problems;
  }
}

interface Target {
  node: string;
  key: string;
  question: Question;
}

const GATES = [0.5, 0.6, 0.7, 0.8, 0.9];
const round = (n: number, places = 4): number => Number(n.toFixed(places));

/** Every question a decide node asks, by `node.key` and by bare key where that is unambiguous. */
function targets(spec: RunnerSpec): Map<string, Target | "ambiguous"> {
  const found = new Map<string, Target | "ambiguous">();
  for (const [node, declared] of Object.entries(spec.nodes)) {
    if (!isDecide(declared)) continue;
    for (const [key, question] of Object.entries(declared.decide)) {
      const target = { node, key, question };
      found.set(`${node}.${key}`, target);
      found.set(key, found.has(key) ? "ambiguous" : target);
    }
  }
  return found;
}

/** A readable truth, or a reason it isn't one. */
function checkExpected(target: Target, value: unknown): string | undefined {
  const { question } = target;
  const where = `${target.node}.${target.key}`;
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    return typeof value === "string" && options.includes(value)
      ? undefined
      : `${where} is a choice — expect one of ${options.join(", ")}, not ${JSON.stringify(value)}`;
  }
  if (question.type === "noul") {
    return typeof value === "boolean" ? undefined : `${where} is a noul — expect true or false, not ${JSON.stringify(value)}`;
  }
  const top = question.criteria.length - 1;
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= top
    ? undefined
    : `${where} is a score — expect a level from 0 to ${top}, not ${JSON.stringify(value)}`;
}

/** Right or wrong, how sure, and what came back. */
function judge(answer: Answer, expected: string | number | boolean): { right: boolean; confidence: number; got: string | number } {
  if (answer.type === "choice") {
    return { right: answer.choice === expected, confidence: answer.confidence, got: answer.choice };
  }
  if (answer.type === "score") {
    return { right: Math.round(answer.score) === expected, confidence: answer.confidence, got: round(answer.score, 3) };
  }
  return {
    right: answer.noul >= 0.5 === expected,
    confidence: Math.max(answer.noul, 1 - answer.noul),
    got: round(answer.noul, 3),
  };
}

/** Expected calibration error over ten equal-width bins. */
function calibrationGap(points: Array<{ right: boolean; confidence: number }>): number {
  if (points.length === 0) return 0;
  let gap = 0;
  for (let bin = 0; bin < 10; bin++) {
    const inside = points.filter((p) => Math.min(9, Math.floor(p.confidence * 10)) === bin);
    if (inside.length === 0) continue;
    const accuracy = inside.filter((p) => p.right).length / inside.length;
    const confidence = inside.reduce((sum, p) => sum + p.confidence, 0) / inside.length;
    gap += (inside.length / points.length) * Math.abs(accuracy - confidence);
  }
  return round(gap);
}

export async function calibrate(
  runner: { spec: RunnerSpec },
  cases: Case[],
  options: CalibrateOptions = {},
): Promise<Calibration> {
  const { spec } = runner;
  const known = targets(spec);
  const problems: string[] = [];

  // Resolve every case to the decide nodes it tests, before a cent is spent.
  const plan: Array<{ index: number; node: string; tested: Array<{ target: Target; expected: string | number | boolean }> }> = [];
  for (const [index, test] of cases.entries()) {
    const label = `case ${index + 1}`;
    if (!test || typeof test.inputs !== "object" || typeof test.expect !== "object") {
      problems.push(`${label} needs { inputs: {…}, expect: {…} }`);
      continue;
    }
    const byNode = new Map<string, Array<{ target: Target; expected: string | number | boolean }>>();
    for (const [name, expected] of Object.entries(test.expect)) {
      const target = known.get(name);
      if (!target) {
        problems.push(`${label} expects "${name}", which no decide node asks — use node.key, e.g. ${[...known.keys()].find((k) => k.includes(".")) ?? "classify.route"}`);
        continue;
      }
      if (target === "ambiguous") {
        problems.push(`${label} expects "${name}", which more than one node asks — write it as node.key`);
        continue;
      }
      const wrong = checkExpected(target, expected);
      if (wrong) {
        problems.push(`${label}: ${wrong}`);
        continue;
      }
      byNode.set(target.node, [...(byNode.get(target.node) ?? []), { target, expected }]);
    }
    for (const [node, tested] of byNode) {
      const decide = spec.nodes[node]!;
      const missing = (isDecide(decide) ? decide.reads : []).filter((key) => !(key in test.inputs));
      if (missing.length) {
        problems.push(`${label} tests ${node}, which reads ${missing.join(", ")} — add ${missing.map((k) => `"${k}"`).join(", ")} to its inputs`);
        continue;
      }
      plan.push({ index, node, tested });
    }
  }
  if (cases.length === 0) problems.push("no cases — a calibration needs labelled examples");
  if (problems.length) throw new CalibrationError(problems);

  const decider = options.decider ?? jev(spec.jev);
  const results = new Map<string, Array<{ case: number; right: boolean; confidence: number; got: string | number; expected: string | number | boolean; answer: Answer }>>();
  let cost = 0;
  let asked = 0;
  let stopped: Calibration["stopped"];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < plan.length) {
      if (options.signal?.aborted) {
        stopped = "cancelled";
        return;
      }
      if (options.budget !== undefined && cost >= options.budget) {
        stopped = "budget";
        return;
      }
      const item = plan[next++]!;
      const node = spec.nodes[item.node]!;
      if (!isDecide(node)) continue;
      const state = Object.fromEntries(node.reads.map((key) => [key, cases[item.index]!.inputs[key]]));
      const decision = await decider(state, node.decide);
      asked++;
      cost += decision.cost;
      for (const { target, expected } of item.tested) {
        const answer = decision.answers[target.key];
        if (!answer) throw new Error(`the decider returned no answer for ${target.node}.${target.key}`);
        const id = `${target.node}.${target.key}`;
        results.set(id, [...(results.get(id) ?? []), { case: item.index + 1, expected, answer, ...judge(answer, expected) }]);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));

  const questions: QuestionReport[] = [];
  for (const [id, points] of [...results].sort(([a], [b]) => a.localeCompare(b))) {
    const target = known.get(id) as Target;
    points.sort((a, b) => a.case - b.case);
    const n = points.length;
    const report: QuestionReport = {
      node: target.node,
      key: target.key,
      type: target.question.type,
      n,
      accuracy: round(points.filter((p) => p.right).length / n),
      confidence: round(points.reduce((sum, p) => sum + p.confidence, 0) / n),
      gap: calibrationGap(points),
      misses: points
        .filter((p) => !p.right)
        .map((p) => ({ case: p.case, expected: p.expected, got: p.got, confidence: round(p.confidence, 3) })),
    };
    if (target.question.type === "noul") {
      report.brier = round(
        points.reduce((sum, p) => sum + ((p.answer as { noul: number }).noul - (p.expected ? 1 : 0)) ** 2, 0) / n,
      );
    } else {
      if (target.question.type === "score") {
        report.meanError = round(
          points.reduce((sum, p) => sum + Math.abs((p.answer as { score: number }).score - Number(p.expected)), 0) / n,
        );
      }
      report.gates = GATES.map((min) => {
        const kept = points.filter((p) => p.confidence >= min);
        return {
          min,
          keeps: round(kept.length / n),
          accuracy: kept.length ? round(kept.filter((p) => p.right).length / kept.length) : null,
        };
      });
    }
    questions.push(report);
  }

  return {
    runner: spec.name,
    cases: cases.length,
    asked,
    cost: round(cost, 8),
    ...(stopped ? { stopped } : {}),
    questions,
  };
}
