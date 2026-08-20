// The deterministic neuron: runtime "fn" is a plain function over state — free,
// instant, and held to the same schema contract as model output. Mocked model;
// no key, no spend.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScene, validateSpec, SceneError } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene } from "../src/engine.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const registry = loadRegistry();
const problemsOf = (spec: unknown): string[] => {
  try { validateSpec(spec, "x.mts", registry); return []; }
  catch (e) { return e instanceof SceneError ? e.problems : [String(e)]; }
};

// ── 1 · validation: fn is required, outputs are required, no model needed ──
const base = { name: "t", entry: "n", exit: "n" };
assert.match(problemsOf({ ...base, nodes: { n: { runtime: "fn", outputs: ["x"] } } }).join(";"),
  /declares no fn — the function IS the node/);
assert.match(problemsOf({ ...base, nodes: { n: { runtime: "fn", fn: () => ({}) } } }).join(";"),
  /declares no outputs/);
assert.deepEqual(problemsOf({ ...base, nodes: { n: { runtime: "fn", fn: () => ({ x: 1 }), outputs: ["x"] } } }), [],
  "an fn node needs NO model even with defaults.model unset");
assert.match(problemsOf({ ...base, nodes: { n: { runtime: "fn", fn: () => ({}), prompt: "hi", outputs: ["x"] } } }).join(";"),
  /declares prompt but runtime "fn" does not accept it/);
console.log("ok · 1 validation: fn required, outputs required, model-free, no prompt");

// ── 2 · a real scene: model thinks, fn nodes do the arithmetic for free ─────
const work = mkdtempSync(join(tmpdir(), "ensemble-fn-"));
writeFileSync(join(work, "s.mts"), `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "tally",
  defaults: { model: "openrouter/test/model" },
  state: { round: z.number().int().min(1), verdict: z.enum(["hit", "miss"]) },
  nodes: {
    judge: { outputs: ["verdict"] },                       // the stochastic neuron
    counter: {                                             // the deterministic one
      runtime: "fn",
      fn: (s) => ({ round: (Number(s.round) || 0) + 1, log: \`round \${(Number(s.round) || 0) + 1}: \${s.verdict}\` }),
      inputs: ["round", "verdict"],
      outputs: ["round", "log"],
    },
  },
  edges: [
    { from: "judge", to: "counter" },
    { from: "counter", to: "judge", when: (s) => s.round < 3, maxLoops: 5 },
  ],
  entry: "judge", exit: "counter",
});
`, "utf8");
process.chdir(work);

let modelCalls = 0;
const mock = (): void => {
  globalThis.fetch = (async () => {
    modelCalls++;
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: '```json\n{"verdict":"hit"}\n```' } }] })}\n\n`
      + `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.01 } })}\n\n` + `data: [DONE]\n\n`;
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) };
  }) as never;
};
mock();

const scn = await loadScene(join(work, "s.mts"), loadRegistry());
const run = await runScene(scn, "go", {});
assert.equal(run.ok, true, JSON.stringify(run));
assert.equal(run.state["round"], 3, "the fn node drove the loop counter deterministically");
assert.equal(run.state["log"], "round 3: hit");
assert.equal(modelCalls, 3, "only the judge cost tokens — the fn neuron is free");
const costs = JSON.parse((await import("node:fs")).readFileSync(join(run.runDir, "costs.json"), "utf8"));
assert.equal(costs.nodes.counter.cost, 0, "fn node: $0 across 3 runs");
console.log("ok · 2 fn neuron drives a typed loop for $0 while the model neuron thinks");

// ── 3 · fn output faces the SAME schema contract as model output ───────────
writeFileSync(join(work, "bad.mts"), `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "badfn",
  state: { round: z.number() },
  nodes: { n: { runtime: "fn", fn: () => ({ round: "banana" }), outputs: ["round"] } },
  entry: "n", exit: "n",
});
`, "utf8");
const bad = await runScene(await loadScene(join(work, "bad.mts"), loadRegistry()), "go", {});
assert.equal(bad.ok, false);
assert.match(bad.reason ?? "", /round: Expected number/, "schema violation named precisely");
console.log("ok · 3 a schema-violating fn fails loudly — same contract as model output");

// ── 4 · a throwing fn fails the node with its message, not a crash ──────────
writeFileSync(join(work, "throw.mts"), `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "throwfn",
  nodes: { n: { runtime: "fn", fn: () => { throw new Error("neuron misfired"); }, outputs: ["x"] } },
  entry: "n", exit: "n",
});
`, "utf8");
const boom = await runScene(await loadScene(join(work, "throw.mts"), loadRegistry()), "go", {});
assert.equal(boom.ok, false);
assert.match(boom.reason ?? "", /neuron misfired/);
console.log("ok · 4 a throwing fn fails its node with the real message");

console.log("\nall fn-runtime (deterministic neuron) tests pass");
