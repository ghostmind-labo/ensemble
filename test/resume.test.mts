// Offline proof of `ensemble resume`: a budget stops a run mid-graph, the
// journal records where it stopped, and resuming finishes WITHOUT re-running
// what was already paid for. OpenRouter is mocked; no network, no spend.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScene } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene, readJournal } from "../src/engine.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d, join as __j } from "node:path";
/** Repo root, so scenes written into temp dirs can import by absolute path. */
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";

// --- a 3-node linear scene, written to a temp dir we can cwd into ----------
const work = mkdtempSync(join(tmpdir(), "ensemble-resume-"));
const sceneFile = join(work, "chain.mts");
writeFileSync(
  sceneFile,
  `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "chain",
  defaults: { model: "openrouter/test/model" },
  nodes: {
    one:   { outputs: ["a"] },
    two:   { inputs: ["a"], outputs: ["b"] },
    three: { inputs: ["b"], outputs: ["c"] },
  },
  edges: [{ from: "one", to: "two" }, { from: "two", to: "three" }],
  entry: "one",
  exit: "three",
});
`,
  "utf8",
);
process.chdir(work);

// --- mock: model nodes stream SSE; each call costs $0.10 ------------------
const calls: string[] = [];
function mockFetch(): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
    // The output contract names the key this node owes; echo it back as json.
    const text = body.messages.map((m) => m.content).join("\n");
    const key = /"([abc])"/.exec(text)?.[1] ?? "a";
    calls.push(key);

    const answer = '```json\n{"' + key + '": "value-' + key + '"}\n```';
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n` +
      `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.1 } })}\n\n` +
      `data: [DONE]\n\n`;

    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      }),
    };
  }) as never;
}

const registry = loadRegistry();
const scene = await loadScene(sceneFile, registry);

// ── 1 · a budget stops the run after the first node ────────────────────────
mockFetch();
const first = await runScene(scene, "go", { budget: 0.1 });

assert.equal(first.ok, false, "the run must stop on the budget");
assert.match((first as { reason: string }).reason, /budget exhausted/);
assert.deepEqual(calls, ["a"], "only node one should have run");
assert.deepEqual(first.state["a"], "value-a");
assert.equal(first.state["b"], undefined, "node two must not have run");
console.log("ok · budget stopped the run after node one");

// ── 2 · the journal records the position, not just the state ───────────────
const journalPath = join(first.runDir, "journal.json");
assert.ok(existsSync(journalPath), "journal.json must be written");
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
assert.equal(journal.version, 1);
assert.equal(journal.resumeAt, "two", "must resume at the target that never ran");
assert.equal(journal.scene.file, sceneFile);
assert.equal(journal.goal, "go");
assert.equal(journal.nodeRuns, 1);
assert.ok(Math.abs(journal.totalCost - 0.1) < 1e-9);
assert.equal(journal.nodeCosts.one.runs, 1);
assert.match(journal.stoppedBecause, /budget exhausted/);
console.log("ok · journal records resumeAt=two, spend, and why it stopped");

// ── 3 · resuming finishes the graph without re-running node one ────────────
calls.length = 0;
mockFetch();
const resumeFrom = readJournal(first.runDir);
const second = await runScene(scene, journal.goal, { resumeFrom, budget: 1 });

assert.equal(second.ok, true, `resume should complete, got: ${JSON.stringify(second)}`);
assert.deepEqual(calls, ["b", "c"], "resume must run ONLY the remaining nodes");
assert.equal(second.state["a"], "value-a", "earlier state carried over");
assert.equal(second.state["c"], "value-c", "graph finished");
assert.equal(second.runDir, first.runDir, "resume continues in the same run dir");
console.log("ok · resume ran only nodes two+three, in the same run dir");

// ── 4 · cost and node counts accumulate across the resume ──────────────────
const costs = JSON.parse(readFileSync(join(second.runDir, "costs.json"), "utf8"));
assert.ok(Math.abs(costs.totalCost - 0.3) < 1e-9, `cumulative cost should be 0.3, got ${costs.totalCost}`);
assert.equal(costs.nodeRuns, 3, "node runs accumulate across the resume");
assert.equal(costs.nodes.one.runs, 1, "node one still shows its single paid run");
assert.equal(costs.nodes.three.runs, 1);
console.log("ok · costs.json accumulated across both attempts (0.1 + 0.2 = 0.3)");

// ── 5 · a finished run refuses to resume ───────────────────────────────────
assert.throws(() => readJournal(second.runDir), /nothing left to resume/);
console.log("ok · a completed run refuses to resume");

// ── 6 · a non-run directory fails with an actionable message ───────────────
assert.throws(() => readJournal(work), /no journal\.json/);
console.log("ok · a non-run directory is rejected clearly");

console.log("\nall resume tests pass");
