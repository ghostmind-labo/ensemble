// The groundwork contract: everything is an object, and adding a capability
// means REGISTERING an object — no engine, schema, or validator edits. This
// test mounts a brand-new runtime from library code and runs a scene on it.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadScene, validateSpec, SceneError } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene } from "../src/engine.ts";
import { registerRuntime, RUNTIMES } from "../src/runtimes/index.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const registry = loadRegistry();
const problemsOf = (spec: unknown): string[] => {
  try { validateSpec(spec, "x.mts", registry); return []; }
  catch (e) { return e instanceof SceneError ? e.problems : [String(e)]; }
};

// ── 1 · a custom runtime is ONE object handed to registerRuntime ───────────
registerRuntime({
  name: "stamp",
  summary: "deterministic marker — no model, no wait",
  badge: "⏱",
  needsModel: false,
  fields: { label: z.string() },
  check: (name, spec) =>
    (spec.outputs ?? []).length === 1 ? [] : [`node "${name}" (stamp) must declare exactly one output`],
  park: ({ spec }) => ({
    values: { [(spec.outputs ?? [])[0]!]: `stamped:${(spec as { label?: string }).label ?? "?"}` },
  }),
});
assert.ok(RUNTIMES["stamp"], "mounted");
console.log("ok · 1 new runtime mounted with registerRuntime — no engine edits");

// ── 2 · the validator now speaks it: fields, checks, unknown names ──────────
const base = { name: "t", defaults: { model: "openrouter/a/b" }, entry: "s", exit: "s" };
assert.deepEqual(problemsOf({ ...base, nodes: { s: { runtime: "stamp", label: "go", outputs: ["mark"] } } }), []);
assert.match(problemsOf({ ...base, nodes: { s: { runtime: "stamp", label: "go", maxTurns: 3, outputs: ["mark"] } } }).join(";"),
  /declares maxTurns but runtime "stamp" does not accept it/);
assert.match(problemsOf({ ...base, nodes: { s: { runtime: "stamp", label: 7, outputs: ["mark"] } } }).join(";"),
  /"s"\.label/i);
assert.match(problemsOf({ ...base, nodes: { s: { runtime: "nope", outputs: ["x"] } } }).join(";"),
  /unknown runtime "nope" — registered: .*stamp/);
assert.match(problemsOf({ ...base, nodes: { s: { runtime: "stamp", label: "go", outputs: ["a", "b"] } } }).join(";"),
  /exactly one output/);
console.log("ok · 2 validator composes the node surface from the object (fields, values, checks)");

// ── 3 · built-in rules survived the registry rewrite ───────────────────────
assert.match(problemsOf({ ...base, nodes: { s: { runtime: "ask", model: "openrouter/a/b", outputs: ["x"] } } }).join(";"),
  /declares model/);
assert.match(problemsOf({ ...base, nodes: { s: { runtime: "ask" } } }).join(";"), /declares no outputs/);
assert.match(problemsOf({ ...base, nodes: { s: { skills: ["x"], outputs: ["y"] } } }).join(";"),
  /declares skills but runtime "model" does not accept it/);
console.log("ok · 3 built-in runtime rules preserved, now owned by their objects");

// ── 4 · the custom runtime EXECUTES in a real run, mixed with a model node ─
const work = mkdtempSync(join(tmpdir(), "ensemble-rt-"));
writeFileSync(join(work, "s.mts"), `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "stamped",
  defaults: { model: "openrouter/test/model" },
  nodes: {
    marker: { runtime: "stamp", label: "hello", outputs: ["mark"] },
    reader: { inputs: ["mark"], outputs: ["echo"] },
  },
  edges: [{ from: "marker", to: "reader" }],
  entry: "marker", exit: "reader",
});
`, "utf8");
process.chdir(work);

let modelCalls = 0;
globalThis.fetch = (async () => {
  modelCalls++;
  const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: '```json\n{"echo":"seen"}\n```' } }] })}\n\n`
    + `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.01 } })}\n\n` + `data: [DONE]\n\n`;
  return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) };
}) as never;

const run = await runScene(await loadScene(join(work, "s.mts"), registry), "go", {});
assert.equal(run.ok, true, JSON.stringify(run));
assert.equal(run.state["mark"], "stamped:hello", "the custom runtime produced its value");
assert.equal(run.state["echo"], "seen", "and a model node consumed it downstream");
assert.equal(modelCalls, 1, "the stamp runtime made zero model calls");
console.log("ok · 4 custom runtime executed in a run, feeding a model node, zero model calls of its own");

console.log("\nall runtime-object tests pass");
