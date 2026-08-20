// A pause is deliberately durable, so ending one must be just as deliberate:
// `cancel` closes a parked run for good — it stops showing as waiting, refuses
// to resume, and keeps its artifacts as history.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScene } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene, readJournal, cancelRun } from "../src/engine.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const work = mkdtempSync(join(tmpdir(), "ensemble-cancel-"));
writeFileSync(join(work, "s.mts"), `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "pauser",
  defaults: { model: "openrouter/test/model" },
  nodes: {
    a: { outputs: ["draft"] },
    gate: { runtime: "ask", question: "Approve?", outputs: ["signoff"] },
    b: { inputs: ["signoff"], outputs: ["out"] },
  },
  edges: [{ from: "a", to: "gate" }, { from: "gate", to: "b" }],
  entry: "a", exit: "b",
});
`, "utf8");
process.chdir(work);
globalThis.fetch = (async () => {
  const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: '```json\n{"draft":"d","out":"o"}\n```' } }] })}\n\n`
    + `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.01 } })}\n\n` + `data: [DONE]\n\n`;
  return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) };
}) as never;

const scn = await loadScene(join(work, "s.mts"), loadRegistry());
const parked = await runScene(scn, "go", {});
assert.equal(parked.ok, false);
assert.ok(parked.waiting, "parked on the gate");

// ── 1 · cancel closes it: no resumeAt, no pending, reason recorded ─────────
const j = cancelRun(parked.runDir, "table went home");
assert.equal(j.resumeAt, undefined);
assert.equal(j.pending, undefined);
assert.match(j.stoppedBecause ?? "", /cancelled: table went home/);
assert.ok(j.cancelled?.at, "cancellation is stamped");
console.log("ok · 1 cancel clears the graph position and records why");

// ── 2 · a cancelled run refuses to resume — for good ───────────────────────
assert.throws(() => readJournal(parked.runDir), /was cancelled \(table went home\)/);
console.log("ok · 2 readJournal refuses a cancelled run with the reason");

// ── 3 · idempotent, and artifacts survive as history ───────────────────────
assert.equal(cancelRun(parked.runDir).cancelled?.reason, "table went home", "second cancel is a no-op");
assert.ok(existsSync(join(parked.runDir, "state.json")), "state kept");
assert.ok(existsSync(join(parked.runDir, "events.jsonl")), "transcript kept");
assert.equal(JSON.parse(readFileSync(join(parked.runDir, "state.json"), "utf8")).draft, "d");
console.log("ok · 3 idempotent; state and transcript remain readable history");

// ── 4 · a completed run cannot be cancelled ─────────────────────────────────
const done = await runScene(scn, "go", { answers: { signoff: "yes" } });
assert.equal(done.ok, true);
assert.throws(() => cancelRun(done.runDir), /already completed/);
console.log("ok · 4 completed runs refuse cancellation — nothing to close");

console.log("\nall cancel tests pass");
