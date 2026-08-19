// A throwaway test scene: three cheap workers answer the SAME question blind,
// then the brain reconciles them. No gate, no ask node — it runs start to
// finish, which makes it the one to reach for when you just want a real run to
// look at (live state, per-node costs, the run index) without babysitting a pause.
//
//   run routine jury
//
// Suggested goal (any question with a defensible wrong answer works):
//   "Should a two-person team start a new internal tool on SQLite or Postgres?"
import { scene, z } from "@ghostmind-dev/ensemble";

const independent = [
  "Answer the goal directly in about 120 words.",
  "Lead with your actual position — no throat-clearing.",
  "Then state the single strongest objection to your own answer.",
].join("\n");

export default scene({
  name: "jury",
  description: "Three independent answers, reconciled by one stronger model.",

  // Workers: cheap and fast. They do volume; they do not decide.
  defaults: { model: "openrouter/deepseek/deepseek-v4-flash" },

  state: {
    // The brain must pick one, and it must be one of these three — a free-text
    // answer here would make the result unusable downstream.
    strongest: z.enum(["a", "b", "c"]),
    confidence: z.number().min(0).max(10),
    answer: z.string(),
  },

  nodes: {
    // No `inputs` anywhere in the panel: independence is the whole point, so no
    // juror can see another's answer and anchor on it.
    juror_a: { prompt: independent, outputs: ["a"] },
    juror_b: { prompt: independent, outputs: ["b"] },
    juror_c: { prompt: independent, outputs: ["c"] },

    foreman: {
      model: "openrouter/z-ai/glm-5.3", // the brain
      prompt: [
        "You have three independent answers to one question.",
        "",
        "  - `strongest`   — which juror was most useful: exactly \"a\", \"b\", or \"c\".",
        "  - `confidence`  — 0-10, how sure you are the answer is right.",
        "  - `answer`      — the single best answer, built from the strongest parts",
        "                    of all three. This is what the user reads.",
        "  - `dissent`     — where they genuinely disagreed. If they agreed, say so",
        "                    plainly; do not invent conflict.",
      ].join("\n"),
      inputs: ["a", "b", "c"],
      outputs: ["strongest", "confidence", "answer", "dissent"],
    },
  },

  groups: { panel: ["juror_a", "juror_b", "juror_c"] },

  edges: [{ from: "panel", to: "foreman" }],

  entry: "panel",
  exit: "foreman",
});
