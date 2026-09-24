// A person in the loop: answering, pausing, resuming in another "process",
// budgets that survive a pause, answers that don't fit, and what happens when
// the decider cannot answer at all. Every decider and every person is a stub.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  choice,
  HumanAnswerError,
  noul,
  ResumeError,
  RunFailed,
  runner,
  supervise,
  validate,
  type Decider,
  type HumanRequest,
  type Paused,
  type RunEvent,
  type RunnerSpec,
} from "../src/index.ts";

/** A refund: drafted by code, approved by a person, then paid or declined. */
const approvals = (extra: Partial<RunnerSpec> = {}) =>
  runner({
    name: "approvals",
    inputs: ["goal", "amount"],
    work: {
      draft: ({ goal }) => `refund for ${goal}`,
      pay: ({ state }) => `paid: ${state["draft"]}`,
      decline: ({ state }) => `declined: ${state["reason"] ?? "no note"}`,
    },
    nodes: {
      write: { work: "draft", writes: ["draft"] },
      approve: {
        decide: {
          ok: noul("Should this refund be issued as drafted?"),
          tier: choice("Which approval tier applies?", { standard: null, senior: null }),
        },
        reads: ["goal", "draft", "amount"],
        by: "human",
        comment: "reason",
      },
      pay_it: { work: "pay", writes: ["outcome"] },
      say_no: { work: "decline", reads: ["reason"], writes: ["outcome"] },
    },
    edges: [
      { from: "write", to: "approve" },
      { from: "approve", to: "pay_it", on: "ok" },
      { from: "approve", to: "say_no" },
    ],
    entry: "write",
    result: "outcome",
    ...extra,
  });

// ── 1 · a person answers, and the run carries on ───────────────────────────
{
  let asked: HumanRequest | undefined;
  const { result, run, state } = await approvals()(
    { goal: "order A-104", amount: 40 },
    {
      human: (request) => ((asked = request), { answers: { ok: true, tier: "senior" }, by: "dana", comment: "  looks right " }),
    },
  );
  assert.equal(result, "paid: refund for order A-104");
  assert.deepEqual(asked!.questions.map((q) => [q.key, q.type]), [["ok", "noul"], ["tier", "choice"]], "the questions, in graph.json's readable form");
  assert.deepEqual(asked!.asked, { goal: "order A-104", draft: "refund for order A-104", amount: 40 }, "the person is shown the node's reads");

  const step = run.steps.find((s) => s.node === "approve")!;
  assert.deepEqual(step.meta, { by: "human", who: "dana" });
  assert.deepEqual(step.answers, { ok: { type: "noul", value: 1 }, tier: { type: "choice", value: "senior" } });
  assert.equal(step.answers!["ok"]!.confidence, undefined, "a person's answer claims no confidence");
  assert.equal(state["reason"], "looks right", "the note lands on its declared key, trimmed");
  assert.equal(step.took, "e1", "a yes is 1, so on: \"ok\" holds");
}
console.log("ok · 1 a person answers the same closed questions, and the run carries on");

// ── 2 · nobody to ask: the run pauses, cleanly ─────────────────────────────
let paused: Paused;
{
  const events: RunEvent[] = [];
  const outcome = await approvals()({ goal: "order B-7", amount: 900 }, { onEvent: (e) => void events.push(e) });
  assert.equal(outcome.run.run.status, "paused");
  assert.equal(outcome.result, undefined);
  assert.deepEqual(outcome.run.steps.map((s) => s.node), ["write"], "the waiting node is not a step until it is answered");
  assert.equal(outcome.run.pending!.node, "approve");
  assert.equal(outcome.run.pending!.comment, "reason", "a UI knows to offer a note");
  assert.equal(outcome.run.pending!.asked["amount"], 900);
  assert.equal(events.at(-1)!.type, "run:end", "a pause ends the run; it does not throw");
  assert.ok(outcome.paused);
  paused = JSON.parse(JSON.stringify(outcome.paused)) as Paused; // stored somewhere, read back later
}
console.log("ok · 2 without a person to ask, the run pauses and hands back a plain-JSON snapshot");

// ── 3 · resumed later, in "another process" ────────────────────────────────
{
  const { result, run } = await approvals().resume(paused, { answers: { ok: "no", tier: "standard" }, comment: "over the limit" });
  assert.equal(result, "declined: over the limit");
  assert.equal(run.run.id, paused.run.id, "one run, one id, across the pause");
  assert.deepEqual(run.steps.map((s) => [s.n, s.node]), [[1, "write"], [2, "approve"], [3, "say_no"]], "one continuous record");
  assert.equal(run.run.status, "completed");
  assert.equal(run.pending, undefined);
}
console.log("ok · 3 resume continues from the waiting node, as one continuous run");

// ── 4 · loop budgets survive a pause ───────────────────────────────────────
{
  let drafts = 0;
  const redraft = runner({
    name: "redraft",
    work: { draft: () => `draft ${++drafts}`, ship: () => "shipped", give_up: () => "a person rewrites it" },
    nodes: {
      write: { work: "draft", writes: ["text"] },
      review: { decide: { good: noul("Is this draft ready to send?") }, reads: ["text"], by: "human" },
      tally: { code: (s) => Number(s["rounds"] ?? 0) + 1, reads: ["rounds"], writes: ["rounds"] },
      send: { work: "ship", writes: ["outcome"] },
      stop: { work: "give_up", writes: ["outcome"] },
    },
    edges: [
      { from: "write", to: "review" },
      { from: "review", to: "send", on: "good" },
      { from: "review", to: "tally" },
      { from: "tally", to: "write", maxLoops: 1 },
      { from: "tally", to: "stop" },
    ],
    entry: "write",
    result: "outcome",
  });
  const first = await redraft({ goal: "x" });
  const second = await redraft.resume(JSON.parse(JSON.stringify(first.paused)), { answers: { good: false } });
  assert.equal(second.run.run.status, "paused", "round two, waiting again");
  const third = await redraft.resume(JSON.parse(JSON.stringify(second.paused)), { answers: { good: false } });
  assert.equal(third.result, "a person rewrites it", "the one allowed loop was spent before the second pause");
  assert.equal(drafts, 2);
}
console.log("ok · 4 a loop's budget is carried through every pause");

// ── 5 · an answer that does not fit is a bug, loudly — never a fallback ─────
{
  const withFallback = approvals();
  (withFallback.spec.nodes["approve"] as { fallback?: string }).fallback = "say_no";
  for (const [answer, pattern] of [
    [{ ok: "maybe", tier: "standard" }, /"ok" is yes or no, not "maybe"/],
    [{ ok: true, tier: "vip" }, /"tier" is one of standard, senior, not "vip"/],
    [{ ok: true }, /got no answer — answer every question: ok, tier/],
  ] as const) {
    const failed = await withFallback({ goal: "x", amount: 1 }, { human: () => ({ answers: answer }) }).catch((e: unknown) => e);
    assert.ok(failed instanceof RunFailed, "it fails the run…");
    assert.ok(failed.cause instanceof HumanAnswerError);
    assert.match(failed.message, pattern);
    assert.ok(!failed.run.steps.some((s) => s.took === "fallback"), "…and does not quietly take the fallback");
  }
}
console.log("ok · 5 a malformed answer fails the run by name, and never takes the fallback");

// ── 6 · a paused run refuses to resume on a different graph ────────────────
{
  // Valid, but different: the branches were rewired while the person was deciding.
  const changed = approvals({
    edges: [
      { from: "write", to: "approve" },
      { from: "approve", to: "say_no", on: "!ok" },
      { from: "approve", to: "pay_it" },
    ],
  });
  assert.deepEqual(changed.validate(), []);
  const refused = await changed.resume(paused, { answers: { ok: true, tier: "senior" } }).catch((e: unknown) => e);
  assert.ok(refused instanceof ResumeError);
  assert.match(refused.message, /the graph changed since this run paused/);

  const other = await runner({ name: "other", nodes: { a: { code: () => 1 } }, entry: "a" })
    .resume(paused, { answers: {} })
    .catch((e: unknown) => e);
  assert.match((other as Error).message, /paused in "approvals", not "other"/);
}
console.log("ok · 6 resume refuses a changed graph or the wrong runner, before anything runs");

// ── 7 · no answer at all becomes a route, when the node declares one ────────
{
  const flaky: Decider = async () => {
    throw new Error("jev: overloaded (HTTP 529)");
  };
  const triage = (fallback?: string) =>
    runner({
      name: "triage",
      work: { route: () => "routed", manual: () => "a person sorts it" },
      nodes: {
        classify: {
          decide: { team: choice("Which team?", { billing: null, orders: null }) },
          reads: ["goal"],
          ...(fallback ? { fallback } : {}),
        },
        to_team: { work: "route", writes: ["outcome"] },
        manual: { work: "manual", writes: ["outcome"] },
      },
      edges: [
        { from: "classify", to: "to_team", on: "team=billing" },
        { from: "classify", to: "manual", on: "team=orders" },
      ],
      entry: "classify",
      result: "outcome",
    });

  const { result, run } = await triage("manual")({ goal: "x" }, { decider: flaky });
  assert.equal(result, "a person sorts it");
  assert.equal(run.steps[0]!.took, "fallback");
  assert.match(run.steps[0]!.error!, /overloaded/, "and the record says why");
  assert.equal(run.run.status, "completed");

  assert.deepEqual(triage().validate(), [], "both variants are sound graphs");
  const failed = await triage()({ goal: "x" }, { decider: flaky }).catch((e: unknown) => e);
  assert.ok(failed instanceof RunFailed, "without a fallback, an outage still fails the run");
}
console.log("ok · 7 a decider outage takes the declared fallback, and the step says why");

// ── 8 · validate: the rules a person in the loop has to follow ─────────────
{
  const says = (spec: RunnerSpec, pattern: RegExp) => assert.ok(validate(spec).some((p) => pattern.test(p)), String(pattern));
  const base = (): RunnerSpec => structuredClone({ ...approvals().spec, work: undefined }) as RunnerSpec;
  const withWork = (spec: RunnerSpec) => ({ ...spec, work: approvals().spec.work });

  const gated = withWork(base());
  (gated.nodes["approve"] as { gate?: unknown }).gate = { on: "tier", min: 0.7, to: "say_no" };
  says(gated, /answered by a person and has a gate — a person's answer carries no confidence/);

  const robot = withWork(base());
  (robot.nodes["approve"] as { by?: string }).by = "robot";
  says(robot, /has by: "robot" — omit it for the decider, or write by: "human"/);

  const collide = withWork(base());
  (collide.nodes["approve"] as { comment?: string }).comment = "ok";
  says(collide, /writes its comment to "ok", which is also a question key/);

  const nowhere = withWork(base());
  (nowhere.nodes["approve"] as { fallback?: string }).fallback = "nobody";
  says(nowhere, /falls back to "nobody", which is not a node/);

  const lane: RunnerSpec = {
    name: "lane",
    nodes: {
      go: { code: () => 1, writes: ["k"] },
      ask: { decide: { yes: noul("Go ahead?") }, reads: ["k"], by: "human" },
      other: { code: () => 2, writes: ["y"] },
      meet: { code: () => 3, writes: ["z"], join: "all" },
    },
    edges: [
      { from: "go", to: "ask", fork: true },
      { from: "go", to: "other", fork: true },
      { from: "ask", to: "meet" },
      { from: "other", to: "meet" },
    ],
    entry: "go",
  };
  says(lane, /that lane asks a person at "ask" — a run can pause on only one lane/);
}
console.log("ok · 8 validate refuses a gate on a person, a stray comment, a bad fallback, and a person inside a fork");

// ── 9 · graph.json says where the people are ───────────────────────────────
{
  const graph = approvals().graph();
  const approve = graph.nodes.find((n) => n.id === "approve")!;
  assert.equal(approve.cost, "free", "a person costs no API money");
  assert.equal(approve.decide!.model, "human");
  assert.equal(approve.decide!.by, "human");
  assert.equal(approve.decide!.comment, "reason");
  const reason = graph.data.find((d) => d.key === "reason")!;
  assert.deepEqual(reason.producedBy, ["approve"], "the note has an origin, so validate can prove its readers");
}
console.log("ok · 9 graph.json marks the person, their note key, and costs them at $0");

// ── 10 · a person's wait is not a hung machine ─────────────────────────────
{
  const { result } = await approvals()(
    { goal: "x", amount: 1 },
    {
      stepTimeout: 20,
      human: () => new Promise((r) => setTimeout(() => r({ answers: { ok: true, tier: "standard" } }), 60)),
    },
  );
  assert.equal(result, "paid: refund for x", "stepTimeout bounds machines, not people");
}
console.log("ok · 10 stepTimeout does not cut off a person's answer");

// ── 11 · under supervise, a paused tick is parked, saved, and not a failure ─
{
  const dir = mkdtempSync(join(tmpdir(), "ensemble-human-"));
  try {
    const parked: Array<[number, Paused]> = [];
    const outcome = await supervise(approvals(), {
      next: ({ tick }) => (tick <= 2 ? { goal: `order ${tick}`, amount: 10 } : undefined),
      journal: dir,
      onPaused: (p, tick) => void parked.push([tick, p]),
    });
    assert.equal(outcome.status, "exhausted", "the loop did not wait for the person");
    assert.deepEqual(parked.map(([tick]) => tick), [1, 2]);
    assert.equal(outcome.vitals.waiting, 2);
    assert.equal(outcome.vitals.failed, 0, "waiting is not failing");
    assert.ok(existsSync(join(dir, "paused", "1.json")), "the snapshot is on disk too");

    const saved = JSON.parse(readFileSync(join(dir, "paused", "2.json"), "utf8")) as Paused;
    const { result } = await approvals().resume(saved, { answers: { ok: true, tier: "standard" } });
    assert.equal(result, "paid: refund for order 2", "and it can be answered later, outside the loop");

    const alerts: string[] = [];
    await supervise(approvals(), {
      next: ({ tick }) => (tick <= 1 ? { goal: "x", amount: 1 } : undefined),
      onAlert: ({ reason }) => void alerts.push(reason),
    });
    assert.match(alerts[0]!, /tick 1 is waiting for a person at "approve"/, "without onPaused, it is never silent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log("ok · 11 supervise parks a paused tick, saves it, and keeps going");

console.log("11 cases");
