// Edge kinds: how the run decides where to go next, as a mountable object.
//
// The extracted "sequential" kind must reproduce the engine's old inline loop
// exactly — declaration order, first match wins, per-INDEX loop budgets — and a
// custom kind must be able to change routing with no engine edit. Mocked model.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDGE_KINDS, registerEdgeKind, sequentialEdges } from "../src/edges.ts";
import { loadScene } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene } from "../src/engine.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const work = mkdtempSync(join(tmpdir(), "ensemble-edges-"));
process.chdir(work);

globalThis.fetch = (async () => {
  const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: '```json\n{"n":1}\n```' } }] })}\n\n`
    + `data: ${JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } })}\n\ndata: [DONE]\n\n`;
  return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) };
}) as never;

const run = async (name: string, src: string) => {
  const f = join(work, `${name}.mts`);
  writeFileSync(f, src, "utf8");
  return runScene(await loadScene(f, loadRegistry()), "go", {});
};

// ── 1 · sequential is registered and is the default ───────────────────────
assert.equal(EDGE_KINDS["sequential"], sequentialEdges);
assert.equal(sequentialEdges.summary.includes("first match wins"), true);
console.log("ok · 1 sequential is mounted like every other object");

// ── 2 · declaration order decides: the FIRST matching edge wins ────────────
const first = await run("order", `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "order",
  defaults: { model: "openrouter/test/model" },
  state: { n: z.number(), trail: z.string().optional() },
  nodes: {
    a: { outputs: ["n"] },
    winner: { runtime: "fn", fn: () => ({ trail: "winner" }), outputs: ["trail"] },
    loser:  { runtime: "fn", fn: () => ({ trail: "loser" }),  outputs: ["trail"] },
  },
  edges: [
    { from: "a", to: "winner" },
    { from: "a", to: "loser" },   // also matches, and must never be taken
  ],
  entry: "a", exit: "winner",
});
`);
assert.equal(first.ok, true, JSON.stringify(first));
assert.equal(first.state["trail"], "winner", "the second matching edge is never taken");
console.log("ok · 2 declaration order, first match wins");

// ── 3 · maxLoops is counted per EDGE INDEX, not per from→to pair ───────────
// Two edges between the same pair keep separate budgets: 2 + 1 = 3 passes.
const looped = await run("budgets", `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "budgets",
  state: { n: z.number(), passes: z.number() },
  nodes: {
    tick: { runtime: "fn", fn: (s) => ({ passes: (Number(s.passes) || 0) + 1 }), outputs: ["passes"] },
    hub:  { runtime: "fn", fn: () => ({ n: 1 }), outputs: ["n"] },
  },
  edges: [
    { from: "tick", to: "hub" },
    { from: "hub", to: "tick", maxLoops: 2 },
    { from: "hub", to: "tick", maxLoops: 1 },
  ],
  entry: "tick", exit: "hub",
});
`);
assert.equal(looped.ok, true, JSON.stringify(looped));
assert.equal(looped.state["passes"], 4, "1 entry + 3 loop passes: budgets are per index, not per pair");
console.log("ok · 3 maxLoops budgets are per edge index");

// ── 4 · a throwing predicate fails the run and names the edge ──────────────
const threw = await run("throws", `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "throws",
  state: { n: z.number() },
  nodes: { a: { runtime: "fn", fn: () => ({ n: 1 }), outputs: ["n"] },
           b: { runtime: "fn", fn: () => ({ n: 2 }), outputs: ["n"] } },
  edges: [{ from: "a", to: "b", when: () => { throw new Error("boom"); } }],
  entry: "a", exit: "b",
});
`);
assert.equal(threw.ok, false);
assert.match(threw.reason ?? "", /condition on a→b threw: boom.*pure predicate over state/s);
console.log("ok · 4 a throwing predicate fails loudly and names the edge");

// ── 5 · a custom kind reroutes with NO engine edit ─────────────────────────
registerEdgeKind({
  name: "reverse",
  summary: "last match wins — the mirror of sequential",
  fields: {},
  select: ({ edges, cursor, members, state, emit }) => {
    const matches = edges.filter((e) => e.from === cursor || members.includes(e.from));
    const pick = matches.filter((e) => !e.when || e.when({ ...state } as never)).at(-1);
    if (!pick) return {};
    emit({ type: "edge", from: cursor, to: pick.to });
    return { next: pick.to };
  },
});
const reversed = await run("reverse", `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "reverse",
  edgeKind: "reverse",
  state: { n: z.number(), trail: z.string().optional() },
  nodes: {
    a: { runtime: "fn", fn: () => ({ n: 1 }), outputs: ["n"] },
    winner: { runtime: "fn", fn: () => ({ trail: "winner" }), outputs: ["trail"] },
    loser:  { runtime: "fn", fn: () => ({ trail: "loser" }),  outputs: ["trail"] },
  },
  edges: [{ from: "a", to: "loser" }, { from: "a", to: "winner" }],
  entry: "a", exit: "winner",
});
`);
assert.equal(reversed.ok, true, JSON.stringify(reversed));
assert.equal(reversed.state["trail"], "winner", "the custom kind chose the LAST match");
console.log("ok · 5 a custom edge kind reroutes the run with no engine edit");

// ── 6 · an unknown kind says so, and lists what is registered ──────────────
const unknown = await run("unknown", `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "unknown",
  edgeKind: "telepathy",
  state: { n: z.number() },
  nodes: { a: { runtime: "fn", fn: () => ({ n: 1 }), outputs: ["n"] },
           b: { runtime: "fn", fn: () => ({ n: 2 }), outputs: ["n"] } },
  edges: [{ from: "a", to: "b" }],
  entry: "a", exit: "b",
});
`);
assert.equal(unknown.ok, false);
assert.match(unknown.reason ?? "", /edgeKind "telepathy" — registered: .*sequential/);
console.log("ok · 6 an unknown edge kind lists the registered ones");

console.log("\nall edge-kind tests pass");
