// The shipped examples have to be right — they are the first thing anyone
// copies. Offline: this validates and serialises them, and runs one against a
// stub decider. Nothing here reaches the network.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isRunner, type Answer, type Decider, type Question, type Runner } from "../src/index.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const load = async (path: string): Promise<Runner> => {
  const module = (await import(join(repo, path))) as { default: unknown };
  assert.ok(isRunner(module.default), `${path} must default-export a runner()`);
  return module.default;
};

const triage = await load("examples/01-triage/triage.mts");
const picture = await load("examples/02-picture/picture.mts");
const refine = await load("examples/03-refine/refine.mts");

// ── 1 · every example validates ─────────────────────────────────────────────
for (const [name, example] of [
  ["01-triage", triage],
  ["02-picture", picture],
  ["03-refine", refine],
] as const) {
  assert.deepEqual(example.validate(), [], `${name} must be sound`);
}
console.log("ok · 1 all three examples validate clean");

// ── 2 · every example serialises to a complete graph ────────────────────────
for (const example of [triage, picture, refine]) {
  const graph = example.graph();
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), graph);
  assert.match(graph.runner.hash, /^sha256:/);
  assert.ok(graph.nodes.length >= 2);
  // every edge points at a node that exists
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.from) && ids.has(edge.to), `${edge.id} dangles`);
  }
}
console.log("ok · 2 each example emits a JSON graph with no dangling edges");

// ── 3 · 02 shows all three question types in ONE request ────────────────────
{
  const decide = picture.graph().nodes.find((n) => n.id === "classify")!.decide!;
  assert.deepEqual(decide.questions.map((q) => q.type).sort(), ["choice", "noul", "score"]);
  assert.equal(decide.questions.length, 3, "one round trip, three answers");
  assert.deepEqual(decide.gate, { on: "picture_kind", min: 0.75, to: "hand_off" });

  // and every declared option is wired — that is the property being demonstrated
  const options = decide.questions.find((q) => q.key === "picture_kind")!.options!.map((o) => o.name);
  const wired = picture
    .graph()
    .edges.map((e) => e.on)
    .filter((on): on is { question: string; option: string } => Boolean(on && "option" in on))
    .map((on) => on.option);
  assert.deepEqual([...options].sort(), [...wired].sort());
}
console.log("ok · 3 the picture example asks choice, noul and score together, all branches wired");

// ── 4 · 03 loops, and the loop budget is on the edge ────────────────────────
{
  const graph = refine.graph();
  const back = graph.edges.find((e) => e.from === "tally" && e.to === "draft")!;
  assert.equal(back.maxLoops, 3);
  const arithmetic = graph.edges.find((e) => e.when)!;
  assert.deepEqual([...arithmetic.when!.reads].sort(), ["blocker", "quality"]);
  assert.equal(graph.nodes.find((n) => n.id === "tally")!.cost, "free", "counting is free code, never a model");
}
console.log("ok · 4 the refine example loops on an edge budget and counts in code");

// ── 5 · 01 actually runs, against a stub ────────────────────────────────────
{
  const decider: Decider = async (_state, questions: Record<string, Question>) => {
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(questions)) {
      answers[key] = { type: "choice", choice: "billing", confidence: 0.93, probabilities: { billing: 0.93 } };
    }
    return { model: "stub", answers, usage: { input_tokens: 420, output_tokens: 20 }, cost: 0.00001764 };
  };

  const { result, run } = await triage({ goal: "I was charged twice for order A-104" }, { decider });
  assert.equal(result, "→ billing: I was charged twice for order A-104");
  assert.deepEqual(run.steps.map((s) => s.node), ["classify", "to_billing"]);
  assert.equal(run.steps[0]!.took, "e0");
  assert.equal(run.run.status, "completed");
}
console.log("ok · 5 the triage example runs end to end against a stub decider");

console.log("5 cases");
