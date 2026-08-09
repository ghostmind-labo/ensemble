// The full stack in one scene: both runtimes, an MCP server, and a skill.
//
//   plan      runtime "model"  — cheap thinking, ~130 tokens of context, no tools
//   inspect   runtime "agent"  — real tool use: reads files via the `fs` MCP server
//   write     runtime "agent"  — uses the project-local `release-notes` skill
//
// Note which nodes are which. Only the two that must *do* something pay for
// opencode's ~8,800 tokens of scaffolding; the planner does not.
import { scene } from "@ghostmind-dev/ensemble";

export default scene({
  name: "full-stack",

  defaults: { model: "openrouter/anthropic/claude-haiku-4.5" },

  nodes: {
    plan: {
      // No runtime declared → "model" (the default). Pure HTTP, no opencode.
      model: "openrouter/google/gemini-2.5-flash",
      prompt: [
        "You are planning a small code audit. Given the goal, list the 3 most",
        "useful things to check in a TypeScript project, as a short checklist.",
        "Do not attempt to read any files — you have no tools. Just plan.",
      ].join("\n"),
      outputs: ["checklist"],
    },

    inspect: {
      runtime: "agent", // ← opencode: gets tools + the MCP servers below
      model: "openrouter/anthropic/claude-sonnet-5",
      mcp: ["fs"], // allowlist: only the `fs` server, nothing else
      skills: [], // no skills for this node
      prompt: [
        "You have filesystem tools. Work through the checklist against the files",
        "in the current directory. Report only what you actually observed —",
        "quote file names. If you could not check something, say so.",
        "",
        "CRITICAL: after you finish using tools, your FINAL message must end with",
        "the required fenced json block. Tool calls do not satisfy this — the",
        "json block is a separate, final answer containing your written findings.",
      ].join("\n"),
      inputs: ["checklist"],
      outputs: ["findings"],
    },

    write: {
      runtime: "agent", // ← opencode again, but scoped to a skill instead
      mcp: [], // no MCP for this node — it should not touch the filesystem
      skills: ["release-notes"], // project-local skill, deny-all + this one
      prompt: [
        "Turn the findings into user-facing release notes.",
        "Follow the release-notes skill's house style exactly.",
      ].join("\n"),
      inputs: ["findings"],
      outputs: ["notes"],
    },
  },

  edges: [
    { from: "plan", to: "inspect" },
    { from: "inspect", to: "write" },
  ],

  entry: "plan",
  exit: "write",
});
