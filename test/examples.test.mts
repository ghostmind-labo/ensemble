// The shipped examples have to be right — they are the first thing anyone
// copies. Offline: this validates and serialises them, and runs one against a
// stub decider. Nothing here reaches the network.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isRunner,
  type Answer,
  type Caller,
  type Decider,
  type ModelReply,
  type ModelRequest,
  type Question,
  type Runner,
} from "../src/index.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const load = async (path: string): Promise<Runner> => {
  const module = (await import(join(repo, path))) as { default: unknown };
  assert.ok(isRunner(module.default), `${path} must default-export a runner()`);
  return module.default;
};

const triage = await load("examples/01-triage/triage.mts");
const picture = await load("examples/02-picture/picture.mts");
const refine = await load("examples/03-refine/refine.mts");
const robot = await load("examples/04-robot/brain.mts");

// ── 1 · every example validates ─────────────────────────────────────────────
for (const [name, example] of [
  ["01-triage", triage],
  ["02-picture", picture],
  ["03-refine", refine],
  ["04-robot", robot],
] as const) {
  assert.deepEqual(example.validate(), [], `${name} must be sound`);
}
console.log("ok · 1 all four examples validate clean");

// ── 2 · every example serialises to a complete graph ────────────────────────
for (const example of [triage, picture, refine, robot]) {
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

// ── 3 · 02 keeps the graph complete while choosing a model at run time ──────
{
  const graph = picture.graph();
  const decide = graph.nodes.find((n) => n.id === "classify")!.decide!;
  assert.deepEqual(decide.questions.map((q) => q.type).sort(), ["choice", "choice", "noul", "score"]);

  // The durable question is enumerated; the volatile one is resolved in code.
  const fidelity = decide.questions.find((q) => q.key === "fidelity")!;
  assert.deepEqual(fidelity.options!.map((o) => o.name), ["draft", "final"]);
  assert.equal(graph.nodes.find((n) => n.id === "choose_generator")!.kind, "code");
  assert.equal(graph.nodes.find((n) => n.id === "draw")!.model!.from, "generator");
  assert.equal(graph.nodes.find((n) => n.id === "draw")!.model!.id, undefined);
}
console.log("ok · 3 the picture example asks the durable question and resolves the model in code");

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

// ── 6 · 03 and 04 actually RUN — validation cannot catch a bad write shape ──
{
  const answering = (table: Record<string, Answer>): Decider =>
    async (_state, questions: Record<string, Question>) => {
      const answers: Record<string, Answer> = {};
      for (const key of Object.keys(questions)) answers[key] = table[key]!;
      return { model: "stub", answers, usage: { input_tokens: 200, output_tokens: 10 }, cost: 0.0000084 };
    };
  const speaking = (text: string): Caller =>
    async (request: ModelRequest): Promise<ModelReply> => ({
      model: request.model,
      text,
      images: [],
      cost: 0.001,
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });

  // refine: one weak round, then good enough. The counter must reach 1, not
  // { rounds: 1 } — a single write key takes the return value WHOLE.
  let round = 0;
  const judging: Decider = async (_state, questions) => {
    round++;
    const quality = round === 1 ? 0.4 : 2.0;
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(questions)) {
      answers[key] =
        key === "quality"
          ? { type: "score", score: quality, confidence: 0.8, probabilities: {}, legend: {} }
          : { type: "noul", noul: 0.05 };
    }
    return { model: "stub", answers, usage: { input_tokens: 200, output_tokens: 10 }, cost: 0.0000084 };
  };
  const drafted = await refine({ goal: "explain calibration" }, { decider: judging, caller: speaking("a draft") });
  assert.equal(drafted.state["rounds"], 1, "the counter is a number, not a nested object");
  assert.match(String(drafted.result), /^published:/);
  assert.equal(drafted.run.run.status, "completed");

  // robot: eyes, then a confident decision to advance
  const seen = await robot(
    { goal: "keep the corridor clear", frame: "data:image/png;base64,AA" },
    {
      caller: speaking("a clear corridor, nothing in the way"),
      decider: answering({
        action: { type: "choice", choice: "advance", confidence: 0.94, probabilities: { advance: 0.94 } },
        hazard: { type: "noul", noul: 0.02 },
        urgency: { type: "score", score: 0.2, confidence: 0.9, probabilities: {}, legend: {} },
      }),
    },
  );
  assert.deepEqual(seen.run.steps.map((s) => s.node), ["look", "assess", "go"]);
  assert.deepEqual(seen.run.steps.map((s) => s.kind), ["model", "decide", "work"]);
  assert.match(String(seen.result), /^advancing/);
  assert.equal(seen.state["scene"], "a clear corridor, nothing in the way");
}
console.log("ok · 6 the refine and robot examples run end to end, write shapes included");

// ── 7 · 06's watcher: numbers stop it before Jev is asked; meaning flags it ──
{
  const watcher = await load("examples/06-watch/watch.mts");
  assert.deepEqual(watcher.validate(), []);
  let asked = 0;
  const decider: Decider = async (_state: unknown, questions: Record<string, Question>) => {
    asked++;
    const answers: Record<string, Answer> = {};
    const table: Record<string, number> = { progress: 0.9, looping: 0.1, review: 0.1 };
    for (const key of Object.keys(questions)) answers[key] = { type: "noul", noul: table[key]! };
    return { model: "stub", answers, usage: { input_tokens: 1, output_tokens: 0 }, cost: 0 };
  };
  const vitals = (over: Record<string, number>) => ({ ticks: 12, failureRate: 0, gateRate: 0, sameness: 0.3, ...over });
  const verdict = async (v: Record<string, number>) =>
    (await watcher({ goal: "triage", vitals: vitals(v), recent: "tick 1 · completed · classify → to_billing" }, { decider })).result;

  assert.equal(await verdict({}), "continue", "healthy numbers, and Jev sees progress");
  assert.equal(asked, 1);
  assert.equal(await verdict({ failureRate: 0.6 }), "stop", "half the ticks failing stops it");
  assert.equal(await verdict({ gateRate: 0.5 }), "alert", "unsure too often");
  assert.equal(await verdict({ sameness: 1 }), "alert", "the same path, tick after tick");
  assert.equal(asked, 1, "none of those three needed Jev: arithmetic is decided in code");
}
console.log("ok · 7 the watch example stops on numbers in code and asks Jev only about meaning");

// ── 8 · 07 forks three senses, joins once, and remembers across ticks ──────
{
  const senses = await load("examples/07-senses/senses.mts");
  assert.deepEqual(senses.validate(), []);
  const graph = senses.graph();
  assert.deepEqual(graph.edges.filter((e) => e.fork).map((e) => e.id), ["e0", "e1", "e2"]);
  assert.equal(graph.nodes.find((n) => n.id === "assess")!.join, "all");
  assert.deepEqual(graph.runner.memory, ["seen"]);

  const caller: Caller = async (req: ModelRequest): Promise<ModelReply> => ({
    model: req.model, text: "a person at the door", images: [], usage: { input_tokens: 1, output_tokens: 1 }, cost: 0.0001,
  });
  const decider: Decider = async (state: unknown, questions: Record<string, Question>) => {
    assert.deepEqual(Object.keys(state as object).sort(), ["goal", "heard", "scene"], "Jev sees the senses' words, not the frame");
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(questions)) {
      answers[key] = key === "action"
        ? { type: "choice", choice: "approach", confidence: 0.9, probabilities: { approach: 0.9 } }
        : { type: "noul", noul: 0.8 };
    }
    return { model: "stub", answers, usage: { input_tokens: 1, output_tokens: 0 }, cost: 0.00002 };
  };
  const { result, state, run } = await senses({ goal: "watch the door", frame: "https://x/f.jpg", sensors: "motion", seen: 4 }, { caller, decider });
  assert.match(String(result), /acting on "approach"/);
  assert.equal(state["seen"], 5, "the memory key was advanced by the recall lane");
  assert.equal(run.steps.filter((s) => s.node === "assess").length, 1);
  assert.deepEqual(run.steps.map((s) => s.lane), ["main", "e0", "e1", "e2", "assess", "assess"]);
}
console.log("ok · 8 the senses example forks, joins once, and advances its memory key");

console.log("8 cases");
