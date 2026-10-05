// A run in progress, seen and stopped from outside (src/live.ts): the live file
// while it goes, a stop mark that cancels it, the record written when it ends,
// and the `status` / `stop` commands against a run started from a plain script.
// No decider is called: every decision in the fixture is a person's.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { liveRuns, RunFailed, runner, stopRun, tracked } from "../src/index.ts";
import refunds, { seen } from "./fixtures/refunds.mts";

const project = mkdtempSync(join(tmpdir(), "ensemble-live-"));
const dir = join(project, ".ensemble");
const recorded = (): string[] => (existsSync(join(dir, "runs")) ? readdirSync(join(dir, "runs")) : []);
const read = (id: string) => JSON.parse(readFileSync(join(dir, "runs", id, "run.json"), "utf8"));

// ── 1 · a tracked run is the same run: same call, same result, and its record on disk ─
{
  const { result, run } = await tracked(refunds, { dir })({ goal: "order A-1", amount: 3 });
  assert.equal(result, "paid: refund for order A-1 (3)");
  assert.deepEqual(recorded(), [run.run.id], "run.json is written where `ensemble run` writes it");
  assert.equal(read(run.run.id).run.status, "completed");
  assert.ok(existsSync(join(dir, "runs", run.run.id, "graph.json")));
  assert.deepEqual(liveRuns(dir), [], "and nothing is live once it has ended");

  const unrecorded = await tracked(refunds, { dir, record: false })({ goal: "order A-2" });
  assert.equal(recorded().includes(unrecorded.run.run.id), false, "record: false leaves the writing to the caller");
  assert.notEqual(unrecorded.run.run.id, run.run.id, "two runs in the same second have different ids");
}
console.log("ok · 1 tracked() returns what the runner returns, and records the run");

// ── 2 · while it runs, the live file says where it is; a stop mark cancels it ──
{
  const before = seen.aborted;
  const seenEvents: string[] = [];
  const going = tracked(refunds, { dir, file: "refunds.mts" })({ goal: "hang on", amount: 9 }, { onEvent: (event) => void seenEvents.push(event.type) });
  await new Promise((done) => setTimeout(done, 80));
  const [live] = liveRuns(dir);
  assert.ok(live, "the run is listed while it goes");
  assert.equal(live.pid, process.pid);
  assert.equal(live.runner, "refunds");
  assert.equal(live.file, "refunds.mts");
  assert.deepEqual(live.running, ["wait"], "the node in progress");
  assert.deepEqual(live.steps.map((step) => [step.node, step.took]), [["write", "e0"]]);
  assert.deepEqual(live.state, { goal: "hang on", amount: 9, draft: "refund for hang on (9)" }, "the state so far");

  assert.equal(await stopRun(live.id, { dir }), true, "asked to stop, and it did");
  const outcome = await going;
  assert.equal(outcome.run.run.status, "cancelled");
  assert.equal(seen.aborted, before + 1, "the handler was told through the run's own signal");
  assert.equal(read(outcome.run.run.id).run.status, "cancelled", "where it stopped is on record");
  assert.deepEqual(liveRuns(dir), []);
  assert.ok(seenEvents.includes("node:start"), "the caller's own onEvent still fires");
  assert.equal(await stopRun("nothing", { dir }), false);
}
console.log("ok · 2 a live run shows its nodes, steps and state, and stops when asked");

// ── 3 · a failure and a pause are recorded too; a caller's own signal still works ──
{
  const boom = runner({ name: "boom", work: { a: () => { throw new Error("handler broke"); } }, nodes: { one: { work: "a" } }, edges: [], entry: "one" });
  await assert.rejects(() => tracked(boom, { dir })({ goal: "g" }), RunFailed);
  const failed = recorded().find((id) => id.includes("-boom-"))!;
  assert.equal(read(failed).steps[0].error, "handler broke", "a failed run leaves its record");

  const paused = await tracked(refunds, { dir })({ goal: "ask about A-3" });
  assert.ok(existsSync(join(dir, "runs", paused.run.run.id, "paused.json")), "a paused run leaves the snapshot to resume from");
  const resumed = await tracked(refunds, { dir }).resume(paused.paused!, { answers: { ok: true, tier: "senior" } });
  assert.equal(resumed.result, "paid: refund for ask about A-3");
  assert.equal(resumed.run.run.id, paused.run.run.id, "one run across the pause, so one folder");

  const controller = new AbortController();
  const mine = tracked(refunds, { dir })({ goal: "hang mine" }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  assert.equal((await mine).run.run.status, "cancelled");

  // A file left behind by a process that died is not a live run.
  mkdirSync(join(dir, "live"), { recursive: true });
  writeFileSync(join(dir, "live", "999999-1.json"), JSON.stringify({ id: "999999-1", pid: 999999, runner: "ghost", status: "running", started: "2026-01-01T00:00:00.000Z", cost: 0, running: [], steps: [], state: {} }));
  assert.deepEqual(liveRuns(dir), []);
  assert.equal(existsSync(join(dir, "live", "999999-1.json")), false, "and it is cleaned up");
}
console.log("ok · 3 failures and pauses are recorded, and a dead process's file is not a live run");

// ── 4 · started from a plain script, watched and stopped with the CLI ───────
{
  const cli = resolve("src/cli.ts");
  writeFileSync(
    join(project, "run.mts"),
    `import { tracked } from ${JSON.stringify(resolve("src/index.ts"))};\nimport refunds from ${JSON.stringify(resolve("test/fixtures/refunds.mts"))};\n` +
      // The fixture's handler waits on nothing but its signal, so the script keeps itself alive; a real one waits on the network.
      `const alive = setInterval(() => {}, 1000);\nconst { run } = await tracked(refunds)({ goal: "hang in a script" });\nclearInterval(alive);\nconsole.log(run.run.status);\n`,
  );
  const child = spawn(process.execPath, ["run.mts"], { cwd: project, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += String(chunk)));
  let status: { live: Array<{ id: string; runner: string; running: string[] }>; recorded: Array<{ run: string; status: string }> } = { live: [], recorded: [] };
  for (let waited = 0; waited < 8_000 && !status.live.length; waited += 150) {
    await new Promise((done) => setTimeout(done, 150));
    status = JSON.parse(execFileSync(process.execPath, [cli, "status", "--json"], { cwd: project, encoding: "utf8" }));
  }
  assert.equal(status.live[0]?.runner, "refunds", "`ensemble status` sees a run it did not start");
  assert.deepEqual(status.live[0]!.running, ["wait"]);
  assert.ok(status.recorded.length >= 4, "next to what has already run here");
  assert.match(execFileSync(process.execPath, [cli, "status"], { cwd: project, encoding: "utf8" }), /live\n\s+\S+\s+refunds\s+at wait/);
  assert.equal(JSON.parse(execFileSync(process.execPath, [cli, "status", status.live[0]!.id], { cwd: project, encoding: "utf8" })).state.goal, "hang in a script");

  execFileSync(process.execPath, [cli, "stop", status.live[0]!.id], { cwd: project, stdio: "pipe" });
  // "close", not "exit": the last of its output has arrived by then.
  await new Promise((done) => child.on("close", done));
  assert.equal(out.trim(), "cancelled", "the script's run ended cancelled, and the script carried on");
  const after = JSON.parse(execFileSync(process.execPath, [cli, "status", "--json"], { cwd: project, encoding: "utf8" }));
  assert.deepEqual(after.live, []);
  assert.equal(after.recorded[0].status, "cancelled");
  assert.throws(() => execFileSync(process.execPath, [cli, "stop", "nope"], { cwd: project, stdio: "pipe" }), /no live run/);
}
console.log("ok · 4 a run started by `node run.mts` is watched and stopped with `ensemble status` and `ensemble stop`");

rmSync(project, { recursive: true, force: true });
console.log("4 cases");
