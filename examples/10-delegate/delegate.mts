/**
 * 10 · delegate — hand one step to an agent somebody else runs.
 *
 * Most requests need no agent, and a decide node says so before anything is
 * spent. The ones that do are handed to an external agent through a standard
 * protocol, declared in `agents`, so `graph.json` names the agent and how it is
 * reached. The agent never marks its own work: a decide node after it asks
 * whether the reply answers the request, and a weak reply goes round once more
 * on an edge that carries its own budget.
 *
 *   triage ──direct──▶ answer ─────────────────────────────▶ deliver
 *      └──research──▶ research (agent, A2A) ─▶ review ──ok──▶ deliver
 *                          ▲                     └─weak─▶ tally ─(1 retry)─┘
 *
 * The agent here is a hosted one, reached with A2A at RESEARCH_AGENT_URL. To
 * use a local agent instead, swap the declaration for one launched as a
 * command and nothing else in the graph changes:
 *
 *   researcher: { protocol: "acp", command: "opencode", args: ["acp"] }
 *
 *   ensemble validate examples/10-delegate/delegate.mts
 *   ensemble graph    examples/10-delegate/delegate.mts | jq '.nodes[] | select(.kind=="agent")'
 *   ensemble check    examples/10-delegate/delegate.mts      # reads the agent's card
 *   ensemble run      examples/10-delegate/delegate.mts "What changed in the last release?"
 */
import { choice, noul, runner } from "../../src/index.ts";

export default runner({
  name: "delegate",
  description: "Answer directly when that is enough; otherwise delegate to an external agent and check its reply.",
  inputs: ["goal"],

  agents: {
    researcher: {
      protocol: "a2a",
      url: process.env["RESEARCH_AGENT_URL"] ?? "https://agent.example.com",
      // A secret is a NAME here and a value only at call time.
      auth: { type: "bearer", token: "${RESEARCH_AGENT_TOKEN}" },
    },
  },

  nodes: {
    triage: {
      decide: {
        route: choice(
          { question: "How should this request be handled?", focus: "Does answering it need looking something up?" },
          {
            direct: { what: "A greeting, thanks, or small talk that needs no lookup", not_for: "Anything asking for facts or findings" },
            research: { what: "Needs facts, sources or findings gathered", not_for: "Small talk" },
          },
        ),
      },
      reads: ["goal"],
    },

    answer: { code: (s) => `Happy to help. You said: ${String(s["goal"])}`, reads: ["goal"], writes: ["reply"] },

    // One message to the agent, one reply. Its loop is its own; the deadline
    // (`stepTimeout`), the budget and the judgement stay in this graph.
    research: {
      agent: "researcher",
      prompt: (s) =>
        `${String(s["goal"])}\n\nAnswer in a short paragraph, and say what you could not confirm.` +
        (s["rounds"] ? `\n\nA first answer was judged incomplete. Be specific this time.` : ""),
      reads: ["goal", "rounds"],
      writes: ["reply", "delegation"],
      label: "Ask the researcher",
    },

    review: {
      decide: { answered: noul("Does the reply fully answer what the person asked?") },
      reads: ["goal", "reply"],
    },

    tally: { code: (s) => Number(s["rounds"] ?? 0) + 1, reads: ["rounds"], writes: ["rounds"] },
    deliver: { code: (s) => String(s["reply"]), reads: ["reply"], writes: ["final"] },
  },

  edges: [
    { from: "triage", to: "answer", on: "route=direct" },
    { from: "triage", to: "research", on: "route=research" },
    { from: "answer", to: "deliver" },
    { from: "research", to: "review" },
    { from: "review", to: "tally", on: "!answered" },
    { from: "review", to: "deliver", on: "answered" },
    { from: "tally", to: "research", maxLoops: 1 },
    { from: "tally", to: "deliver" },
  ],

  entry: "triage",
  result: "final",
});
