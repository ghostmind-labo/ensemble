// Research → parallel review → write, with a reject loop back to research.
// Three vendors in one graph; conditions are plain TypeScript predicates.
import { scene } from "../src/index.ts";

export default scene({
  name: "research-and-critique",

  defaults: {
    model: "openrouter/anthropic/claude-sonnet-5",
  },

  nodes: {
    researcher: {
      model: "openrouter/google/gemini-2.5-flash",
      description: "Gathers the raw material.",
      prompt: [
        "You are a researcher. Given the goal, lay out the key considerations,",
        "trade-offs, and any facts that matter. Be concrete and specific.",
        "Aim for 200-400 words.",
      ].join("\n"),
      outputs: ["findings"],
    },

    critic: {
      model: "openrouter/anthropic/claude-haiku-4.5",
      description: "Judges whether the research is good enough to write from.",
      prompt: [
        "You are a critic. Read the findings and judge whether they are strong",
        "enough to write a confident answer from.",
        "",
        'Set verdict to "accept" if usable, "reject" only if there is a real gap.',
        "Put the specific gap in `notes`. Be decisive — do not reject over style.",
      ].join("\n"),
      inputs: ["findings"],
      outputs: ["verdict", "notes"],
    },

    factchecker: {
      model: "openrouter/deepseek/deepseek-v4-flash",
      description: "Runs alongside the critic, looking for wrong claims.",
      prompt: [
        "You are a fact checker. Read the findings and flag any claim that is",
        "wrong, outdated, or overstated. If everything checks out, say so plainly.",
      ].join("\n"),
      inputs: ["findings"],
      outputs: ["corrections"],
    },

    writer: {
      model: "openrouter/anthropic/claude-sonnet-5",
      description: "Produces the final answer.",
      prompt: [
        "You are the writer. Using the findings, the critic's notes, and the fact",
        "checker's corrections, produce the final answer to the goal.",
        "Write it as clean markdown. Be direct and useful.",
      ].join("\n"),
      inputs: ["findings", "notes", "corrections"],
      outputs: ["result"],
    },
  },

  groups: {
    // These two run concurrently; their outputs merge before `writer` starts.
    review: ["critic", "factchecker"],
  },

  edges: [
    { from: "researcher", to: "review" },
    { from: "review", to: "writer", when: (s) => s["verdict"] === "accept" },
    // Send it back for another pass, but never more than twice.
    { from: "review", to: "researcher", when: (s) => s["verdict"] === "reject", maxLoops: 2 },
  ],

  entry: "researcher",
  exit: "writer",
});
