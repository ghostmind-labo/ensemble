// Renting a coding agent for ONE node.
//
// `runtime: "opencode"` shells out to the opencode CLI — a real editing loop
// with its own permission model — for the node that must genuinely build
// something, while the cheap nodes around it stay on our own runtimes.
//
// Needs `opencode` on PATH (`brew install sst/tap/opencode`). It reads the same
// OPENROUTER_API_KEY, so there is nothing else to configure — and `ensemble
// validate` will tell you before anything spends if the binary is missing.
//
// COSTS MORE than the other dev scenes: an external CLI carries thousands of
// tokens of its own scaffolding per call. That is the trade, and it is why this
// is a per-node choice rather than a default.
import { scene, z } from "@ghostmind-dev/ensemble";

export default scene({
  name: "rented",

  defaults: { model: "openrouter/deepseek/deepseek-v4-flash" },

  state: {
    plan: z.string(),
    summary: z.string(),
    verified: z.boolean(),
  },

  nodes: {
    // one cheap call: decide WHAT to do before paying anyone to do it.
    plan: {
      runtime: "model",
      prompt: "Turn the goal into a single, concrete, self-contained coding task under ./out/.",
      outputs: ["plan"],
    },

    // rented: opencode owns the editing loop, we own the contract. It is handed
    // the engine's own prompt including the required-output block, and its reply
    // is parsed and retried exactly like any other node's.
    build: {
      runtime: "opencode",
      model: "openrouter/anthropic/claude-sonnet-5",
      timeout: 300,
      prompt: "Do exactly what the plan says. Work only under ./out/.",
      inputs: ["plan"],
      outputs: ["summary"],
    },

    // free: trust nothing the rented agent merely claimed.
    verify: {
      runtime: "fn",
      fn: (s) => ({ verified: String(s.summary).trim().length > 0 }),
      inputs: ["summary"],
      outputs: ["verified"],
    },
  },

  edges: [
    { from: "plan", to: "build" },
    { from: "build", to: "verify" },
  ],

  entry: "plan",
  exit: "verify",
});
