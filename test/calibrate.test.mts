// Scoring decisions against labelled cases. The decider is a stub that answers
// from a script, so the numbers are known in advance and the suite is free.
import assert from "node:assert/strict";
import {
  calibrate,
  CalibrationError,
  choice,
  noul,
  runner,
  score,
  type Answer,
  type Case,
  type Decider,
  type Question,
} from "../src/index.ts";

const triage = runner({
  name: "triage",
  inputs: ["goal", "plan"],
  work: { go: () => "ok" },
  nodes: {
    screen: { decide: { urgent: noul("Is this urgent?") }, reads: ["goal"] },
    route: {
      decide: {
        queue: choice("Which queue?", { billing: null, orders: null, account: null }),
        anger: score("How angry?", ["calm", "annoyed", "furious"]),
      },
      reads: ["goal", "plan"],
    },
    done: { work: "go" },
  },
  edges: [
    { from: "screen", to: "route" },
    { from: "route", to: "done" },
  ],
  entry: "screen",
});

/** Answers keyed by the goal text, so each case gets a scripted reply. */
function scripted(replies: Record<string, Record<string, Answer>>): Decider & { calls: number } {
  const decide = async (state: unknown, questions: Record<string, Question>) => {
    decide.calls++;
    const goal = (state as { goal: string }).goal;
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(questions)) answers[key] = replies[goal]![key]!;
    return { model: "stub", answers, usage: { input_tokens: 50, output_tokens: 0 }, cost: 0.00002 };
  };
  decide.calls = 0;
  return decide;
}

const chose = (option: string, confidence: number): Answer => ({
  type: "choice",
  choice: option,
  confidence,
  probabilities: { [option]: confidence },
});
const rated = (level: number, confidence: number): Answer => ({
  type: "score",
  score: level,
  confidence,
  probabilities: {},
  legend: {},
});

// ── 1 · accuracy, misses and gate prices for a choice ───────────────────────
{
  const decider = scripted({
    a: { queue: chose("billing", 0.95), anger: rated(0.1, 0.9) },
    b: { queue: chose("orders", 0.9), anger: rated(2.2, 0.8) },
    c: { queue: chose("billing", 0.55), anger: rated(1.4, 0.4) }, // wrong, and unsure about it
    d: { queue: chose("account", 0.85), anger: rated(0.4, 0.7) }, // rounds to 0, expected 1
  });
  const cases: Case[] = [
    { inputs: { goal: "a", plan: "free" }, expect: { queue: "billing", anger: 0 } },
    { inputs: { goal: "b", plan: "free" }, expect: { queue: "orders", anger: 2 } },
    { inputs: { goal: "c", plan: "vip" }, expect: { queue: "orders", anger: 1 } },
    { inputs: { goal: "d", plan: "vip" }, expect: { "route.queue": "account", anger: 1 } },
  ];
  const report = await calibrate(triage, cases, { decider });

  assert.equal(report.asked, 4, "one call per case: both questions ride in the same node");
  assert.equal(decider.calls, 4);
  assert.equal(report.cost, 0.00008);
  const queue = report.questions.find((q) => q.key === "queue")!;
  assert.equal(queue.n, 4);
  assert.equal(queue.accuracy, 0.75);
  assert.deepEqual(queue.misses, [{ case: 3, expected: "orders", got: "billing", confidence: 0.55 }]);
  const at06 = queue.gates!.find((g) => g.min === 0.6)!;
  assert.deepEqual(at06, { min: 0.6, keeps: 0.75, accuracy: 1 }, "a 0.6 gate drops the one miss and keeps the rest");

  const anger = report.questions.find((q) => q.key === "anger")!;
  assert.equal(anger.accuracy, 0.75, "a score is right when it rounds to the expected level");
  assert.deepEqual(anger.misses.map((m) => m.case), [4]);
  assert.ok(anger.meanError! > 0 && anger.meanError! < 0.5);
}
console.log("ok · 1 accuracy, misses and gate prices for a choice and a score");

// ── 2 · a noul is scored by which side of 0.5 it lands, with a Brier score ──
{
  const decider = scripted({
    a: { urgent: { type: "noul", noul: 0.9 } },
    b: { urgent: { type: "noul", noul: 0.2 } },
    c: { urgent: { type: "noul", noul: 0.6 } }, // wrong side
  });
  const report = await calibrate(
    triage,
    [
      { inputs: { goal: "a" }, expect: { urgent: true } },
      { inputs: { goal: "b" }, expect: { urgent: false } },
      { inputs: { goal: "c" }, expect: { urgent: false } },
    ],
    { decider },
  );
  const urgent = report.questions[0]!;
  assert.equal(urgent.type, "noul");
  assert.equal(urgent.accuracy, 0.6667);
  assert.equal(urgent.brier, Number(((0.01 + 0.04 + 0.36) / 3).toFixed(4)));
  assert.equal(urgent.gates, undefined, "a noul cannot be gated, so no gate prices");
}
console.log("ok · 2 a noul is judged at 0.5 and gets a Brier score");

// ── 3 · confidence that matches accuracy has no gap; overconfidence does ───
{
  const honest = scripted(
    Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`h${i}`, { queue: chose(i < 8 ? "billing" : "orders", 0.8) }]),
    ),
  );
  const cases: Case[] = Array.from({ length: 10 }, (_, i) => ({ inputs: { goal: `h${i}`, plan: "x" }, expect: { queue: "billing" } }));
  const fair = await calibrate(triage, cases, { decider: honest });
  assert.equal(fair.questions[0]!.gap, 0, "80% sure and 80% right");

  const brash = scripted(
    Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`h${i}`, { queue: chose(i < 5 ? "billing" : "orders", 0.99) }])),
  );
  const loud = await calibrate(triage, cases, { decider: brash });
  assert.ok(loud.questions[0]!.gap > 0.4, "99% sure and 50% right is a gap no gate can fix");
}
console.log("ok · 3 the gap tells an honest decider from a confidently wrong one");

// ── 4 · a broken case set is refused before anything is spent ──────────────
{
  const decider = scripted({});
  const bad = await calibrate(
    triage,
    [
      { inputs: { goal: "x" }, expect: { queue: "billing" } }, // route reads plan too
      { inputs: { goal: "x", plan: "y" }, expect: { queue: "refunds" } }, // not an option
      { inputs: { goal: "x" }, expect: { mood: "sad" } }, // nobody asks that
      { inputs: { goal: "x", plan: "y" }, expect: { anger: 3 } }, // levels are 0..2
    ],
    { decider },
  ).catch((e: unknown) => e);
  assert.ok(bad instanceof CalibrationError);
  assert.equal(decider.calls, 0, "nothing was asked");
  assert.equal(bad.problems.length, 4);
  assert.match(bad.problems[0]!, /reads plan — add "plan" to its inputs/);
  assert.match(bad.problems[1]!, /expect one of billing, orders, account/);
  assert.match(bad.problems[2]!, /no decide node asks/);
  assert.match(bad.problems[3]!, /level from 0 to 2/);
}
console.log("ok · 4 a broken case set is refused with fixes, and costs nothing");

// ── 5 · the budget stops asking and says so ─────────────────────────────────
{
  const decider = scripted(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`g${i}`, { urgent: { type: "noul", noul: 0.9 } }])));
  const cases: Case[] = Array.from({ length: 20 }, (_, i) => ({ inputs: { goal: `g${i}` }, expect: { urgent: true } }));
  const report = await calibrate(triage, cases, { decider, budget: 0.0001, concurrency: 1 });
  assert.equal(report.stopped, "budget");
  assert.equal(report.asked, 5);
  assert.equal(report.questions[0]!.n, 5, "the report covers what was asked, and no more");
}
console.log("ok · 5 the budget stops a calibration part way and says so");

// ── 6 · dev and holdout are scored apart, and the gap is reported ──────────
{
  // Same question, easy on dev, hard on holdout: the shape overfitting takes.
  const decider = scripted({
    ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`d${i}`, { queue: chose("billing", 0.9) }])),
    ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`h${i}`, { queue: chose(i < 1 ? "billing" : "orders", 0.9) }])),
  });
  const cases: Case[] = [
    ...Array.from({ length: 4 }, (_, i) => ({ inputs: { goal: `d${i}`, plan: "x" }, expect: { queue: "billing" } })),
    ...Array.from({ length: 4 }, (_, i) => ({ inputs: { goal: `h${i}`, plan: "x" }, expect: { queue: "billing" }, set: "holdout" as const })),
  ];
  const report = await calibrate(triage, cases, { decider });

  assert.equal(report.questions.length, 1, "dev is what `questions` holds");
  assert.equal(report.questions[0]!.accuracy, 1, "4/4 on the cases it was tuned against");
  assert.equal(report.holdout![0]!.accuracy, 0.25, "1/4 on the frozen set");
  assert.deepEqual(report.gap, [{ node: "route", key: "queue", dev: 1, holdout: 0.25, drop: 0.75 }]);
  assert.equal(report.questions[0]!.n + report.holdout![0]!.n, 8, "every case was scored, once, in its own set");

  // With no holdout cases, nothing changes for existing callers.
  const devOnly = await calibrate(triage, cases.slice(0, 4), { decider });
  assert.equal(devOnly.holdout, undefined);
  assert.equal(devOnly.gap, undefined);

  const bad = await calibrate(triage, [{ inputs: { goal: "d0", plan: "x" }, expect: { queue: "billing" }, set: "train" as never }], { decider })
    .catch((e: unknown) => e);
  assert.ok(bad instanceof CalibrationError);
  assert.match(bad.problems[0]!, /has set "train" — a case is "dev" \(tuned against\) or "holdout"/);
}
console.log("ok · 6 dev and holdout are scored separately, and the drop between them is named");

console.log("6 cases");
