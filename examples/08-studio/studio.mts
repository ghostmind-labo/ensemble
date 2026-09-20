/**
 * 08 · studio — four models in a row, a loop that knows when to stop, and
 * branching on both meaning and arithmetic.
 *
 * The other examples each show one idea. This one is what a real graph looks
 * like when several of them land in the same file:
 *
 *   research → write → critique → review ─┬─ back to write   (a loop, budgeted)
 *                                         ├─ illustrate      (if it is an article)
 *                                         └─ publish
 *
 * Four generative calls in sequence, each a different job, and **none of them
 * judges anything**. A model writes, a model critiques *in prose*, and then a
 * decide node reads that prose and returns a calibrated score. That split is
 * the point: generation is open-ended and unrankable, judgement is closed and
 * comparable, and mixing them is how a pipeline ends up with a critic whose
 * verdict nobody can audit.
 *
 * Three kinds of branch appear here, and the difference between them is not
 * stylistic:
 *
 *   · `on:` — a declared answer of the node that just asked. Static, drawable.
 *   · `when:` — arithmetic, or a key written EARLIER in the run. `format` is
 *     decided at the brief, so branching on it later must be a `when:`.
 *   · `maxLoops` — a budget on the edge itself. When it is spent the edge stops
 *     matching and the next one takes over, which is how a loop ends without a
 *     counter in the engine.
 *
 * Safety comes first in declaration order, because edges are tried in order and
 * the first match wins. A risky brief leaves for a person before a single token
 * is spent.
 *
 *   npm run validate -- examples/08-studio/studio.mts
 *   node plugin/skills/ensemble-build/scripts/dryrun.mts examples/08-studio/studio.mts "explain calibrated confidence" --explore
 */
import { catalog, choice, noul, runner, score, shortlist } from "../../src/index.ts";

/** Two passes back to the writer, then a person takes it. */
const ROUNDS = 2;

export default runner({
  name: "studio",
  description: "Research, write, critique, revise until good, illustrate if it is an article, publish.",
  inputs: ["goal", "sources"],

  work: {
    publish: ({ state }) => `published: ${String(state["draft"]).slice(0, 60)}…`,
    brief_a_human: ({ goal }) => `a person will take this: ${goal}`,
  },

  nodes: {
    // ── 1. What is being asked for, and is it safe to do at all? ────────────
    brief: {
      decide: {
        format: choice("What is being asked for?", {
          article: { what: "A piece for readers, published with a picture", not_for: "An internal note" },
          memo: { what: "An internal note for colleagues", not_for: "Anything public-facing" },
          post: { what: "A short social post", not_for: "A long piece" },
        }),
        depth: choice("How much thinking does this need?", {
          quick: { what: "Routine; a fast model will do", not_for: "Anything needing real argument" },
          considered: { what: "Needs argument, nuance or structure", not_for: "A routine rewrite" },
        }),
        risk: noul("Would writing this mean giving medical, legal or financial advice, or naming a private person?", {
          true: { what: "A person could be harmed, or a rule broken, by publishing it" },
          false: { what: "Ordinary subject matter" },
        }),
      },
      reads: ["goal"],
      gate: { on: "format", min: 0.6, to: "hand_off" },
    },

    // ── 2. Which writer. Volatile, so code resolves it; the QUESTION above is
    //       what survives the model's retirement. ────────────────────────────
    pick_writer: {
      code: async (state) => {
        const writers = shortlist(await catalog(), { limit: 40 }).filter((m) => m.promptUsd > 0);
        if (writers.length === 0) throw new Error("no writer available");
        const byPrice = [...writers].sort((a, b) => a.promptUsd - b.promptUsd);
        // Price is not quality — it is the only ranking a library can honestly
        // apply to a catalogue it did not evaluate. Substitute your own.
        return state["depth"] === "considered"
          ? (byPrice[Math.floor(byPrice.length / 2)] ?? byPrice[0]!).id
          : byPrice[0]!.id;
      },
      reads: ["depth"],
      writes: ["writer"],
    },

    // ── 3. Model one: read the sources, write down what matters. ────────────
    research: {
      model: "google/gemini-2.5-flash",
      system: "You extract facts. Quote the source; never add anything that is not in it.",
      prompt: (s) => `Pull out what matters for this brief: ${String(s["goal"])}\n\nSources:\n${String(s["sources"] ?? "(none supplied)")}`,
      reads: ["goal", "sources"],
      writes: ["notes"],
      temperature: 0,
      maxTokens: 400,
    },

    // ── 4. Model two: the draft. Its id came from state, and on a second pass
    //       it is handed the critique it earned. ────────────────────────────
    write: {
      model: { from: "writer" },
      prompt: (s) =>
        `Write a ${String(s["format"])} answering: ${String(s["goal"])}\n\n` +
        `Use only these notes:\n${String(s["notes"])}\n\n` +
        (s["critique"] ? `Your previous draft was reviewed. Fix exactly this:\n${String(s["critique"])}` : ""),
      reads: ["goal", "format", "notes", "critique"],
      writes: ["draft"],
      maxTokens: 900,
    },

    // ── 5. Model three: a critique, in prose. A different vendor reads the
    //       draft, and returns words — not a verdict. ───────────────────────
    critique: {
      model: "anthropic/claude-sonnet-4.5",
      system: "You are a hard but fair editor. Name concrete problems; do not rewrite.",
      prompt: (s) =>
        `Brief: ${String(s["goal"])}\n\nNotes the writer was given:\n${String(s["notes"])}\n\nDraft:\n${String(s["draft"])}\n\n` +
        `List what is wrong with it, shortest first. If nothing is wrong, say so plainly.`,
      reads: ["goal", "notes", "draft"],
      writes: ["critique"],
      temperature: 0,
      maxTokens: 400,
    },

    // ── 6. The only judgement in the file, and it is calibrated. ────────────
    review: {
      decide: {
        quality: score("How close is this draft to publishable, against the brief?", [
          { what: "Off-target or unusable", signals: ["Answers a different question"] },
          { what: "Serviceable but thin", signals: ["Correct, adds little"] },
          { what: "Genuinely good", signals: ["Specific, well-argued, nothing to add"] },
        ]),
        unsupported: noul("Does the draft state something the notes do not support?", {
          true: { what: "A claim appears that is not in the notes" },
          false: { what: "Every claim traces back to the notes" },
        }),
      },
      // The critique is evidence, so Jev reads it. The sources are not: they
      // were already distilled into notes, and padding costs accuracy.
      reads: ["goal", "draft", "critique"],
    },

    // Arithmetic, in code, where it belongs.
    tally: {
      code: (s) => Number(s["rounds"] ?? 0) + 1,
      reads: ["rounds"],
      writes: ["rounds"],
    },

    // ── 7. Model four: only an article gets a picture. ──────────────────────
    illustrate: {
      model: "google/gemini-2.5-flash-image",
      prompt: (s) => `A single editorial illustration for an article about: ${String(s["goal"])}. No text in the image.`,
      reads: ["goal"],
      // Positional, and only a model node writes this way: [text, images].
      writes: ["caption", "image"],
    },

    ship: { work: "publish", reads: ["draft", "image"], writes: ["outcome"] },
    hand_off: { work: "brief_a_human", reads: ["goal"], writes: ["outcome"] },
  },

  edges: [
    // Safety first, and it is first because edges are tried in order.
    { from: "brief", to: "hand_off", on: "risk>=0.6" },
    { from: "brief", to: "pick_writer" },

    { from: "pick_writer", to: "research" },
    { from: "research", to: "write" },
    { from: "write", to: "critique" },
    { from: "critique", to: "review" },

    // Send it back while it is weak OR unsupported. Read both keys before
    // combining them: validation probes a when() with everything undefined,
    // and a short-circuit would hide the second read.
    {
      from: "review",
      to: "tally",
      when: (s) => {
        const quality = Number(s["quality"]);
        const unsupported = Number(s["unsupported"]);
        return quality < 1.5 || unsupported >= 0.5;
      },
    },
    // `format` was answered at the brief, not here, so this is a when: — an
    // `on:` branch must leave the node that asked the question.
    { from: "review", to: "illustrate", when: (s) => s["format"] === "article" },
    // Anything else is good enough, and needs no picture.
    { from: "review", to: "ship" },

    // The loop, and its budget. Once spent, this edge stops matching.
    { from: "tally", to: "write", maxLoops: ROUNDS },
    // …and the next one takes over: two passes did not fix it, so a person reads it.
    { from: "tally", to: "hand_off" },

    { from: "illustrate", to: "ship" },
  ],

  entry: "brief",
  result: "outcome",
});
