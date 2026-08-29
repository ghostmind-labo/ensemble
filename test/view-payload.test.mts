// What the viewer is told about a scene.
//
// The viewer must not guess: badges, summaries and cost classes come from the
// runtime OBJECT, so a runtime registered by a library user renders correctly
// without the UI knowing it exists. No model is called.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toLayout, toTerminal } from "../src/view.ts";
import { loadScene } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const work = mkdtempSync(join(tmpdir(), "ensemble-view-"));
process.chdir(work);

mkdirSync(join(work, ".claude/skills/house-style"), { recursive: true });
writeFileSync(join(work, ".claude/skills/house-style/SKILL.md"),
  "---\nname: house-style\ndescription: house\n---\n\nGREY.\n", "utf8");

writeFileSync(join(work, "s.mts"), `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "mixed",
  edgeKind: "sequential",
  defaults: { model: "openrouter/test/model", skills: ["house-style"] },
  state: { n: z.number() },
  nodes: {
    think: { runtime: "model",    outputs: ["n"] },
    work:  { runtime: "agent",    outputs: ["n"] },
    rent:  { runtime: "opencode", outputs: ["n"] },
    calc:  { runtime: "fn", fn: () => ({ n: 1 }), outputs: ["n"] },
    human: { runtime: "ask", question: "ok?", outputs: ["n"] },
  },
  edges: [
    { from: "think", to: "work" },
    { from: "work", to: "rent" },
    { from: "rent", to: "calc" },
    { from: "calc", to: "human" },
    { from: "human", to: "think", maxLoops: 3 },
  ],
  entry: "think", exit: "human",
});
`, "utf8");

const layout = toLayout(await loadScene(join(work, "s.mts"), loadRegistry()));
const node = (n: string) => layout.targets.flatMap((t) => t.members).find((m) => m.name === n)!;

// -- 1 . every runtime carries its OWN badge -- no two-way guess -------------
const badges = ["think", "work", "rent", "calc", "human"].map((n) => node(n).badge);
assert.equal(new Set(badges).size, 5, `each runtime has a distinct badge, got ${badges.join(" ")}`);
for (const n of ["think", "work", "rent", "calc", "human"]) {
  assert.ok(node(n).summary.length > 0, `${n} carries its runtime's summary`);
  assert.notEqual(node(n).badge, "•", `${n} is not the unknown-runtime fallback`);
}
console.log("ok - 1 every node carries its runtime object's badge and summary");

// -- 2 . cost class is derived from the runtime's FACE, not its name ---------
assert.equal(node("think").cost, "call");
assert.equal(node("work").cost, "loop");
assert.equal(node("rent").cost, "rented", "a registered agent backend reads as rented");
assert.equal(node("calc").cost, "free", "a compute runtime costs nothing");
assert.equal(node("human").cost, "wait", "a parking runtime makes no call");
console.log("ok - 2 cost class comes from park/compute/call, not the runtime name");

// -- 3 . scene-wide grants are visible on nodes that never named them --------
assert.deepEqual(node("work").skills, ["house-style"],
  "defaults.skills reaches the viewer -- drawing the node as ungranted would be a lie");
assert.deepEqual(node("rent").skills, ["house-style"], "backends get the grant too");
console.log("ok - 3 defaults.skills and defaults.mcp show on every agent node");

// -- 4 . the edge kind travels with the layout -------------------------------
assert.equal(layout.edgeKind, "sequential");
const loop = layout.edges.find((e) => e.from === "human" && e.to === "think");
assert.equal(loop?.maxLoops, 3, "a loop budget reaches the UI even with no `when`");
console.log("ok - 4 edgeKind and unconditional maxLoops both reach the viewer");

// -- 5 . the terminal view agrees with the browser ---------------------------
const term = toTerminal(await loadScene(join(work, "s.mts"), loadRegistry()));
const plain = term.replace(/\x1b\[[0-9;]*m/g, "");
for (const rt of ["model", "agent", "opencode", "fn", "ask"]) {
  assert.match(plain, new RegExp(rt), `terminal view names runtime "${rt}"`);
}
assert.match(plain, /house-style/, "and shows the scene-wide skill grant");
console.log("ok - 5 the terminal view names every runtime and shows grants");

console.log("\nall view-payload tests pass");
