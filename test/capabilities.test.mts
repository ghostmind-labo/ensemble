// The groundwork contract, applied to the SCENE level: a top-level block
// (like `research:`) is a mounted CapabilityObject. This test mounts a brand
// new one from library code — schema, checks, a contributed tool, guard
// tuning — with zero engine or validator edits. Offline; model mocked.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadScene, validateSpec, SceneError } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene } from "../src/engine.ts";
import { registerCapability, CAPABILITIES } from "../src/capabilities.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const registry = loadRegistry();
const problemsOf = (spec: unknown): string[] => {
  try { validateSpec(spec, "x.mts", registry); return []; }
  catch (e) { return e instanceof SceneError ? e.problems : [String(e)]; }
};

// ── 1 · a capability is ONE object handed to registerCapability ────────────
let tuneCalls = 0;
registerCapability<{ prefix: string }>({
  name: "stamp",
  summary: "hands agents a stamp tool and widens the node-run guard",
  schema: z.object({ prefix: z.string().min(1) }).strict(),
  check: (value, scene) =>
    Object.values(scene.nodes).some((n) => (n.runtime ?? scene.defaults.runtime ?? "model") === "agent")
      ? []
      : [`scene declares stamp but no node is runtime "agent" — nobody could use the tool`],
  tools: (value, { runDir }) => [{
    name: "stamp",
    description: "stamp a value",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: (args) => `${value.prefix}:${String(args["text"])}:${runDir ? "run-scoped" : "no-run"}`,
  }],
  tune: () => { tuneCalls++; return { maxNodeRuns: 777 }; },
});
assert.ok(CAPABILITIES["stamp"], "mounted");
assert.ok(CAPABILITIES["research"], "research is a mounted capability, not a special case");
console.log("ok · 1 capability mounted with registerCapability — research sits in the same registry");

// ── 2 · the validator speaks it: schema, checks, and strictness survives ───
const base = { name: "t", defaults: { model: "openrouter/a/b" }, entry: "a", exit: "a" };
const agentNode = { a: { runtime: "agent", outputs: ["out"] } };
assert.deepEqual(problemsOf({ ...base, stamp: { prefix: "S" }, nodes: agentNode }), []);
assert.match(problemsOf({ ...base, stamp: { prefix: "" }, nodes: agentNode }).join(";"), /stamp\.prefix/);
assert.match(problemsOf({ ...base, stamp: { prefix: "S", extra: 1 }, nodes: agentNode }).join(";"), /Unrecognized key/i);
assert.match(problemsOf({ ...base, stamp: { prefix: "S" }, nodes: { a: { outputs: ["out"] } } }).join(";"),
  /no node is runtime "agent"/);
assert.match(problemsOf({ ...base, unmounted: { x: 1 }, nodes: agentNode }).join(";"),
  /Unrecognized key/i, "an UNREGISTERED block is still a typo — strictness survives");
console.log("ok · 2 validator composes the scene surface from mounted capabilities; strict elsewhere");

// ── 3 · at run time: the tool reaches the agent, the tune reaches the guards ─
const work = mkdtempSync(join(tmpdir(), "ensemble-caps-"));
writeFileSync(join(work, "s.mts"), `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "stamped",
  defaults: { model: "openrouter/test/model" },
  // registered above in THIS process; scene() carries no type for it, which is fine
  ...( { stamp: { prefix: "SEAL" } } as object ),
  nodes: { a: { runtime: "agent", prompt: "Use the stamp tool once.", outputs: ["out"] } },
  entry: "a", exit: "a",
});
`, "utf8");
process.chdir(work);

let offeredTools: string[] = [];
let toolResult = "";
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  offeredTools = (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
  const last = body.messages.at(-1);
  const reply = last.role === "tool"
    ? (toolResult = last.content,
       { choices: [{ message: { role: "assistant", content: '```json\n{"out":"done"}\n```' } }],
         usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } })
    : { choices: [{ message: { role: "assistant", content: null, tool_calls: [
          { id: "c1", function: { name: "stamp", arguments: '{"text":"hello"}' } } ] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } };
  return { ok: true, json: async () => reply };
}) as never;

const run = await runScene(await loadScene(join(work, "s.mts"), registry), "go", {});
assert.equal(run.ok, true, JSON.stringify(run));
assert.ok(offeredTools.includes("stamp"), `capability tool offered to the agent (got: ${offeredTools.join(",")})`);
assert.ok(offeredTools.includes("read_file"), "built-ins still present alongside");
assert.equal(toolResult, "SEAL:hello:run-scoped", "the tool closed over the block value AND the runDir");
assert.ok(tuneCalls >= 1, "tune consulted for guard defaults");
console.log("ok · 3 capability tool + tuning reach the run — zero engine edits");

// ── 4 · per-node opt-out works on capability tools like any built-in ────────
writeFileSync(join(work, "optout.mts"), `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "optout",
  defaults: { model: "openrouter/test/model" },
  ...( { stamp: { prefix: "SEAL" } } as object ),
  nodes: { a: { runtime: "agent", tools: { stamp: false }, outputs: ["out"] } },
  entry: "a", exit: "a",
});
`, "utf8");
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  offeredTools = (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
  return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: '```json\n{"out":"x"}\n```' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }) };
}) as never;
const run2 = await runScene(await loadScene(join(work, "optout.mts"), registry), "go", {});
assert.equal(run2.ok, true);
assert.ok(!offeredTools.includes("stamp"), "tools: { stamp: false } removes the capability tool");
console.log("ok · 4 per-node tools opt-out applies to capability tools");

console.log("\nall capability tests pass");
