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
const studio = await load("examples/08-studio/studio.mts");
const frontdesk = await load("examples/09-frontdesk/frontdesk.mts");

// ── 1 · every example validates ─────────────────────────────────────────────
for (const [name, example] of [
  ["01-triage", triage],
  ["02-picture", picture],
  ["03-refine", refine],
  ["04-robot", robot],
  ["08-studio", studio],
  ["09-frontdesk", frontdesk],
] as const) {
  assert.deepEqual(example.validate(), [], `${name} must be sound`);
}
console.log("ok · 1 every example validates clean");

// ── 2 · every example serialises to a complete graph ────────────────────────
for (const example of [triage, picture, refine, robot, studio, frontdesk]) {
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

// ── 9 · 08 is the complex shape: four models in a row, a budgeted loop, both branch forms
{
  const graph = studio.graph();
  const models = graph.nodes.filter((n) => n.kind === "model");
  assert.equal(models.length, 4, "research → write → critique → illustrate");
  assert.equal(models.filter((n) => n.model?.from).length, 1, "one model id is chosen at run time");

  const back = graph.edges.find((e) => e.from === "tally" && e.to === "write")!;
  assert.equal(back.maxLoops, 2, "the loop budget lives on the edge");
  const after = graph.edges.filter((e) => e.from === "tally");
  assert.equal(after.at(-1)!.to, "hand_off", "and a following edge takes over once it is spent");

  // Safety is first BECAUSE edges are tried in declaration order.
  assert.deepEqual(graph.edges[0]!.on, { question: "risk", op: ">=", value: 0.6 });
  assert.equal(graph.edges[0]!.to, "hand_off");

  // `format` was answered at the brief, so branching on it later must be a when().
  const toIllustrate = graph.edges.find((e) => e.to === "illustrate")!;
  assert.equal(toIllustrate.on, undefined);
  assert.deepEqual(toIllustrate.when!.reads, ["format"]);

  // The loop actually loops, and ends: three writes, then a person.
  const seen: string[] = [];
  const decider: Decider = async (_state: unknown, questions: Record<string, Question>) => {
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(questions)) {
      answers[key] =
        key === "quality"
          ? { type: "score", score: 0.2, confidence: 0.9, probabilities: {}, legend: {} }   // always weak
          : key === "unsupported" || key === "risk"
            ? { type: "noul", noul: 0.1 }
            : { type: "choice", choice: key === "format" ? "memo" : "quick", confidence: 0.9, probabilities: {} };
    }
    return { model: "stub", answers, usage: { input_tokens: 1, output_tokens: 0 }, cost: 0.00002 };
  };
  const caller: Caller = async (req: ModelRequest): Promise<ModelReply> => (
    seen.push(req.model),
    { model: req.model, text: "draft", images: [], usage: { input_tokens: 1, output_tokens: 1 }, cost: 0.001 }
  );
  const { result, run } = await studio({ goal: "x", sources: "y" }, { decider, caller, maxSteps: 40 });
  assert.match(String(result), /a person will take this/, "two bad passes and it goes to a human");
  assert.equal(run.steps.filter((s) => s.node === "write").length, 3, "the first pass plus maxLoops: 2");
  assert.ok(!run.steps.some((s) => s.node === "illustrate"), "a memo gets no picture");
  assert.equal(run.run.status, "completed");
}
console.log("ok · 9 the studio example loops twice, then hands off; a memo skips the illustrator");

// ── 10 · 09 is every concept at once, and the graph says so ────────────────
{
  const graph = frontdesk.graph();
  const kinds = new Set(graph.nodes.map((n) => n.kind));
  assert.deepEqual([...kinds].sort(), ["code", "decide", "mcp", "model", "work"], "all five node kinds");

  // three lanes, one join
  assert.deepEqual(graph.edges.filter((e) => e.fork).map((e) => e.to), ["look", "pick_tool", "recall"]);
  assert.deepEqual(graph.nodes.filter((n) => n.join).map((n) => n.id), ["triage"]);

  // one call, three question types
  const triage = graph.nodes.find((n) => n.id === "triage")!;
  assert.deepEqual(triage.decide!.questions.map((q) => q.type), ["choice", "noul", "score"]);
  assert.deepEqual(triage.decide!.gate, { on: "area", min: 0.65, to: "hand_off" });
  assert.ok(!triage.reads.includes("screenshot"), "the decider never sees the image");

  // memory, both keys, each with a writer
  assert.deepEqual(graph.runner.memory, ["seen", "last_area"]);
  const byKey = Object.fromEntries(graph.data.map((d) => [d.key, d]));
  assert.deepEqual(byKey["seen"]!.producedBy, ["$memory", "recall"]);
  assert.deepEqual(byKey["last_area"]!.producedBy, ["$memory", "remember"]);

  // safety is first, and the loop has a budget with a following edge
  assert.deepEqual(graph.edges[7]!.on, { question: "hazard", op: ">=", value: 0.6 });
  assert.equal(graph.edges.find((e) => e.from === "tally" && e.to === "answer")!.maxLoops, 2);
  assert.equal(graph.edges.filter((e) => e.from === "tally").at(-1)!.to, "hand_off");

  // a person in the loop, and a fallback for when the decider is down
  const approve = graph.nodes.find((n) => n.id === "approve")!;
  assert.equal(approve.decide!.by, "human");
  assert.equal(approve.decide!.comment, "reviewer_note");
  assert.equal(triage.decide!.fallback, "hand_off");

  // it runs: a hazard pages someone before anything is generated
  let called = 0;
  const caller: Caller = async (req: ModelRequest): Promise<ModelReply> => (
    called++, { model: req.model, text: "x", images: [], usage: { input_tokens: 1, output_tokens: 1 }, cost: 0 }
  );
  const decider: Decider = async (_s: unknown, questions: Record<string, Question>) => {
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(questions)) {
      answers[key] =
        key === "area"
          ? { type: "choice", choice: "bug", confidence: 0.9, probabilities: {} }
          : key === "urgency" || key === "quality"
            ? { type: "score", score: 0, confidence: 0.9, probabilities: {}, legend: {} }
            : { type: "noul", noul: key === "hazard" ? 0.9 : 0.1 };
    }
    return { model: "stub", answers, usage: { input_tokens: 1, output_tokens: 0 }, cost: 0 };
  };
  const { result, run } = await frontdesk(
    { goal: "the modal is blank", screenshot: "https://x/s.png", log_path: "README.md", seen: 3 },
    { decider, caller },
  );
  assert.match(String(result), /^PAGED:/, "a hazard outranks the routing");
  assert.equal(called, 1, "only the vision lane called a model; nothing was generated");
  // A lane keeps the id of the forking edge that started it: read_log is the
  // second node of lane e1, not a lane of its own.
  assert.deepEqual(run.steps.map((s) => s.lane), ["main", "e0", "e1", "e2", "e1", "triage", "triage"]);
  assert.equal(run.state["seen"], 4, "memory advanced in its own lane");
}
// and without a person to ask, an urgent reply pauses at approval — then resumes
{
  const good: Decider = async (_s: unknown, questions: Record<string, Question>) => {
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(questions)) {
      answers[key] =
        key === "area"
          ? { type: "choice", choice: "bug", confidence: 0.9, probabilities: {} }
          : key === "urgency"
            ? { type: "score", score: 1.2, confidence: 0.9, probabilities: {}, legend: {} }
            : key === "quality"
              ? { type: "score", score: 2, confidence: 0.9, probabilities: {}, legend: {} }
              : { type: "noul", noul: key === "hazard" ? 0.1 : 0.9 };
    }
    return { model: "stub", answers, usage: { input_tokens: 1, output_tokens: 0 }, cost: 0 };
  };
  const quiet: Caller = async (req: ModelRequest): Promise<ModelReply> => ({
    model: req.model, text: "a reply", images: [], usage: { input_tokens: 1, output_tokens: 1 }, cost: 0,
  });
  // the MCP lane is stubbed out so the test never spawns a server
  (frontdesk.spec.nodes["read_log"] as unknown) = { code: () => ({ log_text: "log", log_data: {} }), reads: ["log_path"], writes: ["log_text", "log_data"] };
  const first = await frontdesk({ goal: "blank modal", screenshot: "https://x/s.png", log_path: "README.md" }, { decider: good, caller: quiet });
  assert.equal(first.run.run.status, "paused");
  assert.equal(first.run.pending!.node, "approve");
  const done = await frontdesk.resume(JSON.parse(JSON.stringify(first.paused)), { answers: { send_it: true }, by: "lead" }, { decider: good, caller: quiet });
  assert.match(String(done.result), /^sent:/);
  assert.deepEqual(done.run.steps.slice(-2).map((s) => s.node), ["approve", "send"]);
}
console.log("ok · 10 the frontdesk example carries every concept, and safety outranks the routing");

console.log("10 cases");
