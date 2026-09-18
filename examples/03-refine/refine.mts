/**
 * 03 · refine — a loop that knows when to stop.
 *
 * The oldest pattern in this repo, rebuilt. A draft is written, scored, and
 * either shipped or sent back. What changed is the gate: the score is a
 * calibrated number with its whole distribution attached, not a model's opinion
 * parsed out of prose, so "it got better" and "the judge felt different today"
 * are finally distinguishable.
 *
 * Note where each judgement lives. Whether the draft is good enough is MEANING,
 * so Jev answers it. How many rounds have passed is ARITHMETIC, so a `code`
 * node counts and a `when:` compares. Jev is documented as unreliable at
 * counting; asking it "is this the third attempt?" would be the whole mistake.
 *
 *   ensemble run examples/03-refine/refine.mts "explain calibrated confidence to a CTO"
 */
import { noul, runner, score } from "../../src/index.ts";

const ROUNDS = 3;

export default runner({
  name: "refine",
  description: "Draft, score, revise until it clears the bar or the budget runs out.",
  inputs: ["goal"],

  work: {
    // Your writer. On a later round `quality` is on the blackboard, so the
    // handler can see how the last attempt scored.
    write: ({ goal, state, report }) => {
      const round = Number(state["rounds"] ?? 0) + 1;
      report({ cost: 0.008, meta: { provider: "openrouter", model: "anthropic/claude-sonnet-5" } });
      return `draft ${round} of ${JSON.stringify(goal)} (last score: ${state["quality"] ?? "none"})`;
    },
    publish: ({ state }) => `published: ${String(state["draft"]).slice(0, 60)}`,
  },

  nodes: {
    draft: { work: "write", reads: ["goal", "quality", "rounds"], writes: ["draft"] },

    review: {
      decide: {
        quality: score("How good is this draft, against what was asked?", [
          { what: "Off-target or unusable", signals: ["Answers a different question"] },
          { what: "Serviceable but thin", signals: ["Correct, adds little"] },
          { what: "Genuinely good", signals: ["Specific, well-argued, nothing to add"] },
        ]),
        blocker: noul("Does the draft contain a claim that is wrong or unsupported?"),
      },
      reads: ["goal", "draft"],
    },

    // Deterministic, free, instant — and the only thing that touches a count.
    tally: {
      // One write key takes the return value WHOLE — so return the number, not
      // { rounds: n }, which would nest as rounds.rounds.
      code: (state) => Number(state["rounds"] ?? 0) + 1,
      reads: ["rounds"],
      writes: ["rounds"],
    },

    ship: { work: "publish", reads: ["draft"], writes: ["url"] },
  },

  edges: [
    { from: "draft", to: "review" },
    // Send it back while it is weak or wrong. Both judgements are Jev's;
    // the comparison is ours.
    {
      from: "review",
      to: "tally",
      when: (s) => Number(s["quality"]) < 1.5 || Number(s["blocker"]) >= 0.5,
    },
    // Anything that did not match above is good enough. A bare edge is the
    // default branch, and `validate` accepts it as the catch-all.
    { from: "review", to: "ship" },

    // The loop budget lives on the edge. Once it is spent the edge stops
    // matching and the next one — ship — takes over.
    { from: "tally", to: "draft", maxLoops: ROUNDS },
    { from: "tally", to: "ship" },
  ],

  entry: "draft",
  result: "url",
});
