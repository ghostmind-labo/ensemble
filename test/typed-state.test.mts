// Typed state: does a zod schema on the scene actually (a) get shown to the
// model, (b) reject wrong shapes, (c) self-correct on the retry, and (d) leave
// unschema'd scenes untouched? Mocked OpenRouter; no spend.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Imported from ensemble, not "zod" — proving the re-export works from a
// directory with no node_modules, which is exactly how scenes are authored.
import { z } from "../src/index.ts";
import { loadScene } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene } from "../src/engine.ts";
import { outputContract, extractOutputs, describeSchema } from "../src/state.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d, join as __j } from "node:path";
/** Repo root, so scenes written into temp dirs can import by absolute path. */
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const work = mkdtempSync(join(tmpdir(), "ensemble-typed-"));
process.chdir(work);

// ── 1 · schemas render as readable shapes (this is what the model sees) ─────
assert.equal(describeSchema(z.string()), "string");
assert.equal(describeSchema(z.number().min(0).max(10)), "number (0-10)");
assert.equal(describeSchema(z.enum(["low", "high"])), '"low" | "high"');
assert.equal(describeSchema(z.array(z.string())), "array of string");
assert.equal(
  describeSchema(z.object({ file: z.string(), severity: z.enum(["low", "high"]) })),
  '{ file: string, severity: "low" | "high" }',
);
assert.equal(describeSchema(z.string().describe("the reason")), "string — the reason");
assert.equal(describeSchema(z.array(z.object({ a: z.number() }))), "array of { a: number }");
assert.equal(describeSchema({ not: "a schema" }), "value", "unknown shapes degrade, never throw");
console.log("ok · 1 schemas render as compact prose shapes");

// ── 2 · the contract embeds the shape, not just the key name ────────────────
const contract = outputContract(["score", "verdict"], {
  score: z.number().min(0).max(10),
  verdict: z.enum(["accept", "reject"]),
});
assert.match(contract, /"score": number \(0-10\)/);
assert.match(contract, /"verdict": "accept" \| "reject"/);
assert.match(contract, /REQUIRED, not suggestions/);
// Without schemas the old contract is unchanged.
assert.match(outputContract(["a"]), /"a": \.\.\./);
assert.ok(!outputContract(["a"]).includes("REQUIRED, not suggestions"));
console.log("ok · 2 contract shows required shapes; unschema'd contract unchanged");

// ── 3 · extraction rejects wrong shapes with an actionable path ─────────────
const schema = {
  score: z.number().min(0).max(10),
  verdict: z.enum(["accept", "reject"]),
  findings: z.array(z.object({ file: z.string(), severity: z.enum(["low", "high"]) })),
};
const bad = extractOutputs('```json\n{"score":"banana","verdict":"maybe"}\n```', ["score", "verdict"], schema);
assert.equal(bad.ok, false, "a string where a number is required must fail");
assert.match(bad.problem!, /score: /);
assert.match(bad.problem!, /verdict: /);
console.log("ok · 3 wrong shapes rejected, problem names each bad key:", JSON.stringify(bad.problem?.slice(0, 90)));

// nested paths are reported precisely
const nested = extractOutputs(
  '```json\n{"findings":[{"file":"a.ts","severity":"nope"}]}\n```',
  ["findings"],
  schema,
);
assert.equal(nested.ok, false);
assert.match(nested.problem!, /findings\.0\.severity/, "nested path must be named");
console.log("ok · 3b nested failures name the exact path (findings.0.severity)");

// ── 4 · valid values pass, and the PARSED value lands in state ──────────────
const good = extractOutputs('```json\n{"score":8,"verdict":"accept"}\n```', ["score", "verdict"], schema);
assert.equal(good.ok, true);
assert.equal(good.values["score"], 8);
assert.equal(typeof good.values["score"], "number");
// Unschema'd keys are passed through untouched.
const passthrough = extractOutputs('```json\n{"anything":{"x":1}}\n```', ["anything"], schema);
assert.equal(passthrough.ok, true);
assert.deepEqual(passthrough.values["anything"], { x: 1 });
console.log("ok · 4 valid values pass; keys with no schema pass through untouched");

// ── 5 · end to end: a model emits the wrong shape, then self-corrects ───────
const sceneFile = join(work, "typed.mts");
writeFileSync(
  sceneFile,
  `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "typed",
  defaults: { model: "openrouter/test/model" },
  state: {
    score:   z.number().min(0).max(10),
    verdict: z.enum(["accept", "reject"]),
  },
  nodes: { judge: { outputs: ["score", "verdict"] } },
  entry: "judge",
  exit: "judge",
});
`,
  "utf8",
);

const prompts: string[] = [];
let attempt = 0;
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
  prompts.push(body.messages.map((m) => m.content).join("\n"));
  attempt++;
  // First reply is deliberately the WRONG shape; second is correct.
  const payload =
    attempt === 1 ? '{"score":"very high","verdict":"maybe"}' : '{"score":9,"verdict":"accept"}';
  const sse =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "```json\n" + payload + "\n```" } }] })}\n\n` +
    `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.01 } })}\n\n` +
    `data: [DONE]\n\n`;
  return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) };
}) as never;

const scn = await loadScene(sceneFile, loadRegistry());
assert.ok(scn.state, "the scene's state schema survived validation");
const run = await runScene(scn, "judge it", {});

assert.equal(run.ok, true, `should self-correct, got ${JSON.stringify(run)}`);
assert.equal(run.state["score"], 9);
assert.equal(typeof run.state["score"], "number", "state holds a real number, not a string");
assert.equal(run.state["verdict"], "accept");
assert.equal(attempt, 2, "exactly one retry");
// The first prompt showed the shape; the retry carried the validation failure.
assert.match(prompts[0]!, /number \(0-10\)/, "shape was shown up front");
assert.match(prompts[1]!, /do not match the required shape/, "retry explained the mismatch");
assert.match(prompts[1]!, /score: /, "retry named the offending key");
console.log("ok · 5 end-to-end: wrong shape → retry with the reason → correct value in state");

// ── 6 · an existing scene with no `state` behaves exactly as before ─────────
const plainFile = join(work, "plain.mts");
writeFileSync(
  plainFile,
  `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "plain",
  defaults: { model: "openrouter/test/model" },
  nodes: { a: { outputs: ["anything"] } },
  entry: "a", exit: "a",
});
`,
  "utf8",
);
attempt = 5; // force the "correct" branch
globalThis.fetch = (async () => {
  const sse =
    `data: ${JSON.stringify({ choices: [{ delta: { content: '```json\n{"anything":"whatever"}\n```' } }] })}\n\n` +
    `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.01 } })}\n\n` +
    `data: [DONE]\n\n`;
  return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) };
}) as never;
const plain = await runScene(await loadScene(plainFile, loadRegistry()), "go", {});
assert.equal(plain.ok, true, "a scene with no state schema still runs");
assert.equal(plain.state["anything"], "whatever");
console.log("ok · 6 scenes without `state` are unaffected — the feature is additive");

console.log("\nall typed-state tests pass");
