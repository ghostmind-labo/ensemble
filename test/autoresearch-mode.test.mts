// The sealed mode: research({ modify, evaluate, instruction }) and NOTHING else.
// Offline — the proposer is a mocked model, the evaluator is a real shell
// script with a known metric, so the whole loop is exercised for $0.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { research, ProgramError, isProgram, ITERATION_EDGE } from "../src/autoresearch.ts";
import { loadScene, validateSpec, SceneError } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene } from "../src/engine.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const registry = loadRegistry();
const refusal = (spec: object): string => {
  try { research(spec as never); return "NOT REFUSED"; }
  catch (e) { return e instanceof ProgramError ? e.problems.join("\n") : String(e); }
};

// ── 1 · exactly three things: each one required ────────────────────────────
const ok = { modify: "a.txt", evaluate: "true", instruction: "make it better" };
assert.match(refusal({ evaluate: "true", instruction: "x" }), /requires "modify" — the artefact under study/);
assert.match(refusal({ modify: "a", instruction: "x" }), /requires "evaluate" — the command that scores it/);
assert.match(refusal({ modify: "a", evaluate: "true" }), /requires "instruction" — the research directive/);
assert.match(refusal({ ...ok, instruction: "" }), /instruction/);
assert.match(refusal({ ...ok, modify: [] }), /modify/);
console.log("ok · 1 all three are mandatory");

// ── 2 · everything else is refused BY NAME, with the reason ────────────────
for (const [key, needle] of [
  ["nodes", /the loop is generated/],
  ["edges", /propose → evaluate → keep or revert/],
  ["entry", /measuring the baseline/],
  ["exit", /iteration budget/],
  ["groups", /compared one at a time/],
  ["state", /results are comparable/],
  ["defaults", /--model/],
  ["model", /--model/],
  ["prompt", /the directive is `instruction`/],
  ["iterations", /--iterations/],
  ["threshold", /--threshold/],
  ["goal", /the goal IS `instruction`/],
  ["name", /named by its file/],
  ["temperature", /exactly three things/],   // unlisted key still refused
] as const) {
  const out = refusal({ ...ok, [key]: key === "nodes" || key === "state" ? {} : "x" });
  assert.match(out, new RegExp(`does not accept "${key}"`), `${key} must be refused`);
  assert.match(out, needle, `${key} must explain why`);
  assert.match(out, /modify \(what may change\)/, "every refusal restates the three things");
}
console.log("ok · 2 every other key is refused by name, with a reason and the three-thing reminder");

// ── 3 · the generated loop is fixed and correct ────────────────────────────
{
  const s = research({ modify: ["x.py", "x.h"], evaluate: { command: "make bench", metric: "val_bpb", minimize: true, budget: "90s" }, instruction: "Lower the loss." });
  assert.deepEqual(Object.keys(s.nodes).sort(), ["evaluate", "propose"]);
  assert.equal(s.entry, "evaluate", "entry measures the BASELINE before anything is changed");
  assert.equal(s.nodes["propose"]!.runtime, "agent");
  assert.equal(s.nodes["evaluate"]!.runtime, "experiment");
  assert.deepEqual(s.research, { edit: ["x.py", "x.h"], measure: "make bench", metric: "val_bpb", minimize: true, budget: "90s", log: "results.tsv" });
  assert.equal(s.edges![ITERATION_EDGE]!.from, "evaluate", "--iterations targets the loop-back edge");
  assert.equal(s.edges![ITERATION_EDGE]!.maxLoops, 10);
  assert.ok(isProgram(s as never));
  // string form defaults
  const t = research({ ...ok });
  assert.equal(t.research!.budget, "5m", "Karpathy's fixed budget is the default");
  assert.equal(t.research!.minimize, undefined, "higher-is-better by default");
  // the directive is quoted verbatim into the proposer, plus fixed method
  const prompt = t.nodes["propose"]!.prompt!;
  assert.ok(prompt.includes("make it better"), "the instruction is inlined verbatim");
  assert.ok(prompt.includes("ONE focused"), "fixed method is not a variable between programs");
  assert.ok(prompt.includes("never special-case"), "guards against optimising the scorer");
  console.log("ok · 3 the generated loop is fixed: baseline first, one proposer, one evaluator");
}

// ── 4 · a program is an ordinary, valid Scene — no extra machinery ─────────
const work = mkdtempSync(join(tmpdir(), "ensemble-mode-"));
process.chdir(work);
writeFileSync(join(work, "heuristic.mjs"), "export const n = 2;\n", "utf8");
mkdirSync(join(work, "bin"), { recursive: true });
writeFileSync(join(work, "bin", "measure.sh"), `#!/bin/sh
n=$(grep -c . heuristic.mjs)
echo "score: $n"
`, "utf8");
writeFileSync(join(work, "prog.mts"), `import { research } from "${REPO}/src/index.ts";
export default research({
  modify: "heuristic.mjs",
  evaluate: { command: "sh bin/measure.sh", metric: "score" },
  instruction: "Add lines. More lines is better.",
});
`, "utf8");
const scene = await loadScene(join(work, "prog.mts"), registry);
assert.equal(scene.name, "autoresearch");
assert.ok(isProgram(scene), "loads and validates through the ordinary scene path");
console.log("ok · 4 a program file loads and validates as an ordinary scene");

// ── 5 · the loop runs: baseline → propose → keep/revert → results.tsv ──────
{
  // The proposer writes through the SCOPED tool. Its FIRST turn also tries to
  // rewrite the evaluator — the one attack the mode must make impossible — and
  // both calls go out together, so the refusal cannot cost it its real edit.
  const contents = ["a\nb\nc\n", "z\n"];
  let iteration = 0;
  let refusal = "";
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const last = body.messages.at(-1);
    const reply = (o: object) => ({ ok: true, json: async () => ({ ...o, usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }) });

    if (last.role === "tool") {
      for (const m of body.messages) {
        if (m.role === "tool" && String(m.content).includes("refused:")) refusal = String(m.content);
      }
      return reply({ choices: [{ message: { role: "assistant", content: '```json\n{"hypothesis":"more lines"}\n```' } }] });
    }

    const content = contents[iteration] ?? "q\n";
    const calls = [{ id: `w${iteration}`, function: { name: "write_file", arguments: JSON.stringify({ path: "heuristic.mjs", content }) } }];
    if (iteration === 0) {
      calls.unshift({ id: "cheat", function: { name: "write_file", arguments: JSON.stringify({ path: "bin/measure.sh", content: "cheat" }) } });
    }
    iteration++;
    return reply({ choices: [{ message: { role: "assistant", content: null, tool_calls: calls } }] });
  }) as never;

  scene.edges[ITERATION_EDGE]!.maxLoops = 2;   // what --iterations 2 does
  const run = await runScene(scene, "go", {});
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.match(refusal, /refused: research\.edit allows only "heuristic\.mjs"/,
    "the proposer cannot touch the evaluator, even when it tries");
  assert.equal(readFileSync(join(work, "bin", "measure.sh"), "utf8").includes("cheat"), false,
    "the scorer survived the attempt untouched");

  const rows = readFileSync(join(work, "results.tsv"), "utf8").trim().split("\n").slice(1).map((l) => l.split("\t"));
  assert.deepEqual(rows.map((r) => [r[1], r[3]]), [["1", "baseline"], ["3", "keep"], ["1", "revert"]]);
  assert.equal(readFileSync(join(work, "heuristic.mjs"), "utf8"), "a\nb\nc\n", "disk holds the best, not the last");
  assert.equal(run.state["best"], 3);
  console.log("ok · 5 the loop keeps the winner, reverts the rest, and the scorer is untouchable");
}

console.log("\nall autoresearch-mode tests pass");
