// End-to-end offline test of `ensemble mcp serve`: a real MCP Client talks to
// the real server over an InMemoryTransport pair; OpenRouter is mocked (SSE).
// Proves the agent workflow: run → status → peek → budget-stop → resume → done,
// plus stop_run on a live run. No network, no spend.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildEnsembleServer } from "../src/mcp-serve.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d, join as __j } from "node:path";
/** Repo root, so scenes written into temp dirs can import by absolute path. */
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";

// --- workspace with a 3-node scene ----------------------------------------
const work = mkdtempSync(join(tmpdir(), "ensemble-mcp-"));
const sceneFile = join(work, "chain.mts");
writeFileSync(
  sceneFile,
  `import { scene } from "${REPO}/src/index.ts";
export default scene({
  name: "chain",
  defaults: { model: "openrouter/test/model" },
  nodes: {
    one:   { outputs: ["a"] },
    two:   { inputs: ["a"], outputs: ["b"] },
    three: { inputs: ["b"], outputs: ["c"] },
  },
  edges: [{ from: "one", to: "two" }, { from: "two", to: "three" }],
  entry: "one",
  exit: "three",
});
`,
  "utf8",
);
process.chdir(work);

// --- SSE mock; optional per-call delay so stop_run can catch a live run ----
let delayMs = 0;
function mockFetch(): void {
  globalThis.fetch = (async (_url: string, init: { body: string; signal?: AbortSignal }) => {
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
    const text = body.messages.map((m) => m.content).join("\n");
    const key = /"([abc])"/.exec(text)?.[1] ?? "a";
    if (delayMs > 0) {
      await new Promise((r, reject) => {
        const t = setTimeout(r, delayMs);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    const answer = '```json\n{"' + key + '": "value-' + key + '"}\n```';
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n` +
      `data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.1 } })}\n\n` +
      `data: [DONE]\n\n`;
    return {
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse));
          c.close();
        },
      }),
    };
  }) as never;
}
mockFetch();

// --- wire a real client to the real server over memory --------------------
const server = buildEnsembleServer(work);
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "test-agent", version: "0" });
await client.connect(clientT);

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as Array<{ text: string }>)[0].text);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await pred()) return;
    await wait(50);
  }
  assert.fail(`timed out waiting for: ${what}`);
}

// ── 1 · tool discovery ─────────────────────────────────────────────────────
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["list_runs", "peek_state", "resume_run", "run_scene", "run_status", "stop_run", "validate_scene"]);
console.log("ok · 7 tools exposed:", tools.join(", "));

// ── 2 · validate_scene: good and bad ───────────────────────────────────────
const good = await call("validate_scene", { file: sceneFile });
assert.equal(good.valid, true);
assert.equal(good.nodes, 3);
const bad = await call("validate_scene", { file: join(work, "nope.mts") });
assert.equal(bad.valid, false);
console.log("ok · validate_scene reports valid and invalid scenes");

// ── 3 · run_scene returns immediately; budget stops it; status explains ────
const started = await call("run_scene", { file: sceneFile, goal: "go", budget: 0.1 });
assert.ok(started.runId, "runId returned");
await until(async () => (await call("run_status", { runId: started.runId })).status === "stopped", "budget stop");
const st = await call("run_status", { runId: started.runId });
assert.equal(st.position, "two", "stopped owing node two");
assert.match(st.stoppedBecause, /budget exhausted/);
assert.equal(st.resumable, true);
console.log("ok · run_scene async start; status: stopped at 'two', resumable, budget named");

// ── 4 · peek_state mid-lifecycle ───────────────────────────────────────────
const peek = await call("peek_state", { runId: started.runId, keys: ["a"] });
assert.equal(peek.state.a, "value-a");
const clipped = await call("peek_state", { runId: started.runId, maxChars: 3 });
assert.match(String(clipped.state.a), /… \[7 chars total\]/);
console.log("ok · peek_state reads the blackboard, key filter + clipping work");

// ── 5 · resume_run finishes it; cost is cumulative ─────────────────────────
const resumed = await call("resume_run", { runId: started.runId, budget: 1 });
assert.equal(resumed.resumed, true);
assert.equal(resumed.at, "two");
await until(async () => (await call("run_status", { runId: started.runId })).status === "completed", "resume completion");
const done = await call("run_status", { runId: started.runId });
assert.equal(done.nodeRuns, 3);
assert.ok(Math.abs(done.totalCost - 0.3) < 1e-9, `cumulative 0.3, got ${done.totalCost}`);
const finalState = await call("peek_state", { runId: started.runId });
assert.equal(finalState.state.c, "value-c");
console.log("ok · resume_run completed the graph; cost cumulative at $0.30");

// ── 6 · stop_run on a genuinely live run ───────────────────────────────────
delayMs = 30_000; // every model call now hangs until aborted
const slow = await call("run_scene", { file: sceneFile, goal: "slow one" });
assert.ok(slow.runId);
const running = await call("run_status", { runId: slow.runId });
assert.equal(running.status, "running");
const stopped = await call("stop_run", { runId: slow.runId });
assert.equal(stopped.stopped, true);
assert.equal(stopped.resumable, true);
await until(async () => (await call("run_status", { runId: slow.runId })).status === "stopped", "stop journalled");
delayMs = 0;
const rerun = await call("resume_run", { runId: slow.runId, budget: 1 });
assert.equal(rerun.resumed, true);
await until(async () => (await call("run_status", { runId: slow.runId })).status === "completed", "post-stop resume");
console.log("ok · stop_run aborted a live run safely; resume finished it");

// ── 7 · list_runs shows both, newest first ─────────────────────────────────
const list = await call("list_runs", {});
assert.equal(list.runs.length, 2);
assert.ok(list.runs.every((r: any) => r.status === "completed"));
console.log("ok · list_runs: 2 runs, both completed");

// ── 8 · error paths are clear ──────────────────────────────────────────────
const missing = await call("run_status", { runId: "20990101-000000-ghost" });
assert.match(missing.error, /no such run/);
const badResume = await call("resume_run", { runId: started.runId });
assert.match(badResume.error, /nothing left to resume/);
console.log("ok · unknown run and finished-run resume both fail clearly");

await client.close();
console.log("\nall mcp-serve tests pass");
process.exit(0);
