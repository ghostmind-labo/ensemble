// Refine mode — keep-or-revert on the blackboard. The writer and the judge are
// fn nodes with scripted scores, so every decision the refine node makes is
// checked against a known trajectory. No model, no key, no spend.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScene, validateSpec, SceneError } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene, readJournal } from "../src/engine.ts";
import { decideRefine, REFINE_OUTPUTS } from "../src/refine.ts";
import { RUNTIMES } from "../src/runtimes/index.ts";
import { dataflow, readsOf } from "../src/dataflow.ts";
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

const work = mkdtempSync(join(tmpdir(), "ensemble-refine-"));
process.chdir(work);

/**
 * writer → judge → keep, looping while not converged. The judge's scores are
 * scripted per round; the writer records what candidate it was shown so we can
 * prove it always builds on the incumbent.
 */
const loopScene = (name: string, scores: number[], keep: string, edge = "when: (s) => !s.converged, maxLoops: 20") => {
  const f = join(work, `${name}.mts`);
  writeFileSync(f, `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "${name}",
  state: { score: z.number(), round: z.number(), converged: z.boolean() },
  nodes: {
    writer: {
      runtime: "fn",
      fn: (s) => { (globalThis.__seen ??= {})["${name}"] = [...(globalThis.__seen["${name}"] ?? []), s.tagline]; return { tagline: "attempt-" + ((Number(s.round) || 0) + 1) }; },
      inputs: ["tagline", "best", "verdict", "reason"],
      outputs: ["tagline"],
    },
    judge: {
      runtime: "fn",
      fn: (s) => ({ score: ${JSON.stringify(scores)}[Number(s.round) || 0] }),
      inputs: ["tagline"],
      outputs: ["score"],
    },
    keep: { runtime: "refine", ${keep}, outputs: ["tagline", "best", "round", "verdict", "reason", "converged", "history"] },
  },
  edges: [
    { from: "writer", to: "judge" },
    { from: "judge", to: "keep" },
    { from: "keep", to: "writer", ${edge} },
  ],
  entry: "writer", exit: "keep",
});
`, "utf8");
  return f;
};

// ── 1 · mounted like every other runtime, with the documented vocabulary ───
assert.equal(RUNTIMES["refine"]?.badge, "⬆");
assert.equal(RUNTIMES["refine"]?.needsModel, false, "a refine node needs no model");
assert.ok(typeof RUNTIMES["refine"]?.compute === "function", "it is a compute runtime, like fn");
assert.deepEqual(Object.keys(RUNTIMES["refine"]!.fields).sort(),
  ["candidate", "minimize", "patience", "score", "target", "threshold"]);
assert.ok(REFINE_OUTPUTS.includes("incumbent") && REFINE_OUTPUTS.includes("converged"));
console.log("ok · 1 refine is a mounted compute runtime with six fields");

// ── 2 · validation: candidate is required, and must be among the outputs ───
const base = { name: "t", entry: "w", exit: "k",
  nodes: {
    w: { runtime: "fn", fn: () => ({ draft: "x" }), outputs: ["draft"] },
    j: { runtime: "fn", fn: () => ({ score: 1 }), inputs: ["draft"], outputs: ["score"] },
  },
  edges: [{ from: "w", to: "j" }, { from: "j", to: "k" }] };
const withKeep = (k: Record<string, unknown>) => ({ ...base, nodes: { ...base.nodes, k } });

assert.match(problemsOf(withKeep({ runtime: "refine", outputs: ["draft"] })).join(";"),
  /names no candidate — the state key under refinement/);
assert.match(problemsOf(withKeep({ runtime: "refine", candidate: "draft", outputs: ["best"] })).join(";"),
  /refines "draft" but does not list it in outputs — the revert writes the incumbent back/);
assert.match(problemsOf(withKeep({ runtime: "refine", candidate: "draft", score: "draft", outputs: ["draft"] })).join(";"),
  /both candidate and score/);
assert.match(problemsOf(withKeep({ runtime: "refine", candidate: "draft", prompt: "hi", outputs: ["draft"] })).join(";"),
  /declares prompt but runtime "refine" does not accept it/);
assert.match(problemsOf(withKeep({ runtime: "refine", candidate: "draft", patience: 0, outputs: ["draft"] })).join(";"),
  /"k"\.patience: Number must be greater than or equal to 1/);
assert.deepEqual(problemsOf(withKeep({ runtime: "refine", candidate: "draft", outputs: ["draft", "converged"] })), [],
  "a well-formed refine node validates with no model anywhere in the scene");
console.log("ok · 2 validation: candidate required, listed in outputs, distinct from score, fields strict");

// ── 3 · the data graph sees what the refine node reads, and proves it ──────
// A typo'd candidate: the refine node itself lists it in outputs (the
// writeback), so the general proof would see a producer — the object checks
// that some OTHER node writes it first. A typo'd score key has no such
// loophole and is caught by the proof, because the runtime declares its reads.
const typo = problemsOf(withKeep({ runtime: "refine", candidate: "darft", outputs: ["darft"] })).join(";");
assert.match(typo, /node "k" refines "darft" but no other node produces it/);
assert.match(typo, /"draft" \(by w\)/, "the fix is spelled out");
assert.deepEqual(problemsOf({ ...withKeep({ runtime: "refine", candidate: "seed", outputs: ["seed"] }), inputs: ["seed"] }), [],
  "a candidate that arrives from outside is declared at the scene level");
const missingScore = problemsOf(withKeep({ runtime: "refine", candidate: "draft", score: "grade", outputs: ["draft"] })).join(";");
assert.match(missingScore, /node "k" reads "grade" but nothing in the scene produces it/);

const okScene = validateSpec(withKeep({ runtime: "refine", candidate: "draft", outputs: ["draft"] }), "x.mts", registry);
assert.deepEqual(readsOf(okScene, okScene.nodes["k"]!), ["draft", "score"]);
const flow = dataflow(okScene);
assert.deepEqual(flow.consumers["score"], ["k"], "the judge's score flows INTO the refine node");
assert.ok(flow.consumers["draft"]!.includes("k"));
const layout = toLayout(okScene);
const keepCard = layout.targets.flatMap((t) => t.members).find((n) => n.name === "k")!;
assert.deepEqual(keepCard.inputs, ["draft", "score"], "the viewer draws the runtime's reads as inputs");
assert.ok(layout.data.some((d) => d.key === "score" && d.from === "j" && d.to === "k"), "a data edge j→k for score");
console.log("ok · 3 the data graph proves and draws the refine node's reads");

// ── 4 · the loop: baseline, keep, revert, keep, then a plateau converges ────
// Scores by round: 5 7 6 8 7 7. patience 2 → converged after two straight
// non-improvements (rounds 5 and 6). The best (8) must be what survives.
{
  const f = loopScene("plateau", [5, 7, 6, 8, 7, 7], `candidate: "tagline", patience: 2`);
  const res = await runScene(await loadScene(f, registry), "go", {});
  assert.equal(res.ok, true, JSON.stringify(res));
  const s = res.state;
  assert.equal(s["tagline"], "attempt-4", "the candidate key holds the BEST attempt, not the last");
  assert.equal(s["best"], 8);
  assert.equal(s["round"], 6);
  assert.equal(s["converged"], true);
  assert.equal(s["stalled"], 2);
  assert.deepEqual((s["history"] as Array<{ verdict: string }>).map((h) => h.verdict),
    ["baseline", "keep", "revert", "keep", "revert", "revert"]);
  assert.match(String(s["summary"]), /converged: no improvement in 2 rounds/);

  // What the writer was shown each round: undefined on entry, then always the
  // incumbent — never the regression it just produced.
  const seen = ((globalThis as { __seen?: Record<string, unknown[]> }).__seen ?? {})["plateau"];
  assert.deepEqual(seen, [undefined, "attempt-1", "attempt-2", "attempt-2", "attempt-4", "attempt-4"],
    "after a revert the writer sees the incumbent, not its rejected attempt");
}
console.log("ok · 4 keep / revert / plateau: the best survives and every revision builds on it");

// ── 5 · target: converged the moment best reaches it ───────────────────────
{
  const f = loopScene("target", [5, 6, 9, 10, 11], `candidate: "tagline", target: 9`);
  const res = await runScene(await loadScene(f, registry), "go", {});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.state["round"], 3, "stopped as soon as the bar was met");
  assert.equal(res.state["tagline"], "attempt-3");
  assert.match(String(res.state["summary"]), /target 9 reached/);
}
console.log("ok · 5 target ends the loop as soon as best reaches it");

// ── 6 · minimize + threshold: a gain inside the noise floor reverts ─────────
{
  const f = loopScene("noise", [10, 9.9, 8, 7.8], `candidate: "tagline", minimize: true, threshold: 0.5, patience: 5`, "when: (s) => !s.converged, maxLoops: 3");
  const res = await runScene(await loadScene(f, registry), "go", {});
  assert.equal(res.ok, true, JSON.stringify(res));
  const verdicts = (res.state["history"] as Array<{ verdict: string }>).map((h) => h.verdict);
  assert.deepEqual(verdicts, ["baseline", "revert", "keep", "revert"]);
  assert.equal(res.state["best"], 8, "9.9 was within 0.5 of 10 — sampling luck, reverted; 8 cleared it");
  assert.equal(res.state["tagline"], "attempt-3");
  assert.equal(res.state["converged"], false, "budget ran out before patience did");
}
console.log("ok · 6 minimize + threshold: lower wins, and only by more than the noise floor");

// ── 7 · maxLoops spent: the run still ends holding the best, not the last ──
// Scores 5 9 3 2 and only 3 loop passes. A plain score gate would end with the
// last attempt (scored 2); refine ends with attempt-2 (scored 9).
{
  const f = loopScene("budget", [5, 9, 3, 2], `candidate: "tagline", patience: 10`, "maxLoops: 3");
  const res = await runScene(await loadScene(f, registry), "go", {});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.state["round"], 4);
  assert.equal(res.state["tagline"], "attempt-2");
  assert.equal(res.state["best"], 9);
  assert.equal(res.state["converged"], false);
}
console.log("ok · 7 when maxLoops runs out the candidate key still holds the best version");

// ── 8 · a non-numeric score is a scene bug, and the message names the fix ──
{
  const f = join(work, "banana.mts");
  writeFileSync(f, `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "banana",
  nodes: {
    w: { runtime: "fn", fn: () => ({ draft: "x" }), outputs: ["draft"] },
    j: { runtime: "fn", fn: () => ({ score: "7/10" }), inputs: ["draft"], outputs: ["score"] },
    k: { runtime: "refine", candidate: "draft", outputs: ["draft", "best"] },
  },
  edges: [{ from: "w", to: "j" }, { from: "j", to: "k" }],
  entry: "w", exit: "k",
});
`, "utf8");
  const res = await runScene(await loadScene(f, registry), "go", {});
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /"score" is "7\/10", not a number/);
  assert.match(res.reason ?? "", /state: \{ score: z\.number\(\) \}/, "the one-line fix is in the message");
}
console.log("ok · 8 a non-numeric score fails loudly and names the fix");

// ── 9 · improve an INPUT: seed the candidate, judge first, then refine ──────
// "We have an input, and the output should be something improved." The seed
// arrives through the scene's `inputs`, is scored as the baseline, and the
// writer improves it from there. Run twice: the second run starts from the
// first run's winner — between-run signal passing with no new machinery.
{
  const f = join(work, "seeded.mts");
  writeFileSync(f, `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "seeded",
  inputs: ["draft"],
  state: { score: z.number(), converged: z.boolean() },
  nodes: {
    judge: { runtime: "fn", fn: (s) => ({ score: String(s.draft).length }), inputs: ["draft"], outputs: ["score"] },
    keep:  { runtime: "refine", candidate: "draft", target: 12, outputs: ["draft", "best", "converged"] },
    writer: { runtime: "fn", fn: (s) => ({ draft: s.draft + "!" }), inputs: ["draft"], outputs: ["draft"] },
  },
  edges: [
    { from: "judge", to: "keep" },
    { from: "keep", to: "writer", when: (s) => !s.converged, maxLoops: 20 },
    { from: "writer", to: "judge" },
  ],
  entry: "judge", exit: "keep",
});
`, "utf8");
  const scene = await loadScene(f, registry);
  const first = await runScene(scene, "go", { answers: { draft: "seed" } });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.state["draft"], "seed!!!!!!!!", "the seed was improved until the target (length 12)");
  assert.equal((first.state["history"] as unknown[]).length, 9);

  // Run 2 starts from run 1's winner, aiming higher.
  const second = await runScene(
    { ...scene, nodes: { ...scene.nodes, keep: { ...scene.nodes["keep"]!, target: 15 } } },
    "go",
    { answers: { draft: String(first.state["draft"]) } },
  );
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.state["draft"], "seed!!!!!!!!!!!", "picked up where the last run left off");
  assert.equal((second.state["history"] as unknown[]).length, 4, "3 rounds of work, not 12 — the earlier gains were banked");
}
console.log("ok · 9 a seeded input is scored as the baseline, improved, and can seed the next run");

// ── 10 · stop and resume: the incumbent lives in state, so nothing is lost ──
{
  const f = loopScene("resume", [5, 9, 3, 4, 4], `candidate: "tagline", patience: 2`);
  const scene = await loadScene(f, registry);
  // Cut the run after the first keep (node runs: w j k w j k = 6), mid-loop.
  const stopped = await runScene(scene, "go", { maxNodeRuns: 7 });
  assert.equal(stopped.ok, false);
  assert.match(stopped.reason ?? "", /maxNodeRuns/);
  assert.equal(stopped.state["best"], 9);
  assert.equal(stopped.state["incumbent"], "attempt-2", "the winner is banked on the blackboard");

  const journal = readJournal(stopped.runDir);
  const resumed = await runScene(scene, "go", { resumeFrom: journal, maxNodeRuns: 50 });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.state["tagline"], "attempt-2", "the pre-stop winner survived two more reverts");
  assert.equal(resumed.state["best"], 9);
  assert.equal(resumed.state["converged"], true);
  assert.equal(resumed.runDir, stopped.runDir, "one continuous run");
}
console.log("ok · 10 a refine loop survives a stop and resume with its incumbent intact");

// ── 11 · decideRefine is pure: the same decision with no scene at all ──────
{
  const spec = { candidate: "draft", patience: 1 };
  const r1 = decideRefine("k", spec, { draft: "a", score: 3 });
  assert.equal(r1["verdict"], "baseline");
  const r2 = decideRefine("k", spec, { ...r1, draft: "b", score: 2 });
  assert.equal(r2["verdict"], "revert");
  assert.equal(r2["draft"], "a");
  assert.equal(r2["converged"], true, "patience 1: one miss converges");
  assert.match(String(r2["reason"]), /2 did not beat the incumbent's 3/);
  const tie = decideRefine("k", spec, { ...r1, draft: "c", score: 3 });
  assert.match(String(tie["reason"]), /tied the incumbent — a tie reverts/);
  assert.throws(() => decideRefine("k", spec, { score: 1 }), /nothing to refine: state has no "draft"/);
}
console.log("ok · 11 decideRefine is a pure function of the blackboard");

console.log("\nall refine tests pass");
