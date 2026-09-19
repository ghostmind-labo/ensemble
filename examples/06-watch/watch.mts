/**
 * 06 · watch — a conscience for something that runs for days.
 *
 * Examples 01–05 are single ticks: one pass, then stop. Real systems run for
 * days, and they rarely fail by crashing. They fail by drifting: stuck on one
 * path, unsure more and more often, repeating themselves, quietly spending.
 * `supervise()` is the brainstem that keeps a tick alive for days: memory
 * between ticks, a budget per day and overall, a journal it resumes from, and
 * a stop after a run of failures. This file is the part that notices drift.
 *
 * The watcher is an ordinary runner, so it validates, dry-runs and calibrates
 * like any other. Every few ticks the supervisor calls it with:
 *
 *   · `vitals`  numbers: failure rate, gate rate, sameness, spend. For `when:`.
 *   · `recent`  the last ticks as plain text: path and what each said. For Jev.
 *
 * It follows the library's one rule. Numbers are checked first, in code, and
 * the questions only get asked if the numbers look fine. The questions are about
 * meaning: is this going anywhere, is it repeating itself, would a person want
 * to see this. Three narrow nouls, one round trip, about $0.00002. That is the
 * point of pairing a fast calibrated decider with whatever does the real work:
 * it can afford to check on it every few ticks, forever.
 *
 * The watched work can be anything, including a free-running agent with every
 * tool it likes inside one `work` handler. The watcher doesn't limit it; it
 * watches it.
 *
 *   ensemble validate examples/06-watch/watch.mts           # free, offline
 *   node examples/06-watch/watch.mts                        # supervise 01-triage over a queue (live, ~$0.001)
 */
import { fileURLToPath } from "node:url";
import { noul, runner, supervise, type Vitals } from "../../src/index.ts";

const watcher = runner({
  name: "watcher",
  description: "Every few ticks: check the numbers, then ask whether the work is still on track.",
  inputs: ["goal", "vitals", "recent"],

  nodes: {
    // Arithmetic first, and free. Nothing here is a judgement.
    vitals: { code: () => null },

    judge: {
      decide: {
        progress: noul("Do the recent ticks show the work moving toward the goal?", {
          true: { what: "Ticks produce different, useful results that serve the goal" },
          false: { what: "Ticks produce nothing useful, or nothing to do with the goal" },
        }),
        looping: noul("Do the recent ticks keep producing the same result while nothing changes?", {
          true: { what: "The same outcome again and again, as if stuck", not_for: "Similar work on different inputs" },
          false: { what: "Outcomes vary with their inputs" },
        }),
        review: noul("Did any recent tick produce something a person should look at?", {
          true: { what: "Something odd, risky, or outside what the work is meant to do" },
          false: { what: "Routine output only" },
        }),
      },
      // Only the story. The numbers stay out: Jev reads text, and sums are code's job.
      reads: ["goal", "recent"],
    },

    carry_on: { code: () => "continue" },
    flag: { code: () => "alert" },
    halt: { code: () => "stop" },
  },

  edges: [
    // Read every key before combining them: validation probes a when() with
    // undefined state, and a short-circuit would hide a read.
    {
      from: "vitals",
      to: "halt",
      when: (s) => {
        const v = s["vitals"] as Vitals | undefined;
        return Number(v?.failureRate) >= 0.5;
      },
    },
    {
      from: "vitals",
      to: "flag",
      when: (s) => {
        const v = s["vitals"] as Vitals | undefined;
        const unsure = Number(v?.gateRate), same = Number(v?.sameness), ticks = Number(v?.ticks);
        return unsure > 0.4 || (same > 0.9 && ticks >= 10);
      },
    },
    { from: "vitals", to: "judge" },

    { from: "judge", to: "flag", on: "review>=0.6" },
    { from: "judge", to: "flag", on: "looping>=0.7" },
    { from: "judge", to: "carry_on", on: "progress>=0.5" },
    { from: "judge", to: "flag" },
  ],

  entry: "vitals",
});

export default watcher;

// ── run directly: supervise 01-triage over a queue of messages ──────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { default: triage } = await import("../01-triage/triage.mts");
  const inbox = [
    "I was charged twice for March",
    "where is my parcel, it's been two weeks",
    "I can't log in after resetting my password",
    "please cancel my order #4411 before it ships",
    "why did my invoice go up this month?",
    "my account shows someone else's address",
  ];

  const outcome = await supervise(triage, {
    next: ({ tick }) => (tick <= inbox.length ? { goal: inbox[tick - 1]! } : undefined),
    budget: { total: 0.05, perDay: 1, perRun: 0.01 },
    run: { stepTimeout: 30_000 },
    watch: { every: 3, runner: watcher, goal: "route each customer message to the queue that can resolve it" },
    journal: ".ensemble/watch",
    onEvent: (event) => {
      if (event.type === "tick") console.error(`tick ${event.summary.tick} · ${event.summary.status} · ${event.summary.path.join(" → ")} · $${event.spent.toFixed(5)}`);
      if (event.type === "watch") console.error(`  ${event.reason ?? event.verdict}`);
    },
    onAlert: ({ tick, reason }) => console.error(`  ALERT at tick ${tick}: ${reason}`),
  });
  console.error(`${outcome.status} after ${outcome.ticks} ticks · $${outcome.spent.toFixed(5)}`);
  console.log(JSON.stringify(outcome.vitals, null, 2));
}
