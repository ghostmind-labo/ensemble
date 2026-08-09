// Minimal two-node scene used to prove per-node model routing actually works.
// Each node is asked to identify itself; the engine reports what the provider
// actually ran, so the claim is checked against the API, not the prose.
import { scene } from "../src/index.ts";

export default scene({
  name: "smoke",

  nodes: {
    alpha: {
      model: "openrouter/google/gemini-2.5-flash",
      prompt: "State which model you are in one short sentence.",
      outputs: ["alpha_says"],
    },
    beta: {
      model: "openrouter/anthropic/claude-haiku-4.5",
      prompt: "State which model you are in one short sentence.",
      inputs: ["alpha_says"],
      outputs: ["beta_says"],
    },
  },

  edges: [{ from: "alpha", to: "beta" }],

  entry: "alpha",
  exit: "beta",
});
