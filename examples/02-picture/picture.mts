/**
 * 02 · picture — "I need this kind of image", and the system picks the backend.
 *
 * Three things this one shows that 01 does not:
 *
 *   · all three question types in ONE request, answered in parallel — the
 *     classification, a yes/no, and a difficulty score cost one round trip
 *     together, so asking speculatively is close to free;
 *   · a `when:` edge doing the arithmetic, because Jev is documented as
 *     unreliable at comparing numbers and this is a comparison;
 *   · handlers that call different backends — the graph never learns what
 *     "Claude" or "OpenRouter" is, only which handler a branch leads to.
 *
 *   ensemble run examples/02-picture/picture.mts "a hero image for the launch page"
 */
import { choice, noul, runner, score } from "../../src/index.ts";

export default runner({
  name: "make-a-picture",
  description: "Classify an image request and route it to the backend that suits it.",
  inputs: ["goal", "brand_kit"],

  work: {
    // Each of these is YOUR call. Report what it cost and what served it, and
    // the run record stays honest even though the runner made no request.
    photo: async ({ goal, report, signal }) => {
      report({ cost: 0.021, meta: { provider: "gemini", model: "nano-banana-pro" } });
      void signal;
      return `photo.png for ${JSON.stringify(goal)}`;
    },
    diagram: async ({ goal, report }) => {
      report({ cost: 0.043, meta: { provider: "anthropic", model: "claude-sonnet-5" } });
      return `diagram.svg for ${JSON.stringify(goal)}`;
    },
    logo: async ({ goal, report }) => {
      report({ cost: 0.038, meta: { provider: "openrouter", model: "openai/gpt-image-2.5" } });
      return `logo.svg for ${JSON.stringify(goal)}`;
    },
    chart: ({ goal }) => `chart.svg for ${JSON.stringify(goal)}`, // local, free
    text_image: async ({ goal, report }) => {
      report({ cost: 0.052, meta: { provider: "openai", model: "gpt-image-2.5" } });
      return `lettering.png for ${JSON.stringify(goal)}`;
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
          chart: { what: "A plot of supplied data", not_for: "A conceptual diagram" },
        }),
        // Legible text inside an image is a different capability. Worth its own
        // question, and it costs nothing extra because it rides along.
        needs_text: noul("Must legible words appear inside the image itself?", {
          true: { what: "Words must be rendered in the image and be readable" },
          false: { what: "No text, or text added afterwards in a layout tool" },
        }),
        complexity: score("How demanding is this request?", [
          { what: "One subject, no constraints" },
          { what: "Several elements, or a style to match" },
          { what: "Precise layout or a brand system to honour" },
        ]),
      },
      reads: ["goal", "brand_kit"],
      gate: { on: "picture_kind", min: 0.75, to: "hand_off" },
    },

    lettering: { work: "text_image", reads: ["goal"], writes: ["image"] },
    gen_photo: { work: "photo", reads: ["goal"], writes: ["image"] },
    gen_diagram: { work: "diagram", reads: ["goal"], writes: ["image"] },
    gen_logo: { work: "logo", reads: ["goal", "brand_kit"], writes: ["image"] },
    gen_chart: { work: "chart", reads: ["goal"], writes: ["image"] },
    hand_off: { work: "brief_a_human", reads: ["goal"], writes: ["image"] },
  },

  // Declaration order matters: first match wins.
  edges: [
    // Arithmetic, in code, where it belongs. A score is a number.
    { from: "classify", to: "hand_off", when: (s) => Number(s["complexity"]) >= 1.8 },
    // A noul branch, with an explicit threshold rather than the 0.5 default.
    { from: "classify", to: "lettering", on: "needs_text>=0.7" },
    // Meaning, declared. Every option below is checked by `validate`.
    { from: "classify", to: "gen_photo", on: "picture_kind=photo" },
    { from: "classify", to: "gen_diagram", on: "picture_kind=diagram" },
    { from: "classify", to: "gen_logo", on: "picture_kind=logo" },
    { from: "classify", to: "gen_chart", on: "picture_kind=chart" },
  ],

  entry: "classify",
  result: "image",
});
