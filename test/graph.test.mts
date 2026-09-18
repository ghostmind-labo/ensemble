// graph.json — the emitted structure. These assertions ARE the schema contract:
// whoever renders the document depends on exactly these shapes, so a change
// here is a change to somebody else's code.
import assert from "node:assert/strict";
import { choice, noul, runner, score, toGraph, type GraphDoc } from "../src/index.ts";

const build = () =>
  runner({
    name: "shape",
    description: "every field, once",
    inputs: ["brand_kit"],
    work: { p: () => 1, h: () => 2 },
    nodes: {
      pick: {
        label: "What kind?",
        decide: {
          kind: choice("What kind?", { photo: "A photo", diagram: { what: "A figure", not_for: "A photo" } }),
          needs_text: noul("Words inside?", { true: "yes", false: "no" }),
          hard: score("How hard?", ["easy", { what: "tricky", signals: ["many parts"] }]),
        },
        reads: ["goal", "brand_kit"],
        gate: { on: "kind", min: 0.75, to: "human" },
      },
      photo: { work: "p", reads: ["goal"], writes: ["image"] },
      figure: { code: (s) => ({ image: `svg:${String(s["goal"])}` }), writes: ["image"] },
      human: { work: "h", writes: ["image"] },
    },
    edges: [
      { from: "pick", to: "human", when: (s) => Number(s["hard"]) >= 0.9 },
      { from: "pick", to: "photo", on: "kind=photo" },
      { from: "pick", to: "figure", on: "kind=diagram" },
      { from: "photo", to: "pick", on: "needs_text>=0.7", maxLoops: 2 },
    ],
    entry: "pick",
    result: "image",
  });

const graph: GraphDoc = build().graph();

// ── 1 · the envelope ────────────────────────────────────────────────────────
assert.match(graph.$schema, /graph-v1\.json$/);
assert.equal(graph.version, 1);
assert.equal(graph.runner.name, "shape");
assert.equal(graph.runner.entry, "pick");
assert.equal(graph.runner.result, "image");
assert.deepEqual(graph.runner.inputs, ["goal", "brand_kit"], "goal is always an input");
assert.match(graph.runner.hash, /^sha256:[0-9a-f]{16}$/);
console.log("ok · 1 the envelope carries name, entry, inputs, result and a hash");

// ── 2 · the hash tracks structure, and nothing else ─────────────────────────
{
  assert.equal(build().graph().runner.hash, graph.runner.hash, "same structure, same hash");
  const renamed = build();
  renamed.spec.nodes["photo"] = { work: "p", reads: ["goal"], writes: ["picture"] };
  assert.notEqual(toGraph(renamed.spec).runner.hash, graph.runner.hash, "a changed write changes it");
}
console.log("ok · 2 the hash is stable across runs and moves with the structure");

// ── 3 · nodes: flat, with id / kind / cost before the bulk ──────────────────
{
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  assert.deepEqual(Object.keys(byId["pick"]!).slice(0, 5), ["id", "kind", "label", "cost", "reads"]);
  assert.equal(byId["pick"]!.cost, "cheap");
  assert.equal(byId["photo"]!.cost, "metered");
  assert.equal(byId["figure"]!.cost, "free");
  assert.deepEqual(byId["photo"]!.work, { handler: "p" });
  assert.equal(byId["figure"]!.work, undefined);
  assert.deepEqual(byId["pick"]!.writes, ["kind", "needs_text", "hard"], "a decide node writes one key per question");
}
console.log("ok · 3 each node states kind and cost class before its detail");

// ── 4 · questions are emitted whole, with descriptions normalised to objects ─
{
  const decide = graph.nodes.find((n) => n.id === "pick")!.decide!;
  assert.equal(decide.model, "jev-latest");
  assert.deepEqual(decide.gate, { on: "kind", min: 0.75, to: "human" });

  const [kind, needsText, hard] = decide.questions;
  assert.equal(kind!.type, "choice");
  assert.deepEqual(kind!.options, [
    { name: "photo", description: { what: "A photo" } },
    { name: "diagram", description: { what: "A figure", not_for: "A photo" } },
  ]);
  assert.equal(needsText!.type, "noul");
  assert.deepEqual(needsText!.criteria, { true: { what: "yes" }, false: { what: "no" } });
  assert.equal(hard!.type, "score");
  assert.deepEqual(hard!.levels, [
    { value: 0, description: { what: "easy" } },
    { value: 1, description: { what: "tricky", signals: ["many parts"] } },
  ]);
  assert.equal(kind!.levels, undefined, "a choice has no levels");
  assert.equal(hard!.options, undefined, "a score has no options");
}
console.log("ok · 4 a bare string description is normalised to { what }, so readers see one shape");

// ── 5 · edges: every branch labelled, and code branches told the truth about ─
{
  assert.deepEqual(graph.edges.map((e) => e.id), ["e0", "e1", "e2", "e3"]);
  assert.deepEqual(graph.edges[1]!.on, { question: "kind", option: "photo" });
  assert.deepEqual(graph.edges[3]!.on, { question: "needs_text", op: ">=", value: 0.7 });
  assert.equal(graph.edges[3]!.maxLoops, 2);

  // a when() is not enumerable, so it ships its own source and reads instead
  assert.equal(graph.edges[0]!.on, undefined);
  assert.match(graph.edges[0]!.when!.source, /Number\(s\["hard"\]\) >= 0\.9/);
  assert.deepEqual(graph.edges[0]!.when!.reads, ["hard"]);
}
console.log("ok · 5 on: branches are labelled; when: branches carry source and reads");

// ── 6 · the data graph ──────────────────────────────────────────────────────
{
  const byKey = Object.fromEntries(graph.data.map((d) => [d.key, d]));
  assert.deepEqual(byKey["goal"]!.producedBy, ["$input"]);
  assert.deepEqual(byKey["brand_kit"]!.producedBy, ["$input"]);
  assert.deepEqual(byKey["kind"]!.producedBy, ["pick"]);
  assert.deepEqual(byKey["image"]!.producedBy, ["photo", "figure", "human"]);
  assert.deepEqual(byKey["kind"]!.readBy, ["e1", "e2"], "edges are readers too, by id");
  assert.deepEqual(byKey["hard"]!.readBy, ["e0"]);
}
console.log("ok · 6 the data graph names every writer and reader, edges included");

// ── 7 · it is JSON, all the way down ────────────────────────────────────────
assert.deepEqual(JSON.parse(JSON.stringify(graph)), graph, "no functions, dates or undefined leak in");
console.log("ok · 7 the document round-trips through JSON unchanged");

console.log("7 cases");
