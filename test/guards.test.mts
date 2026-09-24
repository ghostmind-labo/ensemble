// The proof, held at RUN time.
//
// `validate` proves the graph handles every declared answer. That proof is worth
// exactly what the answers are worth, and the cases here are the ones that used
// to slip past it and report success: a decider answering outside its own
// options, a noul band nobody wired, a pause beside a live lane, a snapshot that
// is not the plain JSON it claims to be. Each one ran, looked fine, and was
// wrong. Offline: every decider is a stub and every fetch is mocked.
import assert from "node:assert/strict";
import {
  catalog,
  choice,
  DeciderAnswerError,
  forgetCatalog,
  noul,
  RunFailed,
  runner,
  score,
  validate,
  type Decider,
  type RunnerSpec,
} from "../src/index.ts";

const says = (problems: string[], pattern: RegExp): boolean => problems.some((p) => pattern.test(p));

/** A decider that says exactly this, whatever it is asked. */
const saying = (answers: Record<string, unknown>): Decider =>
  async () => ({ model: "stub", answers: answers as never, usage: { input_tokens: 10, output_tokens: 0 }, cost: 0 });

const pick = (): RunnerSpec => ({
  name: "t",
  nodes: {
    ask: { decide: { kind: choice("Which?", { a: null, b: null }) }, reads: ["goal"] },
    a: { code: () => "did a", writes: ["out"] },
    b: { code: () => "did b", writes: ["out"] },
  },
  edges: [
    { from: "ask", to: "a", on: "kind=a" },
    { from: "ask", to: "b", on: "kind=b" },
  ],
  entry: "ask",
  result: "out",
});

// ── 1 · an answer outside the declared options fails at the fault ────────────
{
  const r = runner(pick());
  const good = await r({ goal: "x" }, { decider: saying({ kind: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } }) });
  assert.equal(good.result, "did a");

  const stray = saying({ kind: { type: "choice", choice: "c", confidence: 0.9, probabilities: { a: 0.9 } } });
  const failed = await r({ goal: "x" }, { decider: stray }).then(
    (out) => out,
    (error: unknown) => error,
  );
  assert.ok(failed instanceof RunFailed, `expected RunFailed, got ${JSON.stringify(failed)}`);
  assert.ok(failed.cause instanceof DeciderAnswerError, "the cause names the decider, not the graph");
  assert.match(failed.message, /"c" is not one of its options \(a, b\)/);
  assert.equal(failed.run.run.status, "failed", "and NOT completed — it used to exit quietly having run nothing");
}
console.log("ok · 1 a decider answering outside its options fails loudly");

// ── 2 · so does an answer with no value, or the wrong type ───────────────────
{
  const r = runner(pick());
  for (const [what, answers] of [
    ["no value at all", { kind: { type: "choice", confidence: 0.9, probabilities: { a: 1 } } }],
    ["a noul where a choice was asked", { kind: { type: "noul", noul: 0.9 } }],
    ["nothing for the key", {}],
  ] as const) {
    const error = await r({ goal: "x" }, { decider: saying(answers) }).then(() => undefined, (e: unknown) => e as RunFailed);
    assert.ok(error instanceof RunFailed, `${what} should fail the run`);
    assert.ok(error.cause instanceof DeciderAnswerError, `${what} is the decider's fault`);
  }
}
console.log("ok · 2 a missing or mistyped answer is the decider's fault, by name");

// ── 2b · but float slack at the top of a range is not a misfit ───────────────
{
  const scored: RunnerSpec = {
    name: "t",
    nodes: {
      rate: { decide: { level: score("How bad?", ["fine", "poor", "awful"]), sure: noul("Sure?") }, reads: ["goal"] },
      act: { code: () => "acted", writes: ["out"] },
    },
    edges: [{ from: "rate", to: "act" }],
    entry: "rate",
    result: "out",
  };
  // A score is Σ(level × P(level)) and a noul is a probability, so both can land
  // one ULP past the top of their range. That must not fail a run.
  const edge = saying({
    level: { type: "score", score: 2.0000000000000004, confidence: 0.9, probabilities: { "2": 1 }, legend: {} },
    sure: { type: "noul", noul: 1.0000000000000002 },
  });
  const out = await runner(scored)({ goal: "x" }, { decider: edge });
  assert.equal(out.result, "acted", "a float's last bit is not a wrong answer");

  const genuine = saying({
    level: { type: "score", score: 7, confidence: 0.9, probabilities: {}, legend: {} },
    sure: { type: "noul", noul: 0.5 },
  });
  const error = await runner(scored)({ goal: "x" }, { decider: genuine }).then(() => undefined, (e: unknown) => e as RunFailed);
  assert.ok(error instanceof RunFailed, "a level of 7 out of 0-2 is a real misfit");
  assert.match(error.message, /is not a level from 0 to 2/);
}
console.log("ok · 2b float slack is tolerated, a real out-of-range answer is not");

// ── 3 · a noul band nobody handles is proved, not discovered in production ───
{
  const spec = (edges: RunnerSpec["edges"]): RunnerSpec => ({
    name: "t",
    nodes: {
      ask: { decide: { sure: noul("Sure?") }, reads: ["goal"] },
      act: { code: () => 1 },
      hold: { code: () => 2 },
    },
    edges,
    entry: "ask",
  });

  assert.ok(
    says(validate(spec([{ from: "ask", to: "act", on: "sure>=0.7" }, { from: "ask", to: "hold", on: "sure>=0.99" }])), /nothing handles an answer of 0 up to 0.7/),
    "a lone high threshold drops everything below it",
  );
  assert.ok(
    says(validate(spec([{ from: "ask", to: "act", on: "sure>=0.7" }, { from: "ask", to: "hold", on: "!sure" }])), /nothing handles an answer of 0\.5 up to 0\.7/),
    "the sneaky one: a gap BETWEEN two edges that each look reasonable",
  );
  assert.ok(
    says(validate(spec([{ from: "ask", to: "act", on: "sure<=0.3" }, { from: "ask", to: "hold", on: "sure<=0.1" }])), /just above 0\.3/),
    "and the mirror image, open at the top",
  );

  for (const complete of [
    [{ from: "ask", to: "act", on: "sure" }, { from: "ask", to: "hold", on: "!sure" }],
    [{ from: "ask", to: "act", on: "sure>=0.7" }, { from: "ask", to: "hold", on: "sure<0.7" }],
    [{ from: "ask", to: "act", on: "sure>0.5" }, { from: "ask", to: "hold", on: "sure<=0.5" }],
    [{ from: "ask", to: "act", on: "sure>=0.7" }, { from: "ask", to: "hold" }],
  ] as RunnerSpec["edges"][]) {
    assert.deepEqual(validate(spec(complete)), [], `covered: ${JSON.stringify(complete)}`);
  }
}
console.log("ok · 3 a noul's 0-1 range must be covered, and complete cover is silent");

// ── 4 · a threshold in front of an exhaustive choice is an override, not a gap ─
{
  // The shape 04-robot uses: safety outranks the classifier. Crying wolf here
  // would be worse than the hole, so it must stay silent.
  const override: RunnerSpec = {
    name: "t",
    nodes: {
      ask: { decide: { hazard: noul("Hazard?"), action: choice("Do what?", { go: null, stop: null }) }, reads: ["goal"] },
      raise: { code: () => "raise" },
      go: { code: () => "go" },
      stop: { code: () => "stop" },
    },
    edges: [
      { from: "ask", to: "raise", on: "hazard>=0.6" },
      { from: "ask", to: "go", on: "action=go" },
      { from: "ask", to: "stop", on: "action=stop" },
    ],
    entry: "ask",
  };
  assert.deepEqual(validate(override), [], "an exhaustive choice keeps the run on the graph");
}
console.log("ok · 4 a priority threshold over an exhaustive choice is not reported");

// ── 5 · a collision hidden past a NESTED join is caught ─────────────────────
{
  const nested: RunnerSpec = {
    name: "t",
    nodes: {
      top: { code: () => "top" },
      x: { code: () => 1, writes: ["kx"] },
      y: { code: () => 2, writes: ["ky"] },
      IJ: { join: "all", code: () => 3, writes: ["kij"] },
      afterIJ: { code: () => "A", writes: ["shared"] },
      b: { code: () => "B", writes: ["kb"] },
      bb: { code: () => "B2", writes: ["shared"] },
      END: { join: "all", code: () => "end" },
    },
    edges: [
      { from: "top", to: "x", fork: true },
      { from: "top", to: "b", fork: true },
      { from: "x", to: "y" },
      { from: "x", to: "IJ" },
      { from: "y", to: "IJ" },
      { from: "IJ", to: "afterIJ" },
      { from: "afterIJ", to: "END" },
      { from: "b", to: "bb" },
      { from: "bb", to: "END" },
    ],
    entry: "top",
  };
  // The lane walk used to stop at the first join it met, so "afterIJ" and
  // everything past the NESTED join escaped the disjointness proof entirely.
  assert.ok(says(validate(nested), /both touch "shared"/), validate(nested).join("\n"));
}
console.log("ok · 5 lanes are proved disjoint past a nested join, not up to it");

// ── 6 · a pause never abandons a lane that is still running ─────────────────
{
  const forked: RunnerSpec = {
    name: "t",
    work: { slow: async () => { await new Promise((r) => setTimeout(r, 60)); return "slow"; } },
    nodes: {
      top: { code: () => "top" },
      p: { code: () => "p" },
      q: { code: () => "q" },
      J1: { join: "all", code: () => "j1" },
      J2: { join: "all", code: () => "j2" },
      r: { code: () => "r" },
      s: { code: () => "s" },
      ask: { decide: { ok: noul("OK?") }, reads: ["goal"], by: "human" },
      after: { code: () => "after" },
      slow: { work: "slow", writes: ["slowOut"] },
      tail: { code: () => "tail" },
    },
    edges: [
      { from: "top", to: "p", fork: true },
      { from: "top", to: "q", fork: true },
      { from: "top", to: "r", fork: true },
      { from: "top", to: "s", fork: true },
      { from: "p", to: "J1" },
      { from: "q", to: "J1" },
      { from: "r", to: "J2" },
      { from: "s", to: "J2" },
      { from: "J1", to: "ask" },
      { from: "ask", to: "after", on: "ok" },
      { from: "ask", to: "after", on: "!ok" },
      { from: "J2", to: "slow" },
      { from: "slow", to: "tail" },
    ],
    entry: "top",
  };
  // Two joins become ready together, so two lanes genuinely run at once and one
  // of them wants to pause. It used to pause, abort its sibling, and report a
  // clean "paused" run with a node that never executed and could never be reached.
  const error = await runner(forked)({ goal: "x" }).then(() => undefined, (e: unknown) => e as RunFailed);
  assert.ok(error instanceof RunFailed, "pausing beside a live lane must not look like a clean pause");
  assert.match(error.message, /other lane/);
  assert.match(error.message, /Move the question after the join/);
  assert.equal(error.run.run.status, "failed");
  assert.equal(error.run.pending, undefined, "and hands back no `pending` nobody could act on");
}
console.log("ok · 6 a run refuses to pause while another lane is running");

// ── 7 · the snapshot is the plain JSON it says it is ────────────────────────
{
  const dated: RunnerSpec = {
    name: "t",
    nodes: {
      seed: { code: () => new Date("2020-01-02T03:04:05Z"), writes: ["at"] },
      ask: { decide: { ok: noul("OK?") }, reads: ["goal"], by: "human" },
      use: { code: (s) => `${typeof s["at"]}`, reads: ["at"], writes: ["used"] },
    },
    edges: [
      { from: "seed", to: "ask" },
      { from: "ask", to: "use", on: "ok" },
      { from: "ask", to: "use", on: "!ok" },
    ],
    entry: "seed",
    result: "used",
  };
  const r = runner(dated);
  const out = await r({ goal: "x" });
  assert.ok(out.paused, "no human handler means a pause");
  assert.equal(typeof out.paused.state["at"], "string", "a Date is already an ISO string in the snapshot");

  // Resumed in this process and resumed from a file must compute the same thing.
  const here = await r.resume(out.paused, { answers: { ok: "yes" } });
  const viaFile = await r.resume(JSON.parse(JSON.stringify(out.paused)), { answers: { ok: "yes" } });
  assert.equal(here.result, viaFile.result, "the store must not change the answer");
  assert.equal(here.result, "string");

  // And a value JSON cannot carry fails AT the pause, naming the key.
  const bad: RunnerSpec = { ...dated, nodes: { ...dated.nodes, seed: { code: () => 10n, writes: ["at"] } } };
  const error = await runner(bad)({ goal: "x" }).then(() => undefined, (e: unknown) => e as Error);
  assert.ok(error instanceof TypeError, "an unserialisable state must not pause happily and explode later");
  assert.match(error.message, /"at" holds something JSON cannot carry/);
}
console.log("ok · 7 a paused snapshot is plain JSON, or it says which key is not");

// ── 8 · a cancelled run stops the decider instead of abandoning it ──────────
{
  let aborted = false;
  let finished = false;
  const slow: typeof globalThis.fetch = (_url, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finished = true;
        resolve(new Response(JSON.stringify({ model: "jev-1", answers: { kind: { type: "choice", choice: "a", confidence: 1, probabilities: { a: 1 } } }, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } }));
      }, 400);
      (init as RequestInit | undefined)?.signal?.addEventListener("abort", () => {
        aborted = true;
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });

  const r = runner({ ...pick(), jev: { apiKey: "test", fetch: slow } });
  const stop = new AbortController();
  setTimeout(() => stop.abort(new Error("caller hung up")), 50);
  const began = Date.now();
  const out = await r({ goal: "x" }, { signal: stop.signal });

  assert.equal(aborted, true, "the decider's own request must be cancelled, not merely abandoned");
  assert.equal(finished, false, "it must not run on past the end of the run, spending on an answer nobody reads");
  assert.ok(Date.now() - began < 350, `the run should not wait out the call it cancelled (took ${Date.now() - began}ms)`);
  assert.equal(out.run.run.status, "cancelled", "and the reason is cancellation, not a failure invented on top of it");
}
console.log("ok · 8 cancelling a run cancels the decider's request");

// ── 9 · the catalogue is cached per source, not once per process ────────────
{
  forgetCatalog();
  const serving = (id: string): typeof globalThis.fetch =>
    async () => new Response(JSON.stringify({ data: [{ id }] }), { status: 200, headers: { "content-type": "application/json" } });

  let calls = 0;
  const clientA: typeof globalThis.fetch = async (...args) => (calls++, serving("tenant-a/model")(...args));

  const a = await catalog({ fetch: clientA, baseUrl: "https://a.example" });
  const b = await catalog({ fetch: serving("tenant-b/model"), baseUrl: "https://b.example" });
  assert.deepEqual(a.map((m) => m.id), ["tenant-a/model"]);
  assert.deepEqual(b.map((m) => m.id), ["tenant-b/model"], "one process serving two sources must not share one catalogue");

  // The same client on the same base is still one fetch, TTL permitting.
  const again = await catalog({ fetch: clientA, baseUrl: "https://a.example" });
  assert.deepEqual(again.map((m) => m.id), ["tenant-a/model"]);
  assert.equal(calls, 1, "the same source is still cached");
  forgetCatalog();
}
console.log("ok · 9 the model catalogue is cached per source");

// ── 10 · a loop budget that can never be met is an edge that does not exist ──
{
  const looping = (maxLoops: unknown): RunnerSpec => ({
    name: "t",
    nodes: { a: { code: () => 1, writes: ["n"] }, b: { code: () => 2 } },
    edges: [{ from: "a", to: "b", maxLoops: maxLoops as number }],
    entry: "a",
  });
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.ok(says(validate(looping(bad)), /maxLoops is .* whole number of 1 or more/), `maxLoops: ${bad}`);
  }
  assert.deepEqual(validate(looping(1)), []);
  assert.deepEqual(validate(looping(undefined)), [], "and no limit is the default");
}
console.log("ok · 10 maxLoops must be a whole number of 1 or more");

// ── 11 · a declared comment key is always written, note or no note ──────────
{
  const noting: RunnerSpec = {
    name: "t",
    nodes: {
      ask: { decide: { ok: noul("OK?") }, reads: ["goal"], by: "human", comment: "why" },
      use: { code: (s) => `note:${JSON.stringify(s["why"])}`, reads: ["why"], writes: ["out"] },
    },
    edges: [
      { from: "ask", to: "use", on: "ok" },
      { from: "ask", to: "use", on: "!ok" },
    ],
    entry: "ask",
    result: "out",
  };
  const r = runner(noting);
  assert.deepEqual(validate(noting), [], "a comment key is a write, so a node downstream may read it");

  // graph.json promises "why" has a producer, and validate lets "use" read it.
  // A person who skips the box must therefore not leave it undefined.
  const skipped = await r({ goal: "x" }, { human: () => ({ answers: { ok: true } }) });
  assert.equal(skipped.result, 'note:""');
  const wrote = await r({ goal: "x" }, { human: () => ({ answers: { ok: true }, comment: "  fix the tone  " }) });
  assert.equal(wrote.result, 'note:"fix the tone"', "and a note is trimmed");
}
console.log("ok · 11 a declared comment key is written even when the person skips it");

console.log("12 cases");
