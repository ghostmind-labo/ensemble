/**
 * 11 · two runners, one project (2 of 2): an idea studio.
 *
 * The companion to `support.mts`, with the same three models in other roles:
 * DeepSeek Flash brainstorms cheaply, Jev says how big the best idea is, Kimi K3
 * is the brain that writes the plan, and Jev scores the result. A weak plan goes
 * back once, with its score on the blackboard; the loop budget is on the edge.
 *
 *   npx ensemble run examples/11-two-runners/ideas.mts "get more people to try our sourdough" --budget 0.12
 */
import { choice, runner, score } from "../../src/index.ts";

export default runner({
  name: "idea-studio",
  description: "Brainstorms with DeepSeek Flash, lets Jev size the best idea, has Kimi K3 write the plan, and revises once if Jev scores it weak.",
  inputs: ["goal"],

  work: {
    publish: ({ state }) => `${String(state["size"])} plan after ${Number(state["rounds"] ?? 0) + 1} draft(s):\n\n${String(state["plan"])}`,
  },

  nodes: {
    brainstorm: {
      model: "deepseek/deepseek-v4.1-flash",
      prompt: (s) => `Give three distinct, concrete ideas for this goal, one line each, numbered. No preamble.\n\nGoal: ${String(s["goal"])}`,
      reads: ["goal"],
      writes: ["ideas"],
      temperature: 0.9,
      reasoning: "low",
      maxTokens: 1500,
    },

    size_up: {
      decide: {
        size: choice("How much work would the most promising of these ideas take?", {
          weekend: { what: "One person could do it in a few days", not_for: "Anything needing a budget or other people" },
          project: { what: "A few weeks, a small budget, or a couple of people", not_for: "A quick solo experiment" },
          program: { what: "Months of sustained effort or real money", not_for: "Anything that fits in a few weeks" },
        }),
      },
      reads: ["goal", "ideas"],
    },

    write_plan: {
      model: "moonshotai/kimi-k3",
      label: "the brain",
      system: "You turn a rough idea into a plan someone can start on tomorrow. Be specific. No filler.",
      prompt: (s) =>
        `Goal: ${String(s["goal"])}\n\nIdeas:\n${String(s["ideas"])}\n\nPick the most promising idea and write a ${String(s["size"])}-sized plan: the idea in one line, then at most five steps.` +
        (s["quality"] !== undefined ? `\n\nYour previous plan scored ${String(s["quality"])} out of 2 for being actionable. Make every step something a person can do.` : ""),
      reads: ["goal", "ideas", "size", "quality"],
      writes: ["plan"],
      maxTokens: 3000,
    },

    review: {
      decide: {
        quality: score("How actionable is this plan?", [
          { what: "Vague: no step could be started tomorrow" },
          { what: "Mixed: some concrete steps, some hand-waving" },
          { what: "Concrete: every step is something a person can do" },
        ]),
      },
      reads: ["goal", "plan"],
    },

    tally: { code: (state) => Number(state["rounds"] ?? 0) + 1, reads: ["rounds"], writes: ["rounds"] },
    ship: { work: "publish", reads: ["plan", "size", "rounds"], writes: ["outcome"] },
  },

  edges: [
    { from: "brainstorm", to: "size_up" },
    { from: "size_up", to: "write_plan" },
    { from: "write_plan", to: "review" },
    { from: "review", to: "tally", when: (s) => Number(s["quality"]) < 1.5 },
    { from: "review", to: "ship" },
    // One revision at most: the budget for the loop lives on the edge.
    { from: "tally", to: "write_plan", maxLoops: 1 },
    { from: "tally", to: "ship" },
  ],

  entry: "brainstorm",
  result: "outcome",
});
