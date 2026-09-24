/**
 * 09 · frontdesk — everything at once.
 *
 * The other examples each isolate one idea so it can be read. This one is the
 * opposite: every concept the library has, in a single graph, because that is
 * what a real one looks like by its third week.
 *
 *   senses (3 lanes, in parallel)      a vision model, an MCP tool call, and memory
 *        └─ join ─► triage (decide)    one call, three questions, a confidence gate
 *                     ├─ hazard ──────► page a person        (safety, tried FIRST)
 *                     ├─ urgent ──────► page a person        (arithmetic, in code)
 *                     ├─ cosmetic ────► queue it
 *                     └─ bug/question ► answer ─► review ─┐
 *                                          ▲              │ weak or ungrounded
 *                                          └── tally ◄────┘ (loop, budget 2)
 *                                                └─ spent ─► a person
 *                                       review ─► remember ─► card? ─► a person approves ─► deliver
 *
 * What is in here, and where to look:
 *
 *   · all five node kinds — decide, work, code, model, mcp
 *   · all three questions — choice, score, noul — asked in ONE call
 *   · a confidence gate, and a safety edge that outranks it by being declared first
 *   · fork / join: three lanes that cannot race, because `validate` proves they
 *     write and read disjoint keys
 *   · memory: `seen` and `last_area` survive the tick and are carried by supervise
 *   · a model that LOOKS, a model that DRAWS, and a model whose id is resolved at
 *     run time from the live catalogue
 *   · a skill chosen in code and inlined into that model's instructions
 *   · one MCP tool call, with the tool named from state
 *   · a loop with its budget on the edge, and a following edge that takes over
 *   · both branch forms: `on:` for a declared answer, `when:` for arithmetic and
 *     for keys written earlier in the run
 *   · a PERSON in the loop: `approve` asks the same kind of closed question Jev
 *     does, so its answers are wired and proven like any other. With a `human`
 *     handler the run waits; without one it pauses and can be resumed later
 *   · a fallback: if the decider is down, `triage` routes to a person instead of
 *     failing the run
 *
 * It is also a SHORT run. The whole graph is one function call: three lanes in
 * parallel, one ~100 ms decision, and a model or two. Two or three minutes, not
 * two or three days — `supervise` is what you add when this tick should repeat,
 * not something the tick needs to exist.
 *
 *   npm run validate -- examples/09-frontdesk/frontdesk.mts
 *   node plugin/skills/ensemble-build/scripts/dryrun.mts examples/09-frontdesk/frontdesk.mts \
 *     "the checkout page shows a blank modal" --input screenshot=https://example.com/shot.png \
 *     --input log_path=README.md --explore
 */
import { catalog, choice, loadSkills, noul, runner, score, shortlist } from "../../src/index.ts";

/** Two passes back to the writer, then a person takes it. */
const ROUNDS = 2;

// Synchronous, local, free — so it is safe at module scope, and `validate` and
// `graph` stay offline. The registry must be on the RUNNER for a model node to
// inline one: a name resolved from state is looked up here, and "none" in this
// list is not an error, it is the deliberate way to attach nothing.
const skills = loadSkills();

export default runner({
  name: "frontdesk",
  description: "Look, read the log and recall — in parallel — then triage, answer, review, and deliver.",

  // What arrives from outside. `goal` always does.
  inputs: ["goal", "screenshot", "log_path"],
  // What outlives the run. Declared, so graph.json says what this remembers.
  memory: ["seen", "last_area"],
  skills,

  mcpServers: {
    fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  },

  work: {
    page: ({ goal }) => `PAGED: ${goal}`,
    queue: ({ goal }) => `queued for the next sweep: ${goal}`,
    escalate: ({ goal }) => `a person will take this: ${goal}`,
    deliver: ({ state }) => `sent: ${String(state["reply"]).slice(0, 60)}…`,
  },

  nodes: {
    /* ── the senses: three lanes, running at once ──────────────────────────── */

    start: { code: () => new Date().toISOString(), writes: ["at"] },

    // Lane e0 — the only node that touches pixels. Jev cannot see, so this is
    // how a picture becomes something a decision can read.
    look: {
      model: "google/gemini-2.5-flash",
      system: "You are a support triage assistant's eyes. Describe only what is on screen.",
      prompt: (s) => `In two sentences: what does this screenshot show, given the report "${String(s["goal"])}"?`,
      sees: ["screenshot"],
      reads: ["goal"],
      writes: ["scene"],
      temperature: 0,
      maxTokens: 200,
    },

    // Lane e1 — one MCP tool call, with the tool named from state. Not a loop:
    // the graph says what it can reach before it runs.
    pick_tool: { code: () => "read_text_file", writes: ["tool"] },
    read_log: {
      mcp: { server: "fs", tool: { from: "tool" } },
      args: (s) => ({ path: String(s["log_path"] ?? "README.md"), head: 80 }),
      reads: ["log_path"],
      writes: ["log_text", "log_data"],
    },

    // Lane e2 — memory. One write key takes the value whole, so return the number.
    recall: { code: (s) => Number(s["seen"] ?? 0) + 1, reads: ["seen"], writes: ["seen"] },

    /* ── the judgement: one call, three questions, a gate ──────────────────── */

    triage: {
      join: "all", // runs once, after every lane has arrived
      decide: {
        area: choice("What kind of report is this?", {
          bug: { what: "Something is broken or behaving wrongly", not_for: "Asking how something works" },
          question: { what: "Someone wants to know how to do something", not_for: "A defect report" },
          cosmetic: { what: "Visual polish only — spacing, wording, alignment", not_for: "Anything that blocks a task" },
        }),
        hazard: noul("Could this cost someone money or data if it is left alone today?", {
          true: { what: "Data loss, a wrong charge, or an outage is plausible" },
          false: { what: "Inconvenient at worst" },
        }),
        urgency: score("How soon does someone need to act?", [
          { what: "Whenever — it can wait for the next sweep" },
          { what: "This week" },
          { what: "Now — someone is blocked" },
        ]),
      },
      // The senses' WORDS, never the screenshot itself: validate refuses that
      // by name. `seen` is here because a repeat report is a different report.
      reads: ["goal", "scene", "log_text", "seen"],
      gate: { on: "area", min: 0.65, to: "hand_off" },
      // Low confidence is the gate's job. NO answer — an outage, a timeout — is this.
      fallback: "hand_off",
    },

    /* ── the answer path ───────────────────────────────────────────────────── */

    // A skill, chosen in code and inlined into the model's instructions. "none"
    // resolves to nothing, deliberately — suggesting nothing beats suggesting wrong.
    pick_skill: {
      code: () => skills.find((s) => /debug|diagnos|support/i.test(`${s.name} ${s.description}`))?.name ?? "none",
      writes: ["skill"],
    },

    // Volatile detail resolved at run time; the QUESTION above outlives every id here.
    choose_writer: {
      code: async (s) => {
        const writers = shortlist(await catalog(), { limit: 40 }).filter((m) => m.promptUsd > 0);
        if (writers.length === 0) throw new Error("no writer available");
        const byPrice = [...writers].sort((a, b) => a.promptUsd - b.promptUsd);
        // Price is not quality — it is the only ranking a library can honestly
        // apply to a catalogue it did not evaluate. Substitute your own.
        return Number(s["urgency"]) >= 1 ? (byPrice[Math.floor(byPrice.length / 2)] ?? byPrice[0]!).id : byPrice[0]!.id;
      },
      reads: ["urgency"],
      writes: ["writer"],
    },

    answer: {
      model: { from: "writer" },
      skills: { from: "skill" },
      prompt: (s) =>
        `Reply to this report: ${String(s["goal"])}\n\nWhat the screen shows:\n${String(s["scene"])}\n\n` +
        `Relevant log:\n${String(s["log_text"]).slice(0, 2000)}\n\n` +
        (s["critique"] ? `Your last reply was reviewed. Fix exactly this:\n${String(s["critique"])}` : ""),
      reads: ["goal", "scene", "log_text", "critique"],
      writes: ["reply"],
      maxTokens: 700,
    },

    // A model critiques in PROSE; the decide node below turns that into a number.
    // Generation is open-ended and unrankable; judgement is closed and comparable.
    critique: {
      model: "anthropic/claude-sonnet-4.5",
      system: "You are a support lead reviewing a reply. Name concrete problems; do not rewrite it.",
      prompt: (s) => `Report: ${String(s["goal"])}\n\nLog:\n${String(s["log_text"]).slice(0, 2000)}\n\nReply:\n${String(s["reply"])}`,
      reads: ["goal", "log_text", "reply"],
      writes: ["critique"],
      temperature: 0,
      maxTokens: 300,
    },

    review: {
      decide: {
        quality: score("How close is this reply to sendable?", [
          { what: "Wrong, or answers something else" },
          { what: "Correct but thin" },
          { what: "Sendable as written" },
        ]),
        grounded: noul("Is every claim in the reply supported by the log or the screen?", {
          true: { what: "Everything traces back to the evidence" },
          false: { what: "It asserts something nobody showed it" },
        }),
      },
      reads: ["goal", "reply", "critique"],
    },

    tally: { code: (s) => Number(s["rounds"] ?? 0) + 1, reads: ["rounds"], writes: ["rounds"] },

    // The second memory key: what this tick decided, for the next one to see.
    remember: { code: (s) => String(s["area"]), reads: ["area"], writes: ["last_area"] },

    // A model that DRAWS. Its images arrive as data: URLs — the same shape `sees`
    // accepts, so the next node could look at what this one made.
    card: {
      model: "google/gemini-2.5-flash-image",
      prompt: (s) => `A calm status card illustrating a resolved support issue: ${String(s["goal"])}. No text in the image.`,
      reads: ["goal"],
      writes: ["caption", "image"], // positional: [text, images]
    },

    // A person, asked a closed question like any other. Urgent replies are seen
    // by a human before they go out; their note travels with the run.
    approve: {
      decide: {
        send_it: noul("Should this reply go to the customer as written?", {
          true: { what: "Accurate, on-tone, and safe to send unchanged" },
          false: { what: "Wrong, off-tone, or needs a person to rewrite it" },
        }),
      },
      reads: ["goal", "reply", "caption"],
      by: "human",
      comment: "reviewer_note",
    },

    /* ── the exits ─────────────────────────────────────────────────────────── */

    alarm: { work: "page", reads: ["goal", "scene"], writes: ["outcome"] },
    park: { work: "queue", reads: ["goal"], writes: ["outcome"] },
    hand_off: { work: "escalate", reads: ["goal"], writes: ["outcome"] },
    send: { work: "deliver", reads: ["reply", "image"], writes: ["outcome"] },
  },

  edges: [
    // ── fan out. A node's edges are all forks or none. ──────────────────────
    { from: "start", to: "look", fork: true },
    { from: "start", to: "pick_tool", fork: true },
    { from: "start", to: "recall", fork: true },
    { from: "pick_tool", to: "read_log" },

    // …and fan in. Every lane points at the join.
    { from: "look", to: "triage" },
    { from: "read_log", to: "triage" },
    { from: "recall", to: "triage" },

    // ── ORDER IS THE CONTROL FLOW: first match wins. ────────────────────────
    // Safety outranks the gate and the routing, because it is declared first.
    { from: "triage", to: "alarm", on: "hazard>=0.6" },
    // Arithmetic, in code, where it belongs — a score is a number.
    { from: "triage", to: "alarm", when: (s) => Number(s["urgency"]) >= 1.7 },
    { from: "triage", to: "park", on: "area=cosmetic" },
    { from: "triage", to: "pick_skill", on: "area=bug" },
    { from: "triage", to: "pick_skill", on: "area=question" },

    { from: "pick_skill", to: "choose_writer" },
    { from: "choose_writer", to: "answer" },
    { from: "answer", to: "critique" },
    { from: "critique", to: "review" },

    // Back round while it is weak OR ungrounded. Read both keys before
    // combining them: validation probes a when() with everything undefined,
    // so a short-circuit would hide the second read.
    {
      from: "review",
      to: "tally",
      when: (s) => {
        const quality = Number(s["quality"]);
        const grounded = Number(s["grounded"]);
        return quality < 1.5 || grounded < 0.5;
      },
    },
    { from: "review", to: "remember" },

    // The loop, and its budget. Once spent this edge stops matching…
    { from: "tally", to: "answer", maxLoops: ROUNDS },
    // …and the next one takes over: two passes did not fix it, so a person reads it.
    { from: "tally", to: "hand_off" },

    // `urgency` was answered back at triage, so branching on it here is a
    // when() — an `on:` branch must leave the node that asked the question.
    { from: "remember", to: "card", when: (s) => Number(s["urgency"]) >= 1 },
    { from: "remember", to: "send" },
    { from: "card", to: "approve" },

    // The person's answer is branched on like Jev's: on: for a declared answer.
    { from: "approve", to: "send", on: "send_it" },
    { from: "approve", to: "hand_off" },
  ],

  entry: "start",
  result: "outcome",
});
