// The full object model: stores and tools are mountable objects, like runtimes.
// A custom store observes every artifact write; a registered tool is offered to
// agent nodes automatically. Mocked OpenRouter; no key, no spend.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScene } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene } from "../src/engine.ts";
import { fileRunStore, type RunStore } from "../src/store.ts";
import { registerTool, BUILTIN_TOOLS } from "../src/tools/builtin.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const work = mkdtempSync(join(tmpdir(), "ensemble-objects-"));
writeFileSync(join(work, "s.mts"), `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "objects",
  defaults: { model: "openrouter/test/model" },
  nodes: {
    digger: { runtime: "agent", prompt: "Use your tools.", outputs: ["found"] },
  },
  entry: "digger", exit: "digger",
});
`, "utf8");
process.chdir(work);

// ── 1 · a custom STORE wraps the file store and sees every artifact ────────
const seen: string[] = [];
const spyStore: RunStore = {
  name: "spy",
  // Wrapping means wrapping ALL of it: `prepare` is where the file store makes
  // the run directory, so a wrapper that skips it has nowhere to write.
  prepare: (d) => { seen.push("prepare"); fileRunStore.prepare?.(d); },
  writeState: (d, s) => { seen.push("state"); fileRunStore.writeState(d, s); },
  writeCosts: (d, c) => { seen.push("costs"); fileRunStore.writeCosts(d, c); },
  writeJournal: (d, j) => { seen.push("journal"); fileRunStore.writeJournal(d, j); },
  appendEvent: (d, e) => { seen.push(`event:${e.type}`); fileRunStore.appendEvent(d, e); },
  writeResult: (d, m) => { seen.push("result"); fileRunStore.writeResult(d, m); },
  recordIndex: (e) => { seen.push("index"); fileRunStore.recordIndex(e); },
};

// ── 2 · a custom TOOL is one object handed to registerTool ─────────────────
let toolRan = 0;
registerTool({
  name: "secret_word",
  description: "Returns the secret word. Call it.",
  inputSchema: { type: "object", properties: {} },
  run: async () => { toolRan++; return "the secret word is OBJECTLAND"; },
});
assert.ok(BUILTIN_TOOLS.some((t) => t.name === "secret_word"), "tool mounted");

// The mocked model: first turn calls the registered tool, second answers.
let turn = 0;
globalThis.fetch = (async (_u: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as { tools?: Array<{ function: { name: string } }> };
  turn++;
  if (turn === 1) {
    assert.ok(body.tools?.some((t) => t.function.name === "secret_word"),
      "the registered tool is OFFERED to the agent automatically");
    return { ok: true, json: async () => ({
      choices: [{ message: { role: "assistant", content: null,
        tool_calls: [{ id: "c1", function: { name: "secret_word", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.01 },
    }) };
  }
  return { ok: true, json: async () => ({
    choices: [{ message: { role: "assistant", content: '```json\n{"found":"OBJECTLAND"}\n```' } }],
    usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.01 },
  }) };
}) as never;

const run = await runScene(await loadScene(join(work, "s.mts"), loadRegistry()), "go", { store: spyStore });
assert.equal(run.ok, true, JSON.stringify(run));

// the tool actually executed, and its result reached the answer
assert.equal(toolRan, 1, "registered tool executed inside the agent loop");
assert.equal(run.state["found"], "OBJECTLAND");
console.log("ok · 1 registerTool: mounted, offered to the agent, executed, result used");

// the store saw the whole lifecycle, and the wrapped file store kept resume real
for (const mark of ["prepare", "index", "state", "costs", "journal", "result", "event:run:start", "event:run:end"]) {
  assert.ok(seen.includes(mark), `store observed ${mark}`);
}
assert.ok(existsSync(join(run.runDir, "journal.json")), "wrapping kept the files (resumability)");
console.log("ok · 2 custom store observed index/state/costs/journal/result and every event");

// ── 3 · sanity: the engine holds no runtime literals at all now ─────────────
import { readFileSync } from "node:fs";
const engine = readFileSync(join(REPO, "src", "engine.ts"), "utf8");
assert.ok(!/=== "(model|agent|ask)"/.test(engine), "engine is free of runtime name literals");
console.log("ok · 3 engine has zero runtime-name branches — objects all the way down");

console.log("\nall object-model tests pass");
