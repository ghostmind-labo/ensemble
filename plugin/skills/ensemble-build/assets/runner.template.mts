/**
 * __NAME__ — __ONE_LINE_PURPOSE__
 *
 * Decisions (Jev, meaning):   __list the questions and why each is a judgement__
 * Arithmetic (code / when):   __counts, thresholds, dates, prices__
 * Perception / writing:       __model nodes, if any — and why a model is needed__
 * Effects (work handlers):    __what the caller's code does at each exit__
 *
 *   npx ensemble validate __PATH__      # free, offline
 *   npx ensemble graph    __PATH__ | jq  # free, offline
 *   npx ensemble run      __PATH__ "…" --budget 0.05
 */
import { choice, noul, runner, score } from "@ghostmind-dev/ensemble";

export default runner({
  name: "__NAME__",
  description: "__ONE_LINE_PURPOSE__",
  // Every key that arrives from outside the run. `goal` is always one.
  inputs: ["goal"],

  // The caller's code, by name. Each handler gets { goal, state, signal, report }.
  // Return the BARE value for a one-key write — { x: 1 } for writes: ["x"] nests.
  work: {
    act_a: ({ goal }) => `TODO: act on ${goal}`,
    act_b: ({ goal }) => `TODO: act on ${goal}`,
    escalate: ({ goal }) => `TODO: hand to a person: ${goal}`,
  },

  nodes: {
    classify: {
      decide: {
        route: choice("__ONE atomic question__", {
          a: { what: "__what belongs here__", not_for: "__what belongs in b instead__" },
          b: { what: "__what belongs here__", not_for: "__what belongs in a instead__" },
        }),
      },
      reads: ["goal"], // the ONLY state Jev sees — keep it minimal
      gate: { on: "route", min: 0.7, to: "escalate" },
    },
    do_a: { work: "act_a", reads: ["goal"], writes: ["reply"] },
    do_b: { work: "act_b", reads: ["goal"], writes: ["reply"] },
    escalate: { work: "escalate", reads: ["goal"], writes: ["reply"] },
  },

  edges: [
    { from: "classify", to: "do_a", on: "route=a" },
    { from: "classify", to: "do_b", on: "route=b" },
  ],

  entry: "classify",
  result: "reply",
});
