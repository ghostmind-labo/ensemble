// The cursor and the record it leaves. Every decider here is a stub, so the
// suite is offline and free — which is also the point of the `decider` seam.
import assert from "node:assert/strict";
import {
  choice,
  noul,
  RunFailed,
  RunnerError,
  runner,
  score,
  type Answer,
  type Decider,
  type Question,
  type RunEvent,
} from "../src/index.ts";

/** A decider that answers from a table, and remembers what it was asked. */
function stub(table: Record<string, Answer>): Decider & { seen: Array<{ state: unknown; keys: string[] }> } {
  const seen: Array<{ state: unknown; keys: string[] }> = [];
  const decide = async (state: unknown, questions: Record<string, Question>) => {
    seen.push({ state, keys: Object.keys(questions) });
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(questions)) answers[key] = table[key]!;
    return { model: "stub", answers, usage: { input_tokens: 100, output_tokens: 10 }, cost: 0.0000042 };
  };
  return Object.assign(decide, { seen });
}

const chose = (option: string, confidence = 0.95): Answer => ({
  type: "choice",
  choice: option,
  confidence,
  probabilities: { [option]: confidence },
});

const kind = () => choice("What kind?", { photo: null, diagram: null });

const base = () =>
  runner({
    name: "t",
    work: { p: () => "a photo", d: () => "a diagram", h: () => "a human" },
    nodes: {
      pick: { decide: { kind: kind() }, reads: ["goal"], gate: { on: "kind", min: 0.7, to: "fallback" } },
      photo: { work: "p", writes: ["out"] },
      diagram: { work: "d", writes: ["out"] },
      fallback: { work: "h", writes: ["out"] },
    },
    edges: [
      { from: "pick", to: "photo", on: "kind=photo" },
      { from: "pick", to: "diagram", on: "kind=diagram" },
    ],
    entry: "pick",
    result: "out",
  });

// ── 1 · routing, and a record that joins back to the graph ──────────────────
{
  const decider = stub({ kind: chose("diagram") });
  const { result, run } = await base()({ goal: "draw me a flowchart" }, { decider });

  assert.equal(result, "a diagram");
  assert.deepEqual(
    run.steps.map((s) => s.node),
    ["pick", "diagram"],
  );
  assert.equal(run.run.status, "completed");
  assert.equal(run.version, 1);
  assert.match(run.$schema, /run-v1\.json$/);

  // took is an edge id from graph.json — that one field is the whole join.
  assert.equal(run.steps[0]!.took, "e1", "the diagram branch is the second edge");
  assert.equal(run.steps[1]!.took, null, "null means it reached the exit");
  assert.equal(run.run.graph, base().graph().runner.hash, "the record cites the graph it walked");

  // the full distribution survives, not just the winner
  assert.equal(run.steps[0]!.answers!["kind"]!.value, "diagram");
  assert.equal(run.steps[0]!.answers!["kind"]!.confidence, 0.95);
  assert.ok(run.steps[0]!.answers!["kind"]!.probabilities);
  assert.equal(run.steps[0]!.gate!.passed, true);
  assert.ok(run.run.cost.total > 0);
}
console.log("ok · 1 an option branch routes, and the record joins back by edge id");

// ── 2 · the confidence gate overrides every edge ────────────────────────────
{
  const decider = stub({ kind: chose("photo", 0.4) });
  const { result, run } = await base()({ goal: "unclear" }, { decider });

  assert.equal(result, "a human");
  assert.deepEqual(run.steps.map((s) => s.node), ["pick", "fallback"]);
  assert.equal(run.steps[0]!.took, "gate", "a gated step records the gate, not an edge");
  assert.deepEqual(run.steps[0]!.gate, { on: "kind", passed: false, min: 0.7, measured: 0.4 });
}
console.log("ok · 2 below the gate the run diverts, whatever the edges say");

// ── 3 · a decide node sends ONLY what it declared ───────────────────────────
{
  const decider = stub({ kind: chose("photo") });
  await base()({ goal: "a hero image", secret: "must not leave", noise: 1 }, { decider });
  assert.deepEqual(decider.seen[0]!.state, { goal: "a hero image" });
  assert.deepEqual(decider.seen[0]!.keys, ["kind"]);
}
console.log("ok · 3 reads is a hard filter on what reaches the decider");

// ── 4 · writes: one key takes the value, several destructure it ─────────────
{
  const one = runner({
    name: "w",
    work: { single: () => "value", many: () => ({ a: 1, b: 2, extra: 3 }), bad: () => 7 },
    nodes: {
      s: { work: "single", writes: ["x"] },
      m: { work: "many", writes: ["a", "b"] },
      effect: { work: "single" },
    },
    edges: [
      { from: "s", to: "m" },
      { from: "m", to: "effect" },
    ],
    entry: "s",
  });
  const { state } = await one();
  assert.equal(state["x"], "value");
  assert.equal(state["a"], 1);
  assert.equal(state["b"], 2);
  assert.equal(state["extra"], undefined, "only declared keys are written");

  const broken = runner({
    name: "w2",
    work: { bad: () => 7 },
    nodes: { s: { work: "bad", writes: ["a", "b"] } },
    entry: "s",
  });
  await assert.rejects(() => broken(), (error: Error) => {
    assert.ok(error instanceof RunFailed);
    assert.match(error.message, /must return an object with them/);
    assert.equal(error.run.steps[0]!.error !== undefined, true, "the partial record is attached");
    return true;
  });
}
console.log("ok · 4 one key takes the value whole, several destructure, a mismatch fails loudly");

// ── 5 · a loop budget is spent on the edge, then the next edge takes over ───
{
  const rounds: number[] = [];
  const loop = runner({
    name: "loop",
    work: { step: ({ state }) => Number(state["n"] ?? 0) + 1, done: () => "done" },
    nodes: {
      tick: { work: "step", reads: ["n"], writes: ["n"] },
      end: { work: "done", writes: ["out"] },
    },
    edges: [
      { from: "tick", to: "tick", maxLoops: 3 },
      { from: "tick", to: "end" },
    ],
    entry: "tick",
    result: "out",
  });
  const { run, state } = await loop({}, { onEvent: (e) => e.type === "node:end" && rounds.push(e.step.n) });
  assert.equal(state["n"], 4, "ran once, then looped three more times");
  assert.deepEqual(run.steps.map((s) => s.node), ["tick", "tick", "tick", "tick", "end"]);
  assert.equal(run.steps[3]!.took, "e1", "with the loop spent, the next edge matches");
  assert.deepEqual(rounds, [1, 2, 3, 4, 5]);
}
console.log("ok · 5 maxLoops is spent per edge, then the next edge wins");

// ── 6 · the caps: budget and maxSteps stop a run without failing it ─────────
{
  const costly = runner({
    name: "spend",
    work: { burn: ({ report }) => report({ cost: 1 }) },
    nodes: { a: { work: "burn" } },
    edges: [{ from: "a", to: "a" }],
    entry: "a",
  });
  const { run } = await costly({}, { budget: 2.5 });
  assert.equal(run.run.status, "budget");
  assert.equal(run.steps.length, 3, "it stops on the step that crossed the line");
  assert.equal(run.run.cost.total, 3);

  const capped = await costly({}, { maxSteps: 4 });
  assert.equal(capped.run.run.status, "maxSteps");
  assert.equal(capped.run.steps.length, 4);
}
console.log("ok · 6 budget and maxSteps end a run cleanly, and say which one did");

// ── 7 · a broken runner is refused before anything is spent ─────────────────
{
  const unwired = runner({
    name: "bad",
    work: { p: () => 1 },
    nodes: { pick: { decide: { kind: kind() }, reads: ["goal"] }, photo: { work: "p", writes: ["out"] } },
    edges: [{ from: "pick", to: "photo", on: "kind=photo" }],
    entry: "pick",
  });
  await assert.rejects(() => unwired({}, { decider: stub({ kind: chose("photo") }) }), (error: Error) => {
    assert.ok(error instanceof RunnerError);
    assert.ok(error.problems.some((p) => /nothing handles "diagram"/.test(p)));
    return true;
  });
  assert.equal(unwired.validate().length > 0, true, "but it stays inspectable");
  assert.equal(unwired.graph().nodes.length, 2, "and it still emits a graph");
}
console.log("ok · 7 execute refuses an unsound runner; graph() and validate() still work");

// ── 8 · events arrive in order, and a score reaches a when() as a number ────
{
  const seen: RunEvent[] = [];
  const judged = runner({
    name: "judge",
    work: { ship: () => "shipped", redo: () => "again" },
    nodes: {
      review: { decide: { quality: score("Good?", ["bad", "ok", "good"]), blocker: noul("Wrong?") }, reads: ["goal"] },
      good: { work: "ship", writes: ["out"] },
      bad: { work: "redo", writes: ["out"] },
    },
    edges: [
      { from: "review", to: "bad", when: (s) => Number(s["quality"]) < 1.5 },
      { from: "review", to: "good" },
    ],
    entry: "review",
    result: "out",
  });

  const decider = stub({
    quality: { type: "score", score: 1.3, confidence: 0.54, probabilities: { "1": 0.7, "2": 0.3 }, legend: { "1": "ok" } },
    blocker: { type: "noul", noul: 0.1 },
  });
  const { result, run } = await judged({ goal: "x" }, { decider, onEvent: (e) => seen.push(e) });

  assert.equal(result, "again", "1.3 < 1.5, so the when() sent it back");
  assert.deepEqual(seen.map((e) => e.type), [
    "node:start",
    "node:end",
    "node:start",
    "node:end",
    "run:end",
  ]);
  assert.match((seen[0] as { waiting: string }).waiting, /2 questions/);
  assert.equal(run.steps[0]!.answers!["quality"]!.value, 1.3);
  assert.ok(run.steps[0]!.answers!["quality"]!.legend, "a score keeps its legend in the record");
  assert.equal(run.steps[0]!.answers!["blocker"]!.confidence, undefined, "a noul has none");
}
console.log("ok · 8 events fire in order; a score lands as a number a when() can compare");

console.log("8 cases");
