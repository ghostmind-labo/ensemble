/**
 * 11 · two runners, one project (1 of 2): a support desk.
 *
 * A project often holds more than one runner. Nothing ties them together and
 * nothing has to: each run records its runner's name and the hash of the graph
 * it ran with, so `ensemble status` and `ensemble view` tell them apart, and
 * count each change of a graph as a new version, with no configuration.
 *
 * This one and `ideas.mts` also swap the same three models between roles. Here
 * Jev decides twice (which team a message is for, behind a confidence gate; and
 * whether the reply that came out answers it), Kimi K3 is the brain that thinks
 * the reply through, and DeepSeek Flash tightens it.
 *
 * Both models reason before they write, and reasoning is paid for out of
 * `maxTokens`: the limits are generous on purpose, and the simple rewrite asks
 * for `reasoning: "low"`.
 *
 *   npx ensemble validate examples/11-two-runners/support.mts
 *   npx ensemble run examples/11-two-runners/support.mts "I was charged twice for order A-104" --budget 0.10
 *   npx ensemble run examples/11-two-runners/ideas.mts "get more people to try our sourdough" --budget 0.12
 *   npx ensemble view          # both runners, side by side
 */
import { choice, noul, runner, score } from "../../src/index.ts";

export default runner({
  name: "support-desk",
  description: "Routes a support message, drafts a reply with Kimi K3, tightens it with DeepSeek Flash, and checks it before sending.",
  inputs: ["goal"],

  work: {
    send: ({ state }) => `[${String(state["team"])}] ${String(state["reply"])}`,
    hand_off: ({ goal, state }) => `Handed to a person (${state["team"] ? `routed to ${String(state["team"])}, reply not good enough` : "team unclear"}): ${String(goal)}`,
  },

  nodes: {
    classify: {
      decide: {
        team: choice("Which team should handle this message?", {
          billing: { what: "Charges, invoices, refunds, subscriptions", not_for: "Where a parcel is, or signing in" },
          orders: { what: "Order status, delivery, cancellation, returns", not_for: "Money questions, or signing in" },
          account: { what: "Login, profile, permissions, security", not_for: "Money questions, or parcels" },
        }),
        upset: noul("Is the customer clearly upset or frustrated?"),
      },
      reads: ["goal"],
      gate: { on: "team", min: 0.7, to: "escalate" },
    },

    think: {
      model: "moonshotai/kimi-k3",
      label: "the brain",
      system: "You are a senior support agent. Work out what the customer needs and write the reply you would send. Never invent order details, amounts or dates.",
      prompt: (s) =>
        `Team: ${String(s["team"])}. The customer ${Number(s["upset"]) >= 0.5 ? "is upset: acknowledge it first" : "is calm"}.\n\nMessage:\n${String(s["goal"])}\n\nWrite the reply.`,
      reads: ["goal", "team", "upset"],
      writes: ["draft"],
      maxTokens: 3000,
    },

    tighten: {
      model: "deepseek/deepseek-v4.1-flash",
      system: "You edit support replies. Keep every fact and every promise; remove everything else.",
      prompt: (s) => `Rewrite this reply in at most three sentences, plain and warm. Output only the reply.\n\n${String(s["draft"])}`,
      reads: ["draft"],
      writes: ["reply"],
      temperature: 0,
      // A rewrite needs no deliberation, and reasoning is paid for out of maxTokens.
      reasoning: "low",
      maxTokens: 1500,
    },

    check: {
      decide: {
        answers: noul("Does the reply address what the customer asked?"),
        tone: score("How is the tone of the reply?", [
          { what: "Cold, defensive or dismissive" },
          { what: "Neutral and correct" },
          { what: "Warm, clear and respectful" },
        ]),
      },
      reads: ["goal", "reply"],
    },

    deliver: { work: "send", reads: ["team", "reply"], writes: ["outcome"] },
    escalate: { work: "hand_off", reads: ["goal", "team"], writes: ["outcome"] },
  },

  edges: [
    { from: "classify", to: "think" },
    { from: "think", to: "tighten" },
    { from: "tighten", to: "check" },
    // Jev judged; the comparison is ours.
    { from: "check", to: "escalate", when: (s) => Number(s["answers"]) < 0.5 || Number(s["tone"]) < 0.5 },
    { from: "check", to: "deliver" },
  ],

  entry: "classify",
  result: "outcome",
});
