// Scene-level `defaults` that apply to every agent node.
//
// `defaults.tools` was accepted by the scene schema and documented but nothing
// ever read it — a scene-wide disarm silently did nothing; tests 1-4 are the
// regression for that. `defaults.skills` / `defaults.mcp` are the grant side:
// say it once for the scene instead of re-listing it on every node.
// Mocked fetch; no key, no spend.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScene } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene } from "../src/engine.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";

const work = mkdtempSync(join(tmpdir(), "ensemble-deftools-"));
process.chdir(work);

/** The tool names the agent runtime offered the model, one entry per call. */
let calls: string[][] = [];
const offered = (): string[] => calls.at(-1) ?? [];
let lastSystem = "";
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as {
    tools?: Array<{ function: { name: string } }>;
    messages: Array<{ role: string; content: string }>;
  };
  calls.push((body.tools ?? []).map((t) => t.function.name));
  lastSystem = body.messages.find((m) => m.role === "system")?.content ?? "";
  return {
    ok: true,
    json: async () => ({
      // Every key any node in this file declares, so one mock serves them all.
      choices: [{ message: { content: '```json\n{"x":"done","y":"done"}\n```' } }],
      usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0 },
    }),
  };
}) as never;

const sceneFile = (name: string, src: string): string => {
  const p = join(work, `${name}.mts`);
  writeFileSync(p, src, "utf8");
  return p;
};

const runWith = async (file: string): Promise<void> => {
  calls = [];
  const r = await runScene(await loadScene(file, loadRegistry()), "go", {});
  assert.equal(r.ok, true, JSON.stringify(r));
};

const AGENT = `{ runtime: "agent", outputs: ["x"] }`;

// ── 1 · baseline: with no `tools` map at all, every built-in is offered ─────
await runWith(sceneFile("all", `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "all",
  defaults: { model: "openrouter/test/model" },
  nodes: { n: ${AGENT} },
  entry: "n", exit: "n",
});
`));
assert.ok(offered().includes("grep"), "baseline offers grep");
assert.ok(offered().length >= 5, `baseline offers every built-in, got ${offered().join(",")}`);
const ALL = [...offered()];
console.log(`ok · 1 baseline offers all ${ALL.length} built-ins`);

// ── 2 · the bug: scene-level defaults.tools must actually disarm ────────────
await runWith(sceneFile("scenewide", `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "scenewide",
  defaults: { model: "openrouter/test/model", tools: { grep: false } },
  nodes: { a: ${AGENT}, b: { runtime: "agent", inputs: ["x"], outputs: ["y"] } },
  edges: [{ from: "a", to: "b" }],
  entry: "a", exit: "b",
});
`));
assert.equal(calls.length, 2, "both agent nodes ran");
for (const [i, names] of calls.entries()) {
  assert.ok(!names.includes("grep"), `node ${i} still offered grep — the disarm is not scene-wide`);
  assert.equal(names.length, ALL.length - 1, "exactly one tool removed, the rest untouched");
}
console.log("ok · 2 defaults.tools disarms scene-wide (was dead config)");

// ── 3 · a node can opt back in over the scene default ──────────────────────
await runWith(sceneFile("optin", `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "optin",
  defaults: { model: "openrouter/test/model", tools: { grep: false } },
  nodes: { n: { runtime: "agent", tools: { grep: true }, outputs: ["x"] } },
  entry: "n", exit: "n",
});
`));
assert.ok(offered().includes("grep"), "node-level true overrides the scene-level false");
console.log("ok · 3 node-level tools override the scene default");

// ── 4 · node-level false still works with no scene default present ─────────
await runWith(sceneFile("nodeoff", `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "nodeoff",
  defaults: { model: "openrouter/test/model" },
  nodes: { n: { runtime: "agent", tools: { grep: false }, outputs: ["x"] } },
  entry: "n", exit: "n",
});
`));
assert.ok(!offered().includes("grep"), "the original node-level opt-out is unregressed");
console.log("ok · 4 node-level opt-out unregressed");

// ── 5 · defaults.skills grants a skill to every agent node ─────────────────
mkdirSync(join(work, ".claude/skills/house-style"), { recursive: true });
writeFileSync(join(work, ".claude/skills/house-style/SKILL.md"),
  "---\nname: house-style\ndescription: the house style\n---\n\nAlways spell it GREY.\n", "utf8");

await runWith(sceneFile("grant", `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "grant",
  defaults: { model: "openrouter/test/model", skills: ["house-style"] },
  nodes: { n: ${AGENT} },
  entry: "n", exit: "n",
});
`));
assert.match(lastSystem, /Always spell it GREY/, "defaults.skills reached a node that never named it");
console.log("ok · 5 defaults.skills grants scene-wide without re-listing");

// ── 6 · node and scene grants UNION — a node widens, never replaces ────────
mkdirSync(join(work, ".claude/skills/sql-notes"), { recursive: true });
writeFileSync(join(work, ".claude/skills/sql-notes/SKILL.md"),
  "---\nname: sql-notes\ndescription: sql\n---\n\nPrefer CTEs.\n", "utf8");

await runWith(sceneFile("union", `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "union",
  defaults: { model: "openrouter/test/model", skills: ["house-style"] },
  nodes: { n: { runtime: "agent", skills: ["sql-notes"], outputs: ["x"] } },
  entry: "n", exit: "n",
});
`));
assert.match(lastSystem, /Always spell it GREY/, "the scene grant survives a node adding its own");
assert.match(lastSystem, /Prefer CTEs/, "the node's own skill is still there");
console.log("ok · 6 grants union — a node widens the scene floor, never replaces it");

// ── 7 · an unknown grant in defaults names DEFAULTS, not the innocent node ──
const { validateSpec, SceneError } = await import("../src/scene.ts");
let problems: string[] = [];
try {
  validateSpec({
    name: "bad", entry: "n", exit: "n",
    defaults: { model: "openrouter/test/model", skills: ["nope"] },
    nodes: { n: { runtime: "agent", outputs: ["x"] } },
  }, "x.mts", loadRegistry());
} catch (e) { problems = e instanceof SceneError ? e.problems : [String(e)]; }
assert.match(problems.join(";"), /defaults \(used by node "n"\) requests unknown skill "nope"/,
  "the error points at defaults, where the fix actually is");
console.log("ok · 7 an unknown grant blames defaults, not the node");

console.log("\nall scene-defaults tests pass");
