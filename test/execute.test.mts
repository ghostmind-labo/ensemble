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

// ── 9 · a step that outlives stepTimeout fails the run, and its signal aborts
{
  let aborted = false;
  const hung = runner({
    name: "hung",
    work: {
      // Never resolves, like a handler waiting on a socket that went away.
      wait: ({ signal }) => {
        signal.addEventListener("abort", () => (aborted = true));
        return new Promise(() => {});
      },
    },
    nodes: { stuck: { work: "wait", writes: ["out"] } },
    entry: "stuck",
  });
  const started = Date.now();
  const failed = await hung({ goal: "x" }, { stepTimeout: 50 }).catch((e: unknown) => e);
  assert.ok(failed instanceof RunFailed, "a hung step fails the run instead of holding it forever");
  assert.match(failed.message, /did not finish within 50ms/);
  assert.equal(failed.run.run.status, "failed");
  assert.ok(aborted, "the handler's signal fired, so a well-behaved one can clean up");
  assert.ok(Date.now() - started < 2000);
}
console.log("ok · 9 stepTimeout fails a hung step and aborts its signal");

// ── 10 · fork runs lanes at once; the join waits for all and merges state ──
{
  const order: string[] = [];
  const slow = (label: string, ms: number, value: unknown) => async () => {
    order.push(`${label}:start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${label}:end`);
    return value;
  };
  const senses = runner({
    name: "senses",
    work: { eyes: slow("eyes", 40, "a red door"), ears: slow("ears", 10, "a knock") },
    nodes: {
      wake: { code: () => "up", writes: ["awake"] },
      look: { work: "eyes", writes: ["scene"] },
      listen: { work: "ears", writes: ["sound"] },
      count: { code: (s) => String(s["awake"]).length, writes: ["n"] },
      assess: {
        decide: { kind: kind() },
        reads: ["scene", "sound", "n"],
        join: "all",
      },
      done: { code: (s) => `${s["scene"]} / ${s["sound"]} / ${s["n"]} / ${s["kind"]}`, writes: ["out"] },
    },
    edges: [
      { from: "wake", to: "look", fork: true },
      { from: "wake", to: "listen", fork: true },
      { from: "wake", to: "count", fork: true },
      { from: "look", to: "assess" },
      { from: "listen", to: "assess" },
      { from: "count", to: "assess" },
      { from: "assess", to: "done" },
    ],
    entry: "wake",
    result: "out",
  });
  assert.deepEqual(senses.validate(), []);
  const decider = stub({ kind: chose("photo") });
  const { result, run } = await senses({ goal: "x" }, { decider });

  assert.equal(result, "a red door / a knock / 2 / photo", "every lane's writes met at the join");
  assert.deepEqual(order, ["eyes:start", "ears:start", "ears:end", "eyes:end"], "the lanes overlapped");
  assert.deepEqual(decider.seen[0]!.state, { scene: "a red door", sound: "a knock", n: 2 });

  const byNode = Object.fromEntries(run.steps.map((s) => [s.node, s]));
  assert.deepEqual(byNode["wake"]!.forked, ["e0", "e1", "e2"]);
  assert.equal(byNode["wake"]!.took, null, "a fork step takes no single edge");
  assert.equal(byNode["wake"]!.lane, "main");
  assert.deepEqual([byNode["look"]!.lane, byNode["listen"]!.lane, byNode["count"]!.lane], ["e0", "e1", "e2"]);
  assert.equal(byNode["assess"]!.lane, "assess", "the join runs on a lane named after itself");
  assert.equal(byNode["done"]!.lane, "assess");
  assert.equal(run.steps.filter((s) => s.node === "assess").length, 1, "the join ran once");
  assert.deepEqual(byNode["assess"]!.asked, { scene: "a red door", sound: "a knock", n: 2 }, "asked records what a node was given");
  assert.equal(byNode["done"]!.asked, undefined, "a node with no declared reads records none");
  assert.ok(byNode["look"]!.started < byNode["look"]!.ended || byNode["look"]!.ms >= 0, "steps carry timestamps");
  assert.ok(Date.parse(byNode["listen"]!.ended) <= Date.parse(byNode["assess"]!.started), "the join started after the last lane ended");
  assert.equal(run.run.status, "completed");
}
console.log("ok · 10 fork runs lanes concurrently, and the join waits for all of them");

// ── 11 · a lane that fails cancels its siblings; a conditional fork fires only what holds ──
{
  let siblingAborted = false;
  const flaky = runner({
    name: "flaky",
    work: {
      boom: async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("lens cracked");
      },
      wait: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => ((siblingAborted = true), resolve("late")), { once: true });
        }),
    },
    nodes: {
      go: { code: () => 1, writes: ["k"] },
      a: { work: "boom", writes: ["x"] },
      b: { work: "wait", writes: ["y"] },
      meet: { code: () => "never", writes: ["out"], join: "all" },
    },
    edges: [
      { from: "go", to: "a", fork: true },
      { from: "go", to: "b", fork: true },
      { from: "a", to: "meet" },
      { from: "b", to: "meet" },
    ],
    entry: "go",
  });
  const failed = await flaky({ goal: "x" }).catch((e: unknown) => e);
  assert.ok(failed instanceof RunFailed);
  assert.match(failed.message, /node "a" failed: lens cracked/);
  assert.ok(siblingAborted, "the other lane's signal fired");
  assert.equal(failed.run.run.status, "failed", "and the first reason to stop is the one recorded");
  assert.ok(!failed.run.steps.some((s) => s.node === "meet"), "the join never ran");

  const picky = runner({
    name: "picky",
    nodes: {
      ask: { decide: { kind: kind(), hard: noul("Hard?") }, reads: ["goal"] },
      p: { code: () => "p", writes: ["pp"] },
      h: { code: () => "h", writes: ["hh"] },
      d: { code: () => "d", writes: ["dd"] },
      end: { code: (s) => Object.keys(s).filter((k) => k.length === 2).sort().join(","), writes: ["out"], join: "all" },
    },
    edges: [
      { from: "ask", to: "p", on: "kind=photo", fork: true },
      { from: "ask", to: "d", on: "kind=diagram", fork: true },
      { from: "ask", to: "h", on: "hard", fork: true },
      { from: "p", to: "end" },
      { from: "d", to: "end" },
      { from: "h", to: "end" },
    ],
    entry: "ask",
    result: "out",
  });
  assert.deepEqual(picky.validate(), []);
  const { result, run } = await picky({ goal: "x" }, { decider: stub({ kind: chose("photo"), hard: { type: "noul", noul: 0.9 } }) });
  assert.equal(result, "hh,pp", "only the forks that held fired");
  assert.deepEqual(run.steps[0]!.forked, ["e0", "e2"]);
}
console.log("ok · 11 a failing lane cancels its siblings; forks with on:/when: fire only when they hold");

// ── 12 · a step that spent money and then failed still counts ──────────────
{
  const costly = runner({
    name: "costly",
    work: {
      spend: ({ report }) => {
        report({ cost: 0.4 });            // the call went out and was billed…
        throw new Error("…and then the response was unusable");
      },
    },
    nodes: { try_it: { work: "spend", writes: ["out"] } },
    entry: "try_it",
  });
  const failed = await costly({ goal: "x" }).catch((e: unknown) => e);
  assert.ok(failed instanceof RunFailed);
  assert.equal(failed.run.steps[0]!.cost, 0.4);
  assert.equal(failed.run.run.cost.total, 0.4, "a failed run is not a free run");
}
console.log("ok · 12 cost reported before a failure is counted in the run total");

console.log("12 cases");
