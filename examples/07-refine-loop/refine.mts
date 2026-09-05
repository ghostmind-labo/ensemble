// The score gate, done right: keep-or-revert on the blackboard.
//
// A writer produces work. A judge SCORES it (a number in state, not a vibe).
// Then a `refine` node — free, no model — compares that score with the best
// so far. A winner is KEPT and becomes the incumbent; anything else is
// REVERTED: the incumbent is written back over `tagline`, so the writer's next
// revision starts from the best version, never from the regression it just
// produced. The loop ends when the score stops rising (`patience`) or reaches
// the bar (`target`) — and whichever way it ends, `tagline` holds the best.
//
// Compare examples/02-score-gate: same writer, same judge, but that loop ends
// with the LAST attempt and every revision builds on the previous one.
import { scene, z } from "@ghostmind-dev/ensemble";

export default scene({
  name: "refine-loop",

  defaults: { model: "openrouter/anthropic/claude-haiku-4.5" },

  // Pinning the shape is what makes `s.converged` typed in the edge below and
  // what turns a judge that says "7/10" into a retry instead of a bad round.
  state: { score: z.number(), converged: z.boolean() },

  nodes: {
    writer: {
      prompt: [
        "Write a single-sentence product tagline for the goal.",
        "If `tagline` is present in your context, it is the BEST version so far —",
        "improve on it; do not start over.",
        "`feedback` is the judge's critique of the most recent attempt. If `verdict`",
        "is \"revert\", that attempt scored below the best and was discarded — the",
        "critique tells you what NOT to repeat. `reason` says by how much it missed.",
      ].join("\n"),
      inputs: ["tagline", "feedback", "best", "verdict", "reason"],
      outputs: ["tagline"],
    },

    judge: {
      model: "openrouter/anthropic/claude-sonnet-5", // stronger model holds the bar
      prompt: [
        "You are a harsh but fair judge of taglines. Score the tagline 0-10.",
        "`score` must be a NUMBER. Be strict and consistent: 8+ means you would ship it.",
        "Put your specific, actionable critique in `feedback`.",
      ].join("\n"),
      inputs: ["tagline"],
      outputs: ["score", "feedback"],
    },

    keep: {
      runtime: "refine",      // ⬆ free: no model call
      candidate: "tagline",   // the state key under refinement
      patience: 2,            // two straight non-improvements → converged
      target: 9,              // or stop the moment best reaches 9
      // The candidate key is required here: the revert writes the incumbent
      // back to it, and the data graph shows that. The rest are what the
      // writer and the edge read.
      outputs: ["tagline", "best", "verdict", "reason", "converged", "history"],
    },
  },

  edges: [
    { from: "writer", to: "judge" },
    { from: "judge", to: "keep" },
    // Loop while the score is still rising. `maxLoops` is the hard budget;
    // `converged` is the reason to stop early.
    { from: "keep", to: "writer", when: (s) => !s.converged, maxLoops: 6 },
  ],

  entry: "writer",
  exit: "keep",
});
