// The point of the machine-level index: a viewer in project A can see a run that
// an agent started via MCP in project B. Mocked OpenRouter; no spend.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScene } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene } from "../src/engine.ts";
import { readIndex, indexPath, compactIndex } from "../src/index-file.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d, join as __j } from "node:path";
/** Repo root, so scenes written into temp dirs can import by absolute path. */
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
// Point the index at a temp file so the real ~/.ensemble is untouched.
const box = mkdtempSync(join(tmpdir(), "ensemble-index-"));
process.env.ENSEMBLE_INDEX = join(box, "index.jsonl");

function project(name: string, sceneBody: string): { root: string; scene: string } {
  const root = join(box, name);
  const dir = join(root, ".ensemble", "scenes");
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(root);
  const scene = join(dir, "s.mts");
  writeFileSync(scene, sceneBody, "utf8");
  return { root: real, scene };
}

const body = (name: string) => `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "${name}",
  defaults: { model: "openrouter/test/model" },
  nodes: { a: { outputs: ["out"] }, b: { inputs: ["out"], outputs: ["out2"] } },
  edges: [{ from: "a", to: "b" }],
  entry: "a", exit: "b",
});
`;

function mockFetch(cost = 0.02): void {
  globalThis.fetch = (async () => {
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: '```json\n{"out":"v","out2":"w"}\n```' } }] })}\n\n` +
      `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5, cost } })}\n\n` +
      `data: [DONE]\n\n`;
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) };
  }) as never;
}

// ── two separate projects, each running its own scene ──────────────────────
const alpha = project("alpha", body("alpha-scene"));
const beta = project("beta", body("beta-scene"));

process.chdir(alpha.root);
mockFetch();
const runA = await runScene(await loadScene(alpha.scene, loadRegistry()), "goal A", {});
assert.equal(runA.ok, true);

process.chdir(beta.root);
mockFetch();
const runB = await runScene(await loadScene(beta.scene, loadRegistry()), "goal B", {});
assert.equal(runB.ok, true);

// A budget-stopped run in beta, to prove status is read from the journal.
mockFetch(0.5);
const stopped = await runScene(await loadScene(beta.scene, loadRegistry()), "goal C", { budget: 0.01 });
assert.equal(stopped.ok, false);

// ── 1 · the index recorded all three, across both projects ─────────────────
assert.ok(existsSync(indexPath()), "index file written");
const entries = readIndex();
assert.equal(entries.length, 3, `expected 3 indexed runs, got ${entries.length}`);
const projects = new Set(entries.map((e) => e.project));
assert.equal(projects.size, 2, "two distinct projects indexed");
assert.ok(entries.every((e) => existsSync(join(e.runDir, "journal.json"))), "each entry points at a real journal");
console.log("ok · 1 index recorded 3 runs across 2 projects, each pointing at a real journal");

// ── 2 · newest first, and it is append-only JSONL (one line per run) ───────
const lines = readFileSync(indexPath(), "utf8").trim().split("\n");
assert.equal(lines.length, 3, "one line per run — append-only");
assert.ok(entries[0]!.startedAt >= entries[2]!.startedAt, "newest first");
console.log("ok · 2 append-only JSONL, newest first");

// ── 3 · a viewer in ALPHA can read BETA's run — the whole point ────────────
process.chdir(alpha.root);
const fromAlpha = readIndex();
const betaRun = fromAlpha.find((e) => e.project === beta.root && e.runId === stopped.runId);
assert.ok(betaRun, "alpha's viewer sees beta's run");
const journal = JSON.parse(readFileSync(join(betaRun!.runDir, "journal.json"), "utf8"));
assert.ok(journal.resumeAt, "and can tell it is resumable");
assert.match(journal.stoppedBecause, /budget/);
console.log("ok · 3 a viewer in project alpha reads project beta's run and its status");

// ── 4 · resume reuses the runId, so the list does not gain a duplicate ─────
process.chdir(beta.root);
mockFetch(0.001);
const { readJournal } = await import("../src/engine.ts");
const resumed = await runScene(await loadScene(beta.scene, loadRegistry()), "goal C", {
  resumeFrom: readJournal(stopped.runDir),
  budget: 5,
});
assert.equal(resumed.runId, stopped.runId, "resume keeps the id");
const afterResume = readIndex();
assert.equal(afterResume.length, 3, `resume must not add a row, got ${afterResume.length}`);
console.log("ok · 4 a resume updates its row instead of adding one (deduped by runId)");

// ── 5 · deleted run dirs drop out; compaction rewrites the file ────────────
rmSync(entries[0]!.runDir, { recursive: true, force: true });
assert.equal(readIndex().length, 2, "a deleted run dir is not listed");
const kept = compactIndex();
assert.equal(kept, 2);
assert.equal(readFileSync(indexPath(), "utf8").trim().split("\n").length, 2, "file compacted");
console.log("ok · 5 deleted runs drop out of the list and compaction shrinks the file");

console.log("\nall run-index tests pass");
