// Two questions about ask nodes, answered by experiment:
//   A) can an ask node be CONDITIONAL — only reached when the run warrants it?
//   B) can its question be fulfilled PROGRAMMATICALLY by an earlier node?
// Mocked OpenRouter; no spend.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScene } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene } from "../src/engine.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d, join as __j } from "node:path";
/** Repo root, so scenes written into temp dirs can import by absolute path. */
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const work = mkdtempSync(join(tmpdir(), "ensemble-cond-"));
process.chdir(work);

/** A scene where the human gate is reached ONLY when the checker says risky. */
const escalate = join(work, "escalate.mts");
writeFileSync(
  escalate,
  `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "escalate",
  defaults: { model: "openrouter/test/model" },
  nodes: {
    check:    { outputs: ["risk"] },
    approval: {
      runtime: "ask",
      question: "This looks risky. Approve anyway?",
      inputs: ["risk"],
      outputs: ["verdict"],
    },
    publish:  { inputs: ["risk"], outputs: ["published"] },
  },
  edges: [
    { from: "check", to: "approval", when: (s) => Number(s["risk"]) > 7 },
    { from: "check", to: "publish" },
    { from: "approval", to: "publish" },
  ],
  entry: "check",
  exit: "publish",
});
`,
  "utf8",
);

/** A scene where an EARLIER node fills the key the ask node collects. */
const auto = join(work, "auto.mts");
writeFileSync(
  auto,
  `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "auto",
  defaults: { model: "openrouter/test/model" },
  nodes: {
    judge:    { outputs: ["verdict"] },
    approval: { runtime: "ask", question: "Approve?", outputs: ["verdict"] },
    publish:  { inputs: ["verdict"], outputs: ["published"] },
  },
  edges: [{ from: "judge", to: "approval" }, { from: "approval", to: "publish" }],
  entry: "judge",
  exit: "publish",
});
`,
  "utf8",
);

let values: Record<string, unknown> = {};
const calls: string[] = [];
function mockFetch(): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
    const text = body.messages.map((m) => m.content).join("\n");
    const key = Object.keys(values).find((k) => text.includes(`"${k}"`)) ?? "x";
    calls.push(key);
    const answer = "```json\n" + JSON.stringify({ [key]: values[key] }) + "\n```";
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n` +
      `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.01 } })}\n\n` +
      `data: [DONE]\n\n`;
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) };
  }) as never;
}

const registry = loadRegistry();
const escalateScene = await loadScene(escalate, registry);
const autoScene = await loadScene(auto, registry);

// ── A1 · low risk → the human is never asked ───────────────────────────────
values = { risk: 3, published: "ok" };
calls.length = 0;
mockFetch();
const low = await runScene(escalateScene, "go", {});
assert.equal(low.ok, true, "low risk should run straight through to the exit");
assert.deepEqual(calls, ["risk", "published"], "approval was skipped entirely");
assert.equal(low.state["verdict"], undefined, "no verdict — nobody was asked");
console.log("ok · A1 conditional: risk=3 → gate skipped, run completed unattended");

// ── A2 · high risk → the same scene parks for a human ──────────────────────
values = { risk: 9, published: "ok" };
calls.length = 0;
mockFetch();
const high = await runScene(escalateScene, "go", {});
assert.equal(high.ok, false);
assert.ok("waiting" in high && high.waiting, "high risk must park on the gate");
assert.equal(high.waiting?.node, "approval");
assert.deepEqual(calls, ["risk"], "publish did NOT run — it is behind the gate");
console.log("ok · A2 conditional: risk=9 → same scene parked and asked");

// ── B · an earlier node fulfils the ask node's key → no pause ──────────────
values = { verdict: "approve", published: "ok" };
calls.length = 0;
mockFetch();
const filled = await runScene(autoScene, "go", {});
assert.equal(filled.ok, true, "a pre-filled key must satisfy the ask node");
assert.ok(!("waiting" in filled && filled.waiting), "it must not park");
assert.equal(filled.state["verdict"], "approve", "the model's verdict was used");
assert.deepEqual(calls, ["verdict", "published"], "the ask node made no call of its own");
console.log("ok · B programmatic: an agent node filled the key, ask fell through silently");

// ── B-caveat · presence, not usefulness, satisfies the gate ────────────────
values = { verdict: "", published: "ok" };
calls.length = 0;
mockFetch();
const empty = await runScene(autoScene, "go", {});
assert.equal(empty.ok, true, "an empty-string verdict still counts as answered");
assert.ok(!("waiting" in empty && empty.waiting));
console.log("ok · B-caveat: presence satisfies the gate — an empty answer does NOT re-ask");

console.log("\nconditional gating works; programmatic fulfilment works but is presence-based");
