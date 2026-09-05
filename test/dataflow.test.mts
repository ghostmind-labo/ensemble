// The data graph: what depends on what, derived from declarations and PROVED.
//
// State keys have two origins — `goal`, and a node's declared outputs — so an
// input nothing produces can never be satisfied. Before this, such a node ran
// anyway with the model simply not told. No model is called.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSpec, SceneError, loadScene } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { probeReads } from "../src/dataflow.ts";
import { toLayout } from "../src/view.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const registry = loadRegistry();
const problemsOf = (spec: unknown): string[] => {
  try { validateSpec(spec, "x.mts", registry); return []; }
  catch (e) { return e instanceof SceneError ? e.problems : [String(e)]; }
};
const M = { model: "openrouter/test/model" };

// -- 1 . an input nothing produces is a validation ERROR, not a silent gap ---
const dangling = problemsOf({
  name: "t", defaults: M, entry: "a", exit: "b",
  nodes: {
    a: { outputs: ["draft"] },
    b: { inputs: ["draft", "scoer"], outputs: ["final"] },   // typo for "score"
  },
  edges: [{ from: "a", to: "b" }],
});
assert.equal(dangling.length, 1, dangling.join("\n"));
assert.match(dangling[0]!, /node "b" reads "scoer" but nothing in the scene produces it/);
assert.match(dangling[0]!, /"draft" \(by a\)/, "the message lists what IS produced, so the typo is obvious");
console.log("ok - 1 a never-produced input fails validation and names the fix");

// -- 2 . goal is always present; ask answers and fn outputs count as producers
assert.deepEqual(problemsOf({
  name: "t", defaults: M, entry: "ask", exit: "c",
  nodes: {
    ask: { runtime: "ask", question: "?", outputs: ["answer"] },
    calc: { runtime: "fn", fn: () => ({ n: 1 }), outputs: ["n"] },
    c: { inputs: ["goal", "answer", "n"], outputs: ["x"] },
  },
  edges: [{ from: "ask", to: "calc" }, { from: "calc", to: "c" }],
}), [], "goal, an ask's answer and an fn's output all satisfy an input");
console.log("ok - 2 goal, ask answers and fn outputs are producers");

// -- 3 . a loop counter that reads itself is legitimate, not an error ---------
assert.deepEqual(problemsOf({
  name: "t", defaults: M, entry: "tick", exit: "tick",
  nodes: { tick: { runtime: "fn", fn: (s: { n?: number }) => ({ n: (s.n ?? 0) + 1 }), inputs: ["n"], outputs: ["n"] } },
  edges: [{ from: "tick", to: "tick", maxLoops: 3 }],
}), [], "self-production is the counter idiom — when it is first read is a runtime matter");
console.log("ok - 3 a self-fed loop counter is allowed");

// -- 4 . a when() that reads a never-produced key is caught too --------------
const badWhen = problemsOf({
  name: "t", defaults: M, entry: "a", exit: "b",
  nodes: { a: { outputs: ["score"] }, b: { outputs: ["x"] } },
  edges: [{ from: "a", to: "b", when: (s: { scroe?: number }) => (s.scroe ?? 0) < 8 }],
});
assert.equal(badWhen.length, 1, badWhen.join("\n"));
assert.match(badWhen[0]!, /edge a→b reads "scroe" in its when\(\) but nothing in the scene produces it/);
console.log("ok - 4 a condition reading a phantom key fails validation");

// -- 5 . probeReads sees every access style, and survives a throw ------------
assert.deepEqual(probeReads((s) => Number(s["score"]) < 8 || !s["done"]).sort(), ["done", "score"]);
assert.deepEqual(probeReads(({ verdict }) => verdict === "ship"), ["verdict"], "destructuring is a read");
assert.deepEqual(probeReads((s) => "ok" in s), ["ok"], "`in` is a read");
assert.deepEqual(probeReads((s) => (s["a"] as { b: number }).b > 1), ["a"], "a throw after the first read still reports it");

// The honest limit: a probe runs the predicate once with every key undefined,
// so a read on the far side of a short-circuit whose near side is falsy is
// not seen. `NaN < 8` is false, so `&& !s.done` never executes. This makes
// the check err toward FEWER errors, never false ones — a phantom key behind
// a short-circuit is missed, a real key is never flagged.
assert.deepEqual(probeReads((s) => Number(s["score"]) < 8 && !s["done"]), ["score"],
  "documented limitation: reads behind a falsy short-circuit are invisible to the probe");
console.log("ok - 5 probeReads captures dotted, destructured and `in` reads (short-circuit limit is known)");

// -- 6 . the layout carries the data graph, including edges into conditions --
const work = mkdtempSync(join(tmpdir(), "ensemble-flow-"));
writeFileSync(join(work, "s.mts"), `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "flow",
  defaults: { model: "openrouter/test/model" },
  state: { draft: z.string(), score: z.number() },
  nodes: {
    write: { outputs: ["draft"] },
    judge: { inputs: ["draft"], outputs: ["score"] },
    ship:  { inputs: ["draft", "score"], outputs: ["done"] },
  },
  edges: [
    { from: "write", to: "judge" },
    { from: "judge", to: "write", when: (s) => s.score < 8, maxLoops: 2 },
    { from: "judge", to: "ship" },
  ],
  entry: "write", exit: "ship",
});
`, "utf8");
process.chdir(work);
const layout = toLayout(await loadScene(join(work, "s.mts"), loadRegistry()));

const flows = layout.data.map((d) => `${d.key}:${d.from}->${d.to}`).sort();
assert.deepEqual(flows, [
  "draft:write->judge",
  "draft:write->ship",
  "score:judge->edge:1",     // the CONDITION is a consumer in the data graph
  "score:judge->ship",
]);
assert.deepEqual(layout.edges[1]?.reads, ["score"], "the when-box knows what it reads");
console.log("ok - 6 the layout carries producer->consumer AND producer->condition edges");

// -- 7 . a key from OUTSIDE the workflow is declared, not smuggled ---------
// Real case: a trivia judge read `house_rules` — amendments a human injects
// mid-game through `answers`. No node produces it, on purpose. Without a
// declaration the proof flags it; with one it is an origin, and the viewer
// draws it as an input box feeding the judge.
const undeclared = problemsOf({
  name: "t", defaults: M, entry: "j", exit: "j",
  nodes: { j: { inputs: ["house_rules"], outputs: ["verdict"] } },
});
assert.match(undeclared.join(";"), /reads "house_rules" but nothing in the scene produces it/);
assert.match(undeclared.join(";"), /declare it: inputs: \["…"\] at the scene level/, "the fix is in the message");

assert.deepEqual(problemsOf({
  name: "t", defaults: M, entry: "j", exit: "j",
  inputs: ["house_rules"],
  nodes: { j: { inputs: ["house_rules"], outputs: ["verdict"] } },
}), [], "a declared external input has an origin");

writeFileSync(join(work, "ext.mts"), `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "ext",
  defaults: { model: "openrouter/test/model" },
  inputs: ["house_rules"],
  nodes: { judge: { inputs: ["house_rules"], outputs: ["verdict"] } },
  entry: "judge", exit: "judge",
});
`, "utf8");
const ext = toLayout(await loadScene(join(work, "ext.mts"), loadRegistry()));
assert.deepEqual(ext.inputs, ["house_rules"]);
assert.deepEqual(ext.data, [{ key: "house_rules", from: "input:house_rules", to: "judge" }],
  "the outside world is a source in the data graph, drawn as its own box");
console.log("ok - 7 external inputs are declared, proved, and drawn");

console.log("\nall dataflow tests pass");
