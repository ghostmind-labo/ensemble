// The built-in viewer (src/view.ts): what its page is given for recorded and
// live runs, that several runners and versions are told apart with no
// configuration, and that it is read-only. Run folders are written to a temp
// dir; the one live run is a real tracked run of the fixture.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopRun, tracked } from "../src/index.ts";
import { view } from "../src/view.ts";
import refunds from "./fixtures/refunds.mts";

type Json = Record<string, any>;
const project = mkdtempSync(join(tmpdir(), "ensemble-view-"));
const dir = join(project, ".ensemble");
const viewing = await view({ project, port: 0 });
const get = async (path: string): Promise<{ status: number; body: Json }> => {
  const response = await fetch(`${viewing.url}${path}`);
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json };
};
const step = (n: number, node: string, took: string | null, extra: Json = {}) => ({ n, node, kind: "work", lane: "main", started: "2026-01-01T00:00:00.000Z", ended: "2026-01-01T00:00:00.100Z", ms: 100, cost: 0.001, took, ...extra });
function write(id: string, run: { runner: string; hash: string; started: string; status?: string; steps: Json[]; state?: Json; pending?: Json; graph?: boolean }) {
  const folder = join(dir, "runs", id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "run.json"), JSON.stringify({ version: 1, run: { id, runner: run.runner, graph: run.hash, goal: run.state?.["goal"] ?? "", started: run.started, ended: run.started, status: run.status ?? "completed", cost: { total: run.steps.length * 0.001, currency: "USD" } }, steps: run.steps, state: run.state ?? {}, ...(run.pending ? { pending: run.pending } : {}) }));
  if (run.graph !== false) writeFileSync(join(folder, "graph.json"), JSON.stringify({ version: 1, runner: { name: run.runner, description: `${run.runner} runner`, hash: run.hash, entry: "a", inputs: ["goal", "amount"], result: "out" }, nodes: [{ id: "a" }, { id: "b" }], edges: [{ id: "e0", from: "a", to: "b" }], data: [] }));
}

// ── 1 · a project that has never run is an empty page, and it serves the page ──
{
  const empty = (await get("/api/overview")).body;
  assert.equal(empty.found, false);
  assert.deepEqual([empty.runs, empty.live, empty.runners], [[], [], []]);
  for (const path of ["/", "/anything/at/all"]) {
    const page = await fetch(`${viewing.url}${path}`);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /<title>ensemble · runs<\/title>/);
  }
  assert.match(viewing.url, /^http:\/\/127\.0\.0\.1:/, "bound to this machine unless told otherwise");
}
console.log("ok · 1 an empty project is an empty list, and every path is the one page");

write("r1", { runner: "triage", hash: "sha256:aaa", started: "2026-01-01T00:00:00.000Z", steps: [step(1, "a", "e0"), step(2, "b", null)], state: { goal: "charged twice", amount: 40, out: "→ billing", scratch: "x" } });
write("r2", { runner: "triage", hash: "sha256:bbb", started: "2026-01-02T00:00:00.000Z", status: "failed", steps: [step(1, "a", "e0", { error: "boom" })], state: { goal: "hello" } });
write("r3", { runner: "approvals", hash: "sha256:ccc", started: "2026-01-03T00:00:00.000Z", status: "paused", steps: [step(1, "a", "e0")], state: { goal: "refund A-1" }, pending: { node: "b", questions: [{ key: "ok", type: "noul", instructions: "Pay it?" }], asked: { goal: "refund A-1" } } });
write("r4", { runner: "triage", hash: "sha256:bbb", started: "2026-01-04T00:00:00.000Z", steps: [step(1, "a", "e0")], state: { goal: "again" }, graph: false });
mkdirSync(join(dir, "runs", "not-a-run"));
writeFileSync(join(dir, "runs", "stray.txt"), "x");

// ── 2 · runs newest first, read again on every request; runners and versions from the folders alone ──
{
  const { runs, runners } = (await get("/api/overview")).body;
  assert.deepEqual(runs.map((run: Json) => [run.id, run.version, run.status]), [["r4", 2, "completed"], ["r3", 1, "paused"], ["r2", 2, "failed"], ["r1", 1, "completed"]]);
  assert.equal(runs[1].ms, null, "a paused run has no duration yet");
  assert.deepEqual(runners.map((runner: Json) => [runner.name, runner.versions, runner.runs]), [["triage", 2, 3], ["approvals", 1, 1]], "grouped by name, most recently run first");

  const triage = (await get("/api/runner?name=triage")).body;
  assert.deepEqual(triage.versions, [{ version: 2, hash: "sha256:bbb", runs: 2 }, { version: 1, hash: "sha256:aaa", runs: 1 }]);
  assert.equal(triage.graph.runner.hash, "sha256:bbb", "the newest run that recorded a graph is the one drawn");
  assert.equal((await get("/api/runner?name=nope")).status, 404);
}
console.log("ok · 2 runs, runners and versions come from the run folders, with no configuration");

// ── 3 · one run: inputs and result picked by its graph, its failure, its pending question ──
{
  const run = (await get("/api/run?id=r1")).body;
  assert.deepEqual(run.inputs, { goal: "charged twice", amount: 40 }, "the keys the graph declares, not the whole state");
  assert.equal(run.result, "→ billing");
  assert.equal(run.graph.edges[0].id, run.steps[0].took, "steps[].took joins the run to graph.edges[].id");
  assert.equal((await get("/api/run?id=r2")).body.error, "boom");
  assert.equal((await get("/api/run?id=r3")).body.pending.node, "b");
  const bare = (await get("/api/run?id=r4")).body;
  assert.equal(bare.graph, null);
  assert.deepEqual(bare.inputs, { goal: "again" });
  assert.equal((await get("/api/run?id=nope")).status, 404);
}
console.log("ok · 3 a run is served with its inputs, result, failure and pending question");

// ── 4 · a live run: listed while it goes, with its nodes and state, drawn on the runner's last graph ──
{
  await tracked(refunds, { dir })({ goal: "order A-1" }); // one recorded run, so there is a graph to draw on
  const going = tracked(refunds, { dir })({ goal: "hang on", amount: 5 });
  await new Promise((done) => setTimeout(done, 80));
  const { live, runners } = (await get("/api/overview")).body;
  assert.equal(live.length, 1);
  assert.equal(live[0].status, "running");
  assert.equal(live[0].live, true);
  assert.equal(runners.find((runner: Json) => runner.name === "refunds").live, 1);

  const run = (await get(`/api/run?id=${encodeURIComponent(live[0].id)}`)).body;
  assert.deepEqual(run.running, ["wait"], "the node in progress");
  assert.deepEqual(run.steps.map((entry: Json) => [entry.n, entry.node, entry.took]), [[1, "write", "e0"]]);
  assert.equal(run.state.draft, "refund for hang on (5)", "the state so far");
  assert.equal(run.graph.runner.name, "refunds");
  assert.match(run.graphFrom, /latest recorded run/, "and it says whose graph that is");

  await stopRun(live[0].id.slice("live:".length), { dir });
  await going;
  const after = (await get("/api/overview")).body;
  assert.deepEqual(after.live, [], "once it ends it is no longer live");
  assert.equal(after.runs[0].status, "cancelled", "and its record is the newest run");
  assert.equal((await get(`/api/run?id=${encodeURIComponent(live[0].id)}`)).status, 404);
}
console.log("ok · 4 a live run is shown as it goes, then becomes its record");

// ── 5 · read-only ──────────────────────────────────────────────────────────
{
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await fetch(`${viewing.url}/api/run?id=r1`, { method })).status, 405);
  assert.equal((await get("/api/nope")).status, 404);
  await viewing.close();
}
console.log("ok · 5 nothing can be changed through it");

rmSync(project, { recursive: true, force: true });
console.log("5 cases");
