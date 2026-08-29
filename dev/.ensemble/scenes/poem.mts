// The smallest useful scene: one node writes, one node reads.
//
// Two model nodes, one edge, no loop, no tools. Both on DeepSeek v4 Flash, so a
// full run costs a fraction of a cent. This is the shape to reach for when you
// just want to see the machinery move.
import { scene, z } from "@ghostmind-dev/ensemble";

export default scene({
  name: "poem",

  defaults: { model: "openrouter/deepseek/deepseek-v4-flash" },

  // Typed blackboard: the writer must produce a string, the reader a number
  // between 1 and 10. A model that returns "eight" fails the node rather than
  // quietly poisoning the state.
  state: {
    poem: z.string().min(1),
    reading: z.string().min(1),
    rating: z.number().min(1).max(10),
  },

  nodes: {
    write: {
      prompt: "You are a poet. Write a short poem — at most 8 lines — on the given subject.",
      outputs: ["poem"],
    },

    read: {
      prompt: [
        "You are a critic. Read the poem you are given and respond to it:",
        "say in 2-3 sentences what it is doing and whether it works,",
        "then rate it 1-10.",
      ].join(" "),
      inputs: ["poem"],
      outputs: ["reading", "rating"],
    },
  },

  edges: [{ from: "write", to: "read" }],

  entry: "write",
  exit: "read",
});
