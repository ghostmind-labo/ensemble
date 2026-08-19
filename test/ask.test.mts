// The ask node: a run parks mid-graph, survives the process, and continues when
// either a human or an agent supplies the answer. OpenRouter is mocked; no spend.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScene, validateSpec, SceneError } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene, readJournal } from "../src/engine.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d, join as __j } from "node:path";
/** Repo root, so scenes written into temp dirs can import by absolute path. */
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";

const work = mkdtempSync(join(tmpdir(), "ensemble-ask-"));
const sceneFile = join(work, "approve.mts");
// draft → approval (ask) → publish. The gate is a HUMAN/AGENT, not a model.
writeFileSync(
  sceneFile,
  `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "approve",
  defaults: { model: "openrouter/test/model" },
  nodes: {
    draft:    { outputs: ["draft"] },
    approval: {
      runtime: "ask",
      question: "Ship this draft? Reply approve or reject, and say why.",
      inputs: ["draft"],
      outputs: ["verdict", "why"],
    },
    publish:  { inputs: ["draft", "verdict", "why"], outputs: ["published"] },
  },
  edges: [{ from: "draft", to: "approval" }, { from: "approval", to: "publish" }],
  entry: "draft",
  exit: "publish",
});
`,
  "utf8",
);
process.chdir(work);

const calls: string[] = [];
function mockFetch(): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
    const text = body.messages.map((m) => m.content).join("\n");
    const key = /"(draft|published)"/.exec(text)?.[1] ?? "draft";
    calls.push(key);
    const answer = '```json\n{"' + key + '": "value-' + key + '"}\n```';
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n` +
      `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.05 } })}\n\n` +
      `data: [DONE]\n\n`;
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) };
  }) as never;
}

const registry = loadRegistry();
const scene = await loadScene(sceneFile, registry);

// ── 1 · validation understands the new runtime ─────────────────────────────
assert.equal(scene.nodes["approval"]?.runtime, "ask");
const bad = (spec: unknown): string[] => {
  try { validateSpec(spec, "x.mts", registry); return []; }
  catch (e) { return e instanceof SceneError ? e.problems : [String(e)]; }
};
assert.match(
  bad({ name: "b", nodes: { a: { runtime: "ask" } }, entry: "a" }).join(";"),
  /declares no outputs/,
  "an ask node with no outputs must be rejected",
);
assert.match(
  bad({ name: "b", nodes: { a: { runtime: "ask", outputs: ["x"], model: "openrouter/m/m" } }, entry: "a" }).join(";"),
  /declares model/,
  "an ask node must not declare a model",
);
// An ask node needs NO model even when defaults.model is unset.
assert.deepEqual(bad({ name: "b", nodes: { a: { runtime: "ask", outputs: ["x"] } }, entry: "a" }), []);
console.log("ok · validator: ask needs outputs, refuses model, needs no model itself");

// ── 2 · the run parks on the ask node ──────────────────────────────────────
mockFetch();
const askEvents: Array<{ question: string; outputs: string[] }> = [];
const first = await runScene(scene, "go", {
  onEvent: (e) => { if (e.type === "node:ask") askEvents.push({ question: e.question, outputs: e.outputs }); },
});

assert.equal(first.ok, false, "a parked run is not ok:true");
assert.ok("waiting" in first && first.waiting, "it must report WHY it stopped: waiting, not failed");
assert.equal(first.waiting?.node, "approval");
assert.match(first.waiting!.question, /Ship this draft/);
assert.deepEqual(first.waiting?.outputs, ["verdict", "why"]);
assert.deepEqual(calls, ["draft"], "only the pre-ask node ran");
assert.equal(first.state["published"], undefined, "the post-ask node did NOT run");
assert.equal(askEvents.length, 1, "a node:ask event fired");
console.log("ok · run parked on the ask node, reported waiting (not failed), asked its question");

// ── 3 · the question is durable — it lives in the journal ──────────────────
const journal = JSON.parse(readFileSync(join(first.runDir, "journal.json"), "utf8"));
assert.equal(journal.resumeAt, "approval", "resume re-enters at the ask node");
assert.equal(journal.pending.node, "approval");
assert.deepEqual(journal.pending.outputs, ["verdict", "why"]);
assert.match(journal.stoppedBecause, /waiting for an answer/);
console.log("ok · the question survives in journal.json — durable across process death");

// ── 4 · resuming WITHOUT the answer parks again (does not silently skip) ───
mockFetch();
const retry = await runScene(scene, "go", { resumeFrom: readJournal(first.runDir) });
assert.ok("waiting" in retry && retry.waiting, "no answer → parks again, never falls through");
assert.equal(retry.state["published"], undefined);
console.log("ok · resuming with no answer parks again instead of skipping the gate");

// ── 5 · answering continues the run to completion ──────────────────────────
calls.length = 0;
mockFetch();
const done = await runScene(scene, "go", {
  resumeFrom: readJournal(first.runDir),
  answers: { verdict: "approve", why: "reads well, ship it" },
});

assert.equal(done.ok, true, `answered resume should finish, got ${JSON.stringify(done)}`);
assert.deepEqual(calls, ["published"], "only the post-ask node ran — draft was not redone");
assert.equal(done.state["verdict"], "approve", "the answer is in state");
assert.equal(done.state["why"], "reads well, ship it");
assert.equal(done.state["draft"], "value-draft", "pre-ask state carried through the pause");
assert.equal(done.state["published"], "value-published");
assert.equal(done.runDir, first.runDir, "same run dir across the pause");
console.log("ok · answered → ran only the remaining node, answer visible in state");

// ── 6 · the journal no longer advertises a pending question ────────────────
const after = JSON.parse(readFileSync(join(done.runDir, "journal.json"), "utf8"));
assert.equal(after.pending, undefined, "pending is cleared once answered");
assert.equal(after.resumeAt, undefined, "run reached its exit");
assert.throws(() => readJournal(done.runDir), /nothing left to resume/);
console.log("ok · pending cleared, run finished, no longer resumable");

// ── 7 · cost accounting ignores the free pause ─────────────────────────────
const costs = JSON.parse(readFileSync(join(done.runDir, "costs.json"), "utf8"));
assert.ok(Math.abs(costs.totalCost - 0.1) < 1e-9, `two model nodes = $0.10, got ${costs.totalCost}`);
assert.equal(costs.nodes.approval?.cost ?? 0, 0, "the ask node costs nothing");
assert.equal(costs.nodeRuns, 3, "draft + approval + publish");
console.log("ok · the pause is free; cost is just the two model nodes ($0.10)");

console.log("\nall ask-node tests pass");
