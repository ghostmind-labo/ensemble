// Research mode — the autoresearch loop, offline. The "model" is a mock that
// proposes edits through the scoped write tools; the measure command is a real
// shell script with a known metric. No key, no spend.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScene, validateSpec, SceneError } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene } from "../src/engine.ts";
import { parseMetric, parseBudget, researchTools } from "../src/research.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const registry = loadRegistry();
const problemsOf = (spec: unknown): string[] => {
  try { validateSpec(spec, "x.mts", registry); return []; }
  catch (e) { return e instanceof SceneError ? e.problems : [String(e)]; }
};

// ── 1 · metric parsing: last occurrence wins, several formats, JSON lines ──
assert.equal(parseMetric("step 1 val_bpb: 2.5\nstep 2 val_bpb: 1.25\n", "val_bpb"), 1.25);
assert.equal(parseMetric("val_bpb=0.9", "val_bpb"), 0.9);
assert.equal(parseMetric('{"val_bpb": 1.5, "other": 3}', "val_bpb"), 1.5);
assert.equal(parseMetric("loss 3.2\nscore -7\n"), -7, "no metric name: last number on the last line");
assert.equal(parseMetric("nothing here", "val_bpb"), undefined);
assert.equal(parseBudget("5m"), 300_000);
assert.equal(parseBudget("90s"), 90_000);
assert.equal(parseBudget(7), 7_000);
assert.throws(() => parseBudget("soon"), /not a duration/);
console.log("ok · 1 metric + budget parsing");

// ── 2 · validation: research needs its pieces, experiment needs research ───
const work = mkdtempSync(join(tmpdir(), "ensemble-research-"));
process.chdir(work);
writeFileSync(join(work, "prompt.md"), "Answer briefly.\n", "utf8");

const base = { name: "r", entry: "x", exit: "x" };
assert.match(problemsOf({ ...base, nodes: { x: { runtime: "experiment", outputs: ["verdict"] } } }).join(";"),
  /has no research block/);
assert.match(problemsOf({ ...base, research: { edit: "missing.md", measure: "true" }, nodes: { x: { runtime: "experiment", outputs: ["verdict"] } } }).join(";"),
  /does not exist/);
assert.match(problemsOf({ ...base, research: { edit: "prompt.md", measure: "true", budget: "soon" }, nodes: { x: { runtime: "experiment", outputs: ["verdict"] } } }).join(";"),
  /not a duration/);
assert.match(problemsOf({ ...base, research: { edit: "prompt.md", measure: "true" }, nodes: { x: { runtime: "fn", fn: () => ({ a: 1 }), outputs: ["a"] } } }).join(";"),
  /no node is runtime "experiment"/);
assert.match(problemsOf({ ...base, research: { edit: "prompt.md", measure: "true" }, nodes: { x: { runtime: "experiment" } } }).join(";"),
  /declares no outputs/);
assert.deepEqual(problemsOf({ ...base, research: { edit: "prompt.md", measure: "true", budget: "30s" }, nodes: { x: { runtime: "experiment", outputs: ["verdict"] } } }), []);
console.log("ok · 2 validation names every missing piece");

// ── 3 · the scoped write tools refuse everything but the artefact ──────────
{
  const tools = researchTools({ edit: "prompt.md", measure: "true" });
  const write = tools.find((t) => t.name === "write_file")!;
  const edit = tools.find((t) => t.name === "edit_file")!;
  await assert.rejects(async () => write.run({ path: "other.md", content: "x" }, work), /refused: research\.edit allows only "prompt\.md"/);
  await assert.rejects(async () => write.run({ path: "../escape.md", content: "x" }, work), /escapes the project root/);
  assert.equal(await edit.run({ path: "prompt.md", find: "nope", replace: "x" }, work), "snippet not found in prompt.md — read the file and copy the text exactly");
  await edit.run({ path: "prompt.md", find: "briefly", replace: "in one word" }, work);
  assert.equal(readFileSync(join(work, "prompt.md"), "utf8"), "Answer in one word.\n");
  assert.ok(!existsSync(join(work, "other.md")));
  console.log("ok · 3 write tools are scoped to research.edit");
}

// ── 4 · a full loop: baseline → propose → measure → keep/revert → log ───────
// The "measure" is a script that scores prompt.md by a rule the mock proposer
// sometimes satisfies and sometimes breaks: score = number of lines.
mkdirSync(join(work, "bin"), { recursive: true });
writeFileSync(join(work, "bin", "measure.sh"), `#!/bin/sh
n=$(wc -l < prompt.md | tr -d ' ')
echo "step 1 score: 0"
echo "score: $n"
`, "utf8");
writeFileSync(join(work, "prompt.md"), "one\ntwo\n", "utf8");

// The mock proposer: turn 1 calls a write tool, turn 2 answers with its json.
// Iteration A appends a line (improves: 2→3), iteration B replaces everything
// with one line (worse: 3→1 → must revert), iteration C ties (3 lines, revert).
const proposals = [
  { path: "prompt.md", content: "one\ntwo\nthree\n", hypothesis: "more lines" },
  { path: "prompt.md", content: "only\n", hypothesis: "shorter is better" },
  { path: "prompt.md", content: "a\nb\nc\n", hypothesis: "same length, new words" },
];
let calls = 0;
let sawWriteTool = false;
let sawEditTool = false;
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  const names = (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
  if (names.includes("write_file")) sawWriteTool = true;
  if (names.includes("edit_file")) sawEditTool = true;
  const last = body.messages.at(-1);
  let reply;
  if (last.role === "tool") {
    const p = proposals[calls - 1]!;
    reply = { choices: [{ message: { role: "assistant", content: "```json\n" + JSON.stringify({ hypothesis: p.hypothesis }) + "\n```" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } };
  } else {
    const p = proposals[calls++]!;
    reply = { choices: [{ message: { role: "assistant", content: null, tool_calls: [
      { id: `c${calls}`, function: { name: "write_file", arguments: JSON.stringify({ path: p.path, content: p.content }) } } ] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } };
  }
  return { ok: true, json: async () => reply };
}) as never;

writeFileSync(join(work, "loop.mts"), `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "loop",
  defaults: { model: "openrouter/test/model" },
  research: { edit: "prompt.md", measure: "sh bin/measure.sh", metric: "score", budget: "30s", threshold: 0 },
  state: { iteration: z.number(), verdict: z.enum(["baseline", "keep", "revert", "crash"]) },
  nodes: {
    propose: { runtime: "agent", prompt: "Improve prompt.md.", inputs: ["best", "verdict", "reason"], outputs: ["hypothesis"] },
    experiment: { runtime: "experiment", note: "hypothesis", outputs: ["iteration", "score", "best", "verdict", "reason"] },
  },
  edges: [
    { from: "experiment", to: "propose", when: (s) => s.iteration < 4 },
    { from: "propose", to: "experiment" },
  ],
  entry: "experiment", exit: "experiment",
});
`, "utf8");

const run = await runScene(await loadScene(join(work, "loop.mts"), registry), "maximise score", {});
assert.equal(run.ok, true, JSON.stringify(run));
assert.ok(sawWriteTool && sawEditTool, "research mode offers write_file and edit_file to the agent");
assert.equal(run.state["iteration"], 4);
assert.equal(run.state["best"], 3, "best is the 3-line version");
assert.equal(run.state["verdict"], "revert", "the tie reverted");
assert.equal(readFileSync(join(work, "prompt.md"), "utf8"), "one\ntwo\nthree\n", "disk holds the incumbent, not the reverted tie");

const tsv = readFileSync(join(work, "results.tsv"), "utf8").trim().split("\n");
assert.equal(tsv[0], "iteration\tscore\tbest\tverdict\tms\tnote");
const rows = tsv.slice(1).map((l) => l.split("\t"));
assert.deepEqual(rows.map((r) => [r[0], r[1], r[2], r[3], r[5]]), [
  ["1", "2", "2", "baseline", ""],
  ["2", "3", "3", "keep", "more lines"],
  ["3", "1", "3", "revert", "shorter is better"],
  ["4", "3", "3", "revert", "same length, new words"],
]);
assert.ok(existsSync(join(run.runDir, "research", "0-prompt.md")), "incumbent snapshot lives in the run dir");
console.log("ok · 4 full loop: baseline, keep, revert on worse, revert on tie, results.tsv audit trail");

// ── 5 · a crashing / silent measure is a failed experiment, and reverts ─────
writeFileSync(join(work, "bin", "measure.sh"), `#!/bin/sh\necho "boom" >&2; exit 1\n`, "utf8");
calls = 0;
proposals.length = 0;
proposals.push({ path: "prompt.md", content: "x\n", hypothesis: "crash it" });
writeFileSync(join(work, "crash.mts"), `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "crash",
  defaults: { model: "openrouter/test/model" },
  research: { edit: "prompt.md", measure: "sh bin/measure.sh", metric: "score", budget: "30s", log: "crash.tsv" },
  nodes: {
    seed: { runtime: "fn", fn: () => ({ best: 3, iteration: 1 }), outputs: ["best", "iteration"] },
    propose: { runtime: "agent", outputs: ["hypothesis"] },
    experiment: { runtime: "experiment", outputs: ["verdict", "reason"] },
  },
  edges: [{ from: "seed", to: "propose" }, { from: "propose", to: "experiment" }],
  entry: "seed", exit: "experiment",
});
`, "utf8");
const crash = await runScene(await loadScene(join(work, "crash.mts"), registry), "go", {});
assert.equal(crash.ok, true, JSON.stringify(crash));
assert.equal(crash.state["verdict"], "crash");
assert.match(String(crash.state["reason"]), /no "score" in the output \(exit 1\)/);
assert.equal(readFileSync(join(work, "prompt.md"), "utf8"), "one\ntwo\nthree\n", "crash restored the incumbent");
assert.match(readFileSync(join(work, "crash.tsv"), "utf8"), /\tcrash\t/);
console.log("ok · 5 a crashing measure reverts and is logged");

// ── 6 · the budget is enforced: overrun = crash, never a longer experiment ──
writeFileSync(join(work, "bin", "measure.sh"), `#!/bin/sh\nsleep 5; echo "score: 99"\n`, "utf8");
const { measure } = await import("../src/research.ts");
const slow = await measure({ edit: "prompt.md", measure: "sh bin/measure.sh", metric: "score", budget: "300ms" }, work);
assert.equal(slow.timedOut, true);
assert.equal(slow.score, undefined, "a late metric does not count");
assert.ok(slow.ms < 3000, "killed at the budget, not at completion");
console.log("ok · 6 the time budget is a hard cap");

console.log("\nall research-mode tests pass");
