// Does a resume respect maxLoops already consumed? If edgeLoops were lost with
// the process, a resumed run would silently get a fresh loop budget and spend
// twice what the scene authorised. Compared head-to-head against an
// uninterrupted run of the same scene.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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

const work = mkdtempSync(join(tmpdir(), "ensemble-loops-"));
const sceneFile = join(work, "gate.mts");
// A gate that NEVER passes: the only thing stopping it is maxLoops: 2.
writeFileSync(
  sceneFile,
  `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "gate",
  defaults: { model: "openrouter/test/model" },
  nodes: {
    writer: { inputs: ["score"], outputs: ["draft"] },
    judge:  { inputs: ["draft"], outputs: ["score"] },
  },
  edges: [
    { from: "writer", to: "judge" },
    { from: "judge", to: "writer", when: (s) => Number(s["score"]) < 8, maxLoops: 2 },
  ],
  entry: "writer",
  exit: "judge",
});
`,
  "utf8",
);
process.chdir(work);

let nodeCalls = 0;
function mockFetch(): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
    const text = body.messages.map((m) => m.content).join("\n");
    nodeCalls++;
    // score always 1 → the gate always wants another loop.
    const answer = text.includes('"score"')
      ? '```json\n{"score": 1}\n```'
      : '```json\n{"draft": "d"}\n```';
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n` +
      `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.1 } })}\n\n` +
      `data: [DONE]\n\n`;
    return {
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse));
          c.close();
        },
      }),
    };
  }) as never;
}

const scene = await loadScene(sceneFile, loadRegistry());

// ── baseline: one uninterrupted run ────────────────────────────────────────
mockFetch();
const baseline = await runScene(scene, "go", {});
assert.equal(baseline.ok, true);
const baselineCalls = nodeCalls;
// writer,judge + 2 authorised loops of (writer,judge) = 6
assert.equal(baselineCalls, 6, `expected 6 node calls uninterrupted, got ${baselineCalls}`);
console.log(`ok · uninterrupted run: ${baselineCalls} node calls (2 loops, then maxLoops stops it)`);

// ── interrupted: stop after 3 calls, then resume ───────────────────────────
nodeCalls = 0;
mockFetch();
const stopped = await runScene(scene, "go", { budget: 0.3 });
assert.equal(stopped.ok, false);
const before = nodeCalls;
assert.ok(before < baselineCalls, "the budget must stop it early");
console.log(`ok · budget stopped it after ${before} node calls`);

const journal = readJournal(stopped.runDir);
assert.ok(journal.journal.edgeLoops.length > 0, "a consumed loop must be journalled");
console.log(`ok · journal carries edgeLoops: ${JSON.stringify(journal.journal.edgeLoops)}`);

mockFetch();
const resumed = await runScene(scene, "go", { resumeFrom: journal, budget: 10 });
assert.equal(resumed.ok, true, "resume should finish");

// The whole point: interrupted + resumed spends exactly what one clean run does.
assert.equal(
  nodeCalls,
  baselineCalls,
  `resume reset the loop budget: ${nodeCalls} total calls vs ${baselineCalls} uninterrupted`,
);
console.log(`ok · interrupted+resumed total = ${nodeCalls} calls — identical to uninterrupted`);

console.log("\nmaxLoops survives the stop: resume does NOT get a fresh loop budget");
