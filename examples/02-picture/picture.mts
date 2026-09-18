/**
 * 02 · picture — classify a request, pick a generator, draw it.
 *
 * This is the one that calls models: a `model` node generates the image, and
 * which model it uses is chosen at run time from OpenRouter's live catalogue.
 *
 * The important trick is how those two facts coexist with a graph that is still
 * COMPLETE. A `choice` has to enumerate its options at authoring time, and the
 * catalogue is 445 models that change weekly — so the decision is split:
 *
 *   Jev decides the STABLE thing   · "draft or final?" — two options, forever.
 *   Code resolves the VOLATILE one · which model that means today, at what
 *                                    price, filtered on `draws` and a budget.
 *
 * Ask Jev to pick from a live catalogue and `graph.json` can no longer say what
 * the branches are, which is the whole property worth protecting. Ask it the
 * durable question instead and nothing is lost.
 *
 *   ensemble validate examples/02-picture/picture.mts     # free, offline
 *   ensemble run      examples/02-picture/picture.mts "a hero image for the launch page"
 */
import { catalog, choice, noul, runner, score, shortlist } from "../../src/index.ts";

export default runner({
  name: "make-a-picture",
  description: "Classify an image request, choose a generator within budget, and draw it.",
  inputs: ["goal"],

  work: {
    // Deliver however you like — this one just reports what it got.
    deliver: ({ state }) => {
      const drawn = (state["image"] as string[] | undefined) ?? [];
      return drawn.length ? `${drawn.length} image(s), first is ${drawn[0]!.slice(0, 40)}…` : "nothing drawn";
    },
    brief_a_human: ({ goal }) => `briefed a designer: ${goal}`,
  },

  nodes: {
    classify: {
      decide: {
        picture_kind: choice("What kind of picture is being asked for?", {
          photo: { what: "Photoreal image of a scene, person or product", not_for: "Explanatory figures" },
          diagram: { what: "Explanatory figure: boxes, arrows, labels", not_for: "Photoreal scenes" },
          logo: { what: "A mark or wordmark standing for a brand", not_for: "A full illustration" },
        }),
        // Stable, and therefore safe to enumerate: this question will have the
        // same two answers long after every model id here is obsolete.
        fidelity: choice("How much does image quality matter here?", {
          draft: { what: "A rough look, to be iterated on", not_for: "Anything shipping to users" },
          final: { what: "Going in front of users as-is", not_for: "A quick sketch" },
        }),
        needs_text: noul("Must legible words appear inside the image itself?"),
        complexity: score("How demanding is this request?", [
          { what: "One subject, no constraints" },
          { what: "Several elements, or a style to match" },
          { what: "Precise layout or a brand system to honour" },
        ]),
      },
      reads: ["goal"],
      gate: { on: "picture_kind", min: 0.7, to: "hand_off" },
    },

    // Volatile detail, resolved in code at run time. Numbers and booleans only:
    // `draws` is a fact, a price ceiling is arithmetic. Neither is Jev's job.
    choose_generator: {
      code: async (state) => {
        const affordable = shortlist(await catalog(), {
          draws: true,
          maxPromptUsdPerM: state["fidelity"] === "final" ? 100 : 10,
          limit: 20,
        });
        if (affordable.length === 0) throw new Error("no image generator within budget");
        // draft → cheapest; final → the priciest we allowed, as a proxy for best.
        const pick = state["fidelity"] === "final" ? affordable.at(-1)! : affordable[0]!;
        return { generator: pick.id, generator_price: pick.imageUsd };
      },
      reads: ["fidelity"],
      writes: ["generator", "generator_price"],
    },

    draw: {
      model: { from: "generator" },
      prompt: (state) =>
        `Create a ${String(state["picture_kind"])} for: ${String(state["goal"])}.` +
        (Number(state["needs_text"]) >= 0.7 ? " Legible text must appear in the image." : " No text in the image."),
      // [text, images] — positional, and only a model node writes this way.
      writes: ["caption", "image"],
      reads: ["goal", "picture_kind", "needs_text"],
    },

    send: { work: "deliver", reads: ["image"], writes: ["summary"] },
    hand_off: { work: "brief_a_human", reads: ["goal"], writes: ["summary"] },
  },

  edges: [
    // Arithmetic, in code, where it belongs. A score is a number.
    { from: "classify", to: "hand_off", when: (s) => Number(s["complexity"]) >= 1.8 },
    // Every declared option of picture_kind goes to the same place here, so one
    // default edge says it more honestly than three identical branches would.
    { from: "classify", to: "choose_generator" },
    { from: "choose_generator", to: "draw" },
    { from: "draw", to: "send" },
  ],

  entry: "classify",
  result: "summary",
});
