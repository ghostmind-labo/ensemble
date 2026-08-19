// Dev sandbox scene — small, cheap, and exercises the parts of the UI worth
// looking at while iterating: a parallel group, a scored gate that loops, and
// an `ask` node that parks the run.
import { scene, z } from "@ghostmind-dev/ensemble";

export default scene({
  name: "starter",
  // Workers are cheap and fast; the brain is the one that judges.
  defaults: { model: "openrouter/deepseek/deepseek-v4-flash" },

  state: {
    score: z.number().min(0).max(10),
    verdict: z.enum(["ship", "revise"]),
  },

  nodes: {
    draft: { prompt: "Draft a one-paragraph answer to the goal.", outputs: ["draft"] },

    read_a: { inputs: ["draft"], prompt: "Critique clarity in two sentences.", outputs: ["clarity"] },
    read_b: { inputs: ["draft"], prompt: "Critique accuracy in two sentences.", outputs: ["accuracy"] },

    judge: {
      model: "openrouter/z-ai/glm-5.3",   // the brain: money goes to the gate
      prompt: "Score the draft 0-10 and say ship or revise.",
      inputs: ["draft", "clarity", "accuracy"],
      outputs: ["score", "verdict", "feedback"],
    },

    approval: {
      runtime: "ask",
      question: "The judge wants to ship this. Approve?",
      inputs: ["draft", "score"],
      outputs: ["signoff"],
    },

    publish: { inputs: ["draft", "signoff"], outputs: ["final"] },
  },

  groups: { review: ["read_a", "read_b"] },

  edges: [
    { from: "draft", to: "review" },
    { from: "review", to: "judge" },
    // Loop-back FIRST — the engine takes the first matching edge.
    { from: "judge", to: "draft", when: (s) => s.score < 8, maxLoops: 2 },
    { from: "judge", to: "approval" },
    { from: "approval", to: "publish" },
  ],

  entry: "draft",
  exit: "publish",
});
