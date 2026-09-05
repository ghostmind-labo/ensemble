// Offline proof of `ensemble replay`: a recorded run plays back through the
// REAL engine with the network dead and no API key — fn nodes re-execute
// live, predicates and schemas re-check, and edits to the scene surface as
// route/state findings instead of costing a live run. OpenRouter is mocked
// only to RECORD; every replay below runs with fetch replaced by a bomb.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScene } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene, readJournal } from "../src/engine.ts";
import { replayRun, readTape } from "../src/replay.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";

const work = mkdtempSync(join(tmpdir(), "ensemble-replay-"));
const sceneFile = join(work, "flow.mts");

/** The baseline scene: model → fn → model, with a typed key. */
const baseScene = (tweaks: { fnBody?: string; tail?: string; schema?: string } = {}): string => `
import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "flow",
  defaults: { model: "openrouter/test/model" },
  state: { score: ${tweaks.schema ?? "z.number()"} },
  nodes: {
    one:   { outputs: ["a"] },
    two:   { runtime: "fn", fn: (s) => ({ b: ${tweaks.fnBody ?? 'String(s["a"]).toUpperCase()'} }), inputs: ["a"], outputs: ["b"] },
    three: { inputs: ["b"], outputs: ["c", "score"] },
  },
  ${tweaks.tail ?? 'edges: [{ from: "one", to: "two" }, { from: "two", to: "three" }], entry: "one", exit: "three"'},
});
`;
writeFileSync(sceneFile, baseScene(), "utf8");
process.chdir(work);

// --- mocks: record with fake SSE, replay with a network bomb ---------------
function mockFetch(): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
    const text = body.messages.map((m) => m.content).join("\n");
    const answer = text.includes('"score"')
      ? '```json\n{"c": "shipped", "score": 7}\n```'
      : '```json\n{"a": "value-a"}\n```';
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
function bombFetch(): void {
  globalThis.fetch = (() => {
    throw new Error("replay reached the network — it must not");
  }) as never;
}
const runDirs = (): string[] =>
  existsSync(".ensemble/runs") ? readdirSync(".ensemble/runs") : [];

// ── 1 · record a real (mocked) run — the tape is a side effect of running ──
mockFetch();
const registry = loadRegistry();
const recorded = await runScene(await loadScene(sceneFile, registry), "the goal");
assert.equal(recorded.ok, true);
assert.ok(existsSync(join(recorded.runDir, "events.jsonl")), "every run writes its tape");
console.log("ok · recorded a run; the tape came free");

// From here on: no network, no key. Replay must not notice.
bombFetch();
delete process.env.OPENROUTER_API_KEY;

// ── 2 · an untouched scene replays identically, spending nothing ───────────
const dirsBefore = runDirs().length;
const same = await replayRun(recorded.runDir);
assert.equal(same.ok, true);
assert.equal(same.sceneChanged, false);
assert.equal(same.replayedCalls, 2, "both model nodes answered from tape");
assert.equal(same.recomputed, 1, "the fn node re-executed live");
assert.equal(same.routeMatches, true);
assert.deepEqual(same.stateChanged, []);
assert.equal(same.state["b"], "VALUE-A");
assert.equal(same.state["score"], 7);
assert.equal(runDirs().length, dirsBefore, "a replay leaves no run directory behind");
console.log("ok · identical replay: free, offline, keyless, traceless");

// ── 3 · an edited fn re-runs LIVE — the change shows up in state ───────────
writeFileSync(sceneFile, baseScene({ fnBody: 'String(s["a"]).toUpperCase() + "!"' }), "utf8");
const editedFn = await replayRun(recorded.runDir);
assert.equal(editedFn.ok, true);
assert.equal(editedFn.sceneChanged, true);
assert.equal(editedFn.state["b"], "VALUE-A!", "the NEW fn ran, not the recorded value");
assert.ok(editedFn.stateChanged.includes("b"), "the drift is named");
console.log("ok · edited fn recomputed live; drift reported on 'b'");

// ── 4 · an edited gate changes the route — divergence is a finding ─────────
writeFileSync(
  sceneFile,
  baseScene({
    tail:
      'edges: [{ from: "one", to: "two" }, { from: "two", to: "three", when: (s) => String(s["b"]).length > 999 }], entry: "one", exit: "two"',
  }),
  "utf8",
);
const gated = await replayRun(recorded.runDir);
assert.equal(gated.ok, true, "a shorter route can still finish cleanly");
assert.equal(gated.routeMatches, false);
assert.equal(gated.divergedAfter, "two");
assert.ok(gated.stateRemoved.includes("c"), "keys the new route never produces are named");
console.log("ok · gate edit diverged after 'two', reported not guessed");

// ── 5 · a node with no recording fails loudly, not silently ────────────────
writeFileSync(
  sceneFile,
  baseScene({
    tail:
      'edges: [{ from: "one", to: "two" }, { from: "two", to: "three" }, { from: "three", to: "four" }], entry: "one", exit: "four"',
  }).replace("nodes: {", 'nodes: {\n    four: { inputs: ["c"], outputs: ["d"] },'),
  "utf8",
);
const unrecorded = await replayRun(recorded.runDir);
assert.equal(unrecorded.ok, false);
assert.match(unrecorded.reason ?? "", /no recording for node "four"/);
console.log("ok · a new node fails with its name, not a network error");

// ── 6 · a tightened schema re-judges the recorded value ────────────────────
writeFileSync(sceneFile, baseScene({ schema: "z.number().max(5)" }), "utf8");
const tightened = await replayRun(recorded.runDir);
assert.equal(tightened.ok, false, "the recorded 7 no longer passes max(5)");
assert.match(tightened.reason ?? "", /score/);
console.log("ok · schema edit re-judged the tape: recorded 7 fails max(5)");

// ── 7 · an ask node: two-segment tape (park + resume) replays whole ────────
process.env.OPENROUTER_API_KEY = "test-key";
mockFetch();
const gateFile = join(work, "gated.mts");
writeFileSync(
  gateFile,
  `
import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "gated",
  defaults: { model: "openrouter/test/model" },
  nodes: {
    draft:   { outputs: ["a"] },
    approve: { runtime: "ask", question: "ship it?", inputs: ["a"], outputs: ["ok"] },
    ship:    { runtime: "fn", fn: (s) => ({ done: s["ok"] === "yes" }), inputs: ["ok"], outputs: ["done"] },
  },
  edges: [{ from: "draft", to: "approve" }, { from: "approve", to: "ship" }],
  entry: "draft", exit: "ship",
});
`,
  "utf8",
);
const gatedScene = await loadScene(gateFile, registry);
const parked = await runScene(gatedScene, "ship the draft");
assert.equal(parked.ok, false, "the run parks on the ask");
const resumed = await runScene(gatedScene, "ship the draft", {
  resumeFrom: readJournal(parked.runDir),
  answers: { ok: "yes" },
});
assert.equal(resumed.ok, true);

bombFetch();
delete process.env.OPENROUTER_API_KEY;
const tape = readTape(parked.runDir);
assert.equal(tape.segments, 2, "park + resume is one tape in two segments");
assert.equal(tape.answers["ok"], "yes", "the human answer was recovered from the checkpoints");
const asked = await replayRun(parked.runDir);
assert.equal(asked.ok, true);
assert.equal(asked.routeMatches, true);
assert.equal(asked.state["done"], true, "the recorded answer re-answers the ask");
console.log("ok · two-segment ask tape replays end to end");

console.log("replay: 7 scenarios — recorded once, replayed free");
