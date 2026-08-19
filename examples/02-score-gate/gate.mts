// The LangGraph pattern: a conditional edge gated on typed state.
//
// A writer produces work. A judge SCORES it (a number in state, not a vibe).
// The graph only moves forward when `score >= 8` — otherwise the judge's
// feedback loops back into the writer, which must revise. `maxLoops` is the
// budget: after 3 revisions it proceeds with the best it has.
//
// This is also the skeleton of the auto-research / self-improvement loop:
// run → measure → if below target, mutate using the feedback → run again.
import { scene } from "@ghostmind-dev/ensemble";

const TARGET = 8;

export default scene({
  name: "score-gate",

  defaults: { model: "openrouter/anthropic/claude-haiku-4.5" },

  nodes: {
    writer: {
      prompt: [
        "Write a single-sentence product tagline for the goal.",
        "If `feedback` is present in your context, it is the judge's critique of",
        "your previous attempt — revise to address it directly.",
      ].join("\n"),
      inputs: ["feedback", "score"], // sees the judge's critique of its last try
      outputs: ["tagline"],
    },

    judge: {
      model: "openrouter/anthropic/claude-sonnet-5", // stronger model as the gate
      prompt: [
        "You are a harsh but fair judge of taglines. Score the tagline 0-10.",
        "`score` must be a NUMBER. Be strict: 8+ means you would actually ship it.",
        "Put your specific, actionable critique in `feedback`.",
      ].join("\n"),
      inputs: ["tagline"],
      outputs: ["score", "feedback"],
    },
  },

  edges: [
    { from: "writer", to: "judge" },
    // The gate: only loop back while the score is below target. Typed state —
    // Number() guards against a model emitting "7" as a string.
    { from: "judge", to: "writer", when: (s) => Number(s["score"]) < TARGET, maxLoops: 3 },
  ],

  entry: "writer",
  exit: "judge",
});
