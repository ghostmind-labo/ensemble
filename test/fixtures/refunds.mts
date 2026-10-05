// A runner with no decider to stub: every decision is a person's. Served as an agent
// and as a tool by the adapter suites. `seen.aborted` counts handlers told to stop.
import { choice, noul, runner } from "../../src/index.ts";

export const seen = { aborted: 0 };

export default runner({
  name: "refunds",
  description: "Drafts a refund and settles it.",
  inputs: ["goal", "amount"],
  work: {
    draft: ({ goal, state }) => `refund for ${goal}${state["amount"] !== undefined ? ` (${state["amount"]})` : ""}`,
    pay: ({ state }) => `paid: ${state["draft"]}`,
    decline: ({ state }) => `declined: ${state["draft"]}${state["reason"] ? ` — ${state["reason"]}` : ""}`,
    slow: ({ signal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => (seen.aborted++, reject(new Error("stopped"))), { once: true })),
    spend: ({ report }) => (report({ cost: 0.4 }), "spent"),
    nap: () => new Promise((done) => setTimeout(() => done("rested"), 300)),
  },
  nodes: {
    write: { work: "draft", reads: ["amount"], writes: ["draft"] },
    wait: { work: "slow", writes: ["waited"] },
    burn: { work: "spend", writes: ["burnt"] },
    rest: { work: "nap", writes: ["rested"] },
    burn_again: { work: "spend", writes: ["burnt"] },
    approve: {
      decide: { ok: noul("Should this refund be issued as drafted?"), tier: choice("Which approval tier applies?", { standard: null, senior: null }) },
      reads: ["goal", "draft"],
      by: "human",
      comment: "reason",
    },
    pay_it: { work: "pay", writes: ["outcome"] },
    say_no: { work: "decline", reads: ["reason"], writes: ["outcome"] },
  },
  edges: [
    { from: "write", to: "wait", when: ({ goal }) => String(goal).startsWith("hang") },
    { from: "write", to: "burn", when: ({ goal }) => String(goal).startsWith("spend") },
    { from: "write", to: "rest", when: ({ goal }) => String(goal).startsWith("slow") },
    { from: "write", to: "approve", when: ({ goal }) => String(goal).startsWith("ask") },
    { from: "write", to: "pay_it" },
    { from: "burn", to: "burn_again" },
    { from: "burn_again", to: "pay_it" },
    { from: "wait", to: "pay_it" },
    { from: "rest", to: "pay_it" },
    { from: "approve", to: "pay_it", on: "ok" },
    { from: "approve", to: "say_no" },
  ],
  entry: "write",
  result: "outcome",
});
