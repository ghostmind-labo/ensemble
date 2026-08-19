// A decision council: turn one hard, open question into a decision-ready brief.
//
// This is the "everything at once" example — the four control features the
// engine has, wired into one scene that actually holds together:
//
//   • an ORCHESTRATOR      one node frames the question and sets the constraints
//                          every downstream node is scoped to.
//   • FOUR TEAMS (groups)  recon · options · red-team · production — each a set
//                          of nodes that run concurrently with a fan-in barrier.
//   • a CONDITION (gate)   an adjudicator scores the option set; the graph only
//                          moves to production when `score >= TARGET`, otherwise
//                          it loops the options team with the critique.
//   • STATE MEMORY         the shared blackboard. The orchestrator's `frame` and
//                          `constraints` written once at the top are still there
//                          for the publisher fifteen nodes later; the gate's
//                          `feedback` is what the options team reads on a revise.
//
// 15 nodes, every one a different casting of model to job. All are runtime
// "model" (pure OpenRouter calls) — the point here is topology, not tool use, so
// the whole council runs on nothing but OPENROUTER_API_KEY, like example 01.
import { scene } from "@ghostmind-dev/ensemble";

// The bar the option set must clear before the council will spend money drafting
// the final brief. Number(), not a truthy string — see the gate edge below.
const TARGET = 8;

export default scene({
  name: "decision-council",
  description: "Frame → recon → options → red-team → gate → production. Four teams, one orchestrator, one quality gate.",

  defaults: { model: "openrouter/anthropic/claude-haiku-4.5" },

  nodes: {
    // ── The orchestrator ────────────────────────────────────────────────────
    // Runs once, first. It does not answer the question — it defines the shape
    // of an acceptable answer, and that definition persists in state for every
    // node after it. This is the single point of framing.
    orchestrator: {
      model: "openrouter/anthropic/claude-sonnet-5",
      description: "Frames the question and fixes the constraints.",
      prompt: [
        "You are the council chair. Do NOT answer the goal. Instead, set the frame",
        "everyone else will work inside.",
        "",
        "Produce:",
        "  - `frame`        — a one-paragraph restatement of the real decision at",
        "                     stake, sharper than the goal as asked.",
        "  - `constraints`  — the 3-5 hard constraints or success criteria any",
        "                     acceptable answer must satisfy, as a markdown list.",
        "  - `unknowns`     — the 2-3 things we do not know that most affect the call.",
      ].join("\n"),
      outputs: ["frame", "constraints", "unknowns"],
    },

    // ── Team 1 · Recon ──────────────────────────────────────────────────────
    // Three vendors survey the same framed problem from three angles, in
    // parallel, independently. Distinct output keys — parallel members writing
    // the same key is a hard validation error, by design.
    recon_market: {
      model: "openrouter/google/gemini-2.5-flash",
      description: "The market / demand angle.",
      prompt: "Survey the MARKET and demand side of the framed decision: who wants this, how big, what substitutes exist, what the timing risk is. Be concrete and specific. ~150 words.",
      inputs: ["frame", "constraints"],
      outputs: ["recon_market"],
    },
    recon_tech: {
      model: "openrouter/deepseek/deepseek-v4-flash",
      description: "The technical feasibility angle.",
      prompt: "Survey the TECHNICAL feasibility of the framed decision: what has to be true to build it, the hardest component, the dependency most likely to slip. Be concrete. ~150 words.",
      inputs: ["frame", "constraints"],
      outputs: ["recon_tech"],
    },
    recon_human: {
      model: "openrouter/anthropic/claude-haiku-4.5",
      description: "The people / adoption angle.",
      prompt: "Survey the HUMAN side of the framed decision: who has to change behaviour, the adoption friction, the second-order effects on the people involved. Be concrete. ~150 words.",
      inputs: ["frame", "constraints"],
      outputs: ["recon_human"],
    },

    // ── Team 2 · Options ────────────────────────────────────────────────────
    // Three competing, deliberately distinct proposals. Each reads all of recon
    // and the frame. On a REVISE loop each also reads `feedback` and `score` —
    // that is the state-memory channel from the gate back to the drafters.
    option_a: {
      model: "openrouter/google/gemini-2.5-pro",
      description: "The bold option.",
      prompt: [
        "Propose the BOLD option — the highest-upside way to satisfy the frame,",
        "accepting real risk. Give it a name, a one-line thesis, and the 3 moves it",
        "requires. If `feedback` is in your context, it is the adjudicator's critique",
        "of the last round — revise to address it directly. ~180 words.",
      ].join("\n"),
      inputs: ["frame", "constraints", "recon_market", "recon_tech", "recon_human", "feedback", "score"],
      outputs: ["option_a"],
    },
    option_b: {
      model: "openrouter/deepseek/deepseek-v4-flash",
      description: "The safe option.",
      prompt: [
        "Propose the SAFE option — the most defensible, lowest-regret way to satisfy",
        "the frame. Give it a name, a one-line thesis, and the 3 moves it requires.",
        "If `feedback` is in your context, revise to address it directly. ~180 words.",
      ].join("\n"),
      inputs: ["frame", "constraints", "recon_market", "recon_tech", "recon_human", "feedback", "score"],
      outputs: ["option_b"],
    },
    option_c: {
      model: "openrouter/anthropic/claude-haiku-4.5",
      description: "The contrarian option.",
      prompt: [
        "Propose the CONTRARIAN option — the one that questions a premise everyone",
        "else accepted. Give it a name, a one-line thesis, and the 3 moves it",
        "requires. If `feedback` is in your context, revise to address it. ~180 words.",
      ].join("\n"),
      inputs: ["frame", "constraints", "recon_market", "recon_tech", "recon_human", "feedback", "score"],
      outputs: ["option_c"],
    },

    // ── Team 3 · Red team ───────────────────────────────────────────────────
    // Three adversaries attack the whole option set on three axes, in parallel.
    // They do not propose — they try to break what the options team built.
    crit_feasibility: {
      model: "openrouter/google/gemini-2.5-flash",
      description: "Attacks feasibility.",
      prompt: "You are a hostile reviewer. Across ALL three options, name the single most likely reason each FAILS TO SHIP. No praise. ~120 words.",
      inputs: ["option_a", "option_b", "option_c", "constraints"],
      outputs: ["crit_feasibility"],
    },
    crit_cost: {
      model: "openrouter/anthropic/claude-haiku-4.5",
      description: "Attacks cost & effort.",
      prompt: "You are a skeptical CFO. Across ALL three options, name where each is more EXPENSIVE or slower than its author implies. No praise. ~120 words.",
      inputs: ["option_a", "option_b", "option_c", "constraints"],
      outputs: ["crit_cost"],
    },
    crit_risk: {
      model: "openrouter/deepseek/deepseek-v4-flash",
      description: "Attacks downside risk.",
      prompt: "You are a risk officer. Across ALL three options, name the worst plausible DOWNSIDE of each and how it is triggered. No praise. ~120 words.",
      inputs: ["option_a", "option_b", "option_c", "constraints"],
      outputs: ["crit_risk"],
    },

    // ── The gate ────────────────────────────────────────────────────────────
    // The second orchestration point. It reads the options AND every critique,
    // scores the strongest option 0-10, and writes the decision. `score` is the
    // typed value the loop-back edge is gated on; `feedback` is what the options
    // team reads if it is sent back to revise.
    adjudicator: {
      model: "openrouter/anthropic/claude-sonnet-5",
      description: "Scores the set, picks the winner, or sends it back.",
      prompt: [
        "You are the adjudicator. You have three options and three red-team critiques",
        "of them. Judge the STRONGEST option once the critiques are accounted for.",
        "",
        "  - `score`     — a NUMBER 0-10. Be strict: 8+ means it survives the red team",
        "                  and you would present it. A fatal, unaddressed critique caps",
        "                  the whole set below 8.",
        "  - `winner`    — exactly one of \"a\", \"b\", or \"c\".",
        "  - `rationale` — why the winner beats the other two given the critiques.",
        "  - `feedback`  — if score < 8, the specific, actionable thing the options",
        "                  team must fix next round. If 8+, say what to preserve.",
      ].join("\n"),
      inputs: ["option_a", "option_b", "option_c", "crit_feasibility", "crit_cost", "crit_risk", "constraints"],
      outputs: ["score", "winner", "rationale", "feedback"],
    },

    // ── Team 4 · Production ─────────────────────────────────────────────────
    // Only reached once the gate passes. Three writers own three sections of the
    // final brief, in parallel — independent, distinct keys, no editing race.
    prod_summary: {
      model: "openrouter/anthropic/claude-haiku-4.5",
      description: "Writes the TL;DR.",
      prompt: "Write the 3-sentence executive TL;DR of the decision: the recommended option and why it won. Lead with the recommendation.",
      inputs: ["frame", "winner", "rationale"],
      outputs: ["brief_summary"],
    },
    prod_body: {
      model: "openrouter/google/gemini-2.5-pro",
      description: "Writes the argument.",
      prompt: "Write the BODY of the brief: the recommended option in full, the case for it, and the two rejected options with one line each on why they lost. Markdown, ~300 words.",
      inputs: ["frame", "constraints", "winner", "rationale", "option_a", "option_b", "option_c"],
      outputs: ["brief_body"],
    },
    prod_appendix: {
      model: "openrouter/anthropic/claude-haiku-4.5",
      description: "Writes risks & open questions.",
      prompt: "Write the APPENDIX: the top risks carried by the recommendation (drawn from the red team) and the open questions to resolve before committing. Markdown list.",
      inputs: ["unknowns", "rationale", "crit_feasibility", "crit_cost", "crit_risk"],
      outputs: ["brief_appendix"],
    },

    // ── Exit ────────────────────────────────────────────────────────────────
    // Assembles the three sections into one clean brief. The `frame` it opens
    // with was written by the orchestrator at node 1 and has ridden the
    // blackboard, untouched, the entire run.
    publisher: {
      model: "openrouter/anthropic/claude-sonnet-5",
      description: "Assembles the final decision brief.",
      prompt: [
        "Assemble the final one-page decision brief from the sections provided.",
        "Order: restated decision (`frame`), TL;DR, body, appendix. Tighten the seams",
        "so it reads as one document, but do not invent anything not in the sections.",
        "Output the finished brief in `brief`.",
      ].join("\n"),
      inputs: ["frame", "brief_summary", "brief_body", "brief_appendix"],
      outputs: ["brief"],
    },
  },

  // The four teams. Each runs its members concurrently and merges before the
  // graph moves on.
  groups: {
    recon: ["recon_market", "recon_tech", "recon_human"],
    options: ["option_a", "option_b", "option_c"],
    redteam: ["crit_feasibility", "crit_cost", "crit_risk"],
    production: ["prod_summary", "prod_body", "prod_appendix"],
  },

  edges: [
    { from: "orchestrator", to: "recon" },
    { from: "recon", to: "options" },
    { from: "options", to: "redteam" },
    { from: "redteam", to: "adjudicator" },

    // The gate. Order matters: the engine takes the FIRST matching edge, so the
    // conditional loop-back is listed before the unconditional advance. Below
    // TARGET and with budget left → back to the options team with feedback in
    // state. Otherwise (score high enough, or maxLoops spent) this edge is
    // skipped and the graph falls through to production.
    { from: "adjudicator", to: "options", when: (s) => Number(s["score"]) < TARGET, maxLoops: 2 },
    { from: "adjudicator", to: "production" },

    { from: "production", to: "publisher" },
  ],

  entry: "orchestrator",
  exit: "publisher",
});
