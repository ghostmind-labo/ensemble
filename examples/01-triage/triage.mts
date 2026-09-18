/**
 * 01 · triage — the smallest thing that is still the whole idea.
 *
 * One decide node classifies the request; its options ARE the branches. Because
 * every option is declared, `ensemble validate` can prove nothing falls through
 * and `ensemble graph` can draw the whole shape before a single call is made.
 *
 *   ensemble validate examples/01-triage/triage.mts
 *   ensemble graph    examples/01-triage/triage.mts | jq .edges
 *   ensemble run      examples/01-triage/triage.mts "I was charged twice for order A-104"
 */
import { choice, runner } from "../../src/index.ts";

export default runner({
  name: "triage",
  description: "Route a support message to the team that should answer it.",
  inputs: ["goal"],

  // Your code. Replace these with the real thing — a queue write, an LLM call,
  // a page to a human. The runner calls them and does not look inside.
  work: {
    billing: ({ goal }) => `→ billing: ${goal}`,
    orders: ({ goal }) => `→ orders: ${goal}`,
    account: ({ goal }) => `→ account: ${goal}`,
    human: ({ goal }) => `→ a person will read this: ${goal}`,
  },

  nodes: {
    classify: {
      decide: {
        team: choice(
          { question: "Which team should handle this message?", focus: "Classify the customer's primary request." },
          {
            billing: {
              what: "Charges, invoices, refunds, subscriptions",
              not_for: "Where a parcel is, or signing in",
              examples: ["I was charged twice", "Where is my refund?"],
            },
            orders: {
              what: "Order status, delivery, cancellation, returns",
              not_for: "Money questions, or signing in",
              examples: ["Where is my order?", "Cancel my shipment"],
            },
            account: {
              what: "Login, profile, permissions, security",
              not_for: "Money questions, or parcels",
              examples: ["Reset my password", "I cannot sign in"],
            },
          },
        ),
      },
      // The only state sent to the decider. Accuracy falls as irrelevant
      // detail grows, so this list is a feature, not documentation.
      reads: ["goal"],
      // An unsure classifier should not act. Below 0.7, a person reads it.
      gate: { on: "team", min: 0.7, to: "escalate" },
    },

    to_billing: { work: "billing", reads: ["goal"], writes: ["reply"] },
    to_orders: { work: "orders", reads: ["goal"], writes: ["reply"] },
    to_account: { work: "account", reads: ["goal"], writes: ["reply"] },
    escalate: { work: "human", reads: ["goal"], writes: ["reply"] },
  },

  // One edge per option. Miss one and `validate` says so by name.
  edges: [
    { from: "classify", to: "to_billing", on: "team=billing" },
    { from: "classify", to: "to_orders", on: "team=orders" },
    { from: "classify", to: "to_account", on: "team=account" },
  ],

  entry: "classify",
  result: "reply",
});
