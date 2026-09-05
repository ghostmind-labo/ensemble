// A deliberately hard one: the optimal Golomb ruler with 12 marks.
//
// A Golomb ruler is a set of integer marks where every pairwise difference is
// distinct. The shortest 12-mark ruler has length 85 — found by exhaustive
// search, and the kind of thing a model cannot reason its way to. This scene
// exists to find out what a refine loop does against a problem it will
// probably not solve: the checker is pure arithmetic (fn, $0), so every score
// is real, and the refine node keeps the shortest VALID ruler seen.
import { scene, z } from "@ghostmind-dev/ensemble";

const MARKS = 12;
const OPTIMUM = 85;
const INVALID = 9999; // an invalid ruler scores worse than any valid one

export default scene({
  name: "golomb",
  defaults: { model: "openrouter/anthropic/claude-sonnet-5" },

  state: {
    ruler: z.array(z.number().int().nonnegative()),
    score: z.number(),
    converged: z.boolean(),
  },

  nodes: {
    proposer: {
      prompt: [
        `Propose a Golomb ruler with exactly ${MARKS} marks: a strictly increasing list of`,
        `non-negative integers starting at 0, such that ALL pairwise differences are distinct.`,
        `The goal is the SHORTEST possible ruler (smallest last mark). The known optimum is ${OPTIMUM}.`,
        "",
        "If `ruler` is present it is the best VALID ruler found so far — improve on it (shorter),",
        "or propose a different construction if you are stuck. `feedback` is the checker's",
        "verdict on your most recent attempt: if it lists colliding differences, that attempt was",
        "INVALID and discarded. `history` lists every round's score (length; 9999 = invalid).",
        "",
        "Work it out carefully: enumerate the differences before answering. Do not repeat a",
        "ruler that already failed. Reply with the json block only.",
      ].join("\n"),
      inputs: ["ruler", "best", "verdict", "reason", "feedback", "history"],
      outputs: ["ruler"],
    },

    check: {
      runtime: "fn",
      fn: (s) => {
        const r = s["ruler"];
        if (!Array.isArray(r) || r.length !== MARKS) {
          return { score: INVALID, feedback: `invalid: need exactly ${MARKS} marks, got ${Array.isArray(r) ? r.length : typeof r}` };
        }
        const marks = r as number[];
        for (let i = 1; i < marks.length; i++) {
          if (marks[i]! <= marks[i - 1]!) return { score: INVALID, feedback: `invalid: marks must be strictly increasing (position ${i}: ${marks[i - 1]} → ${marks[i]})` };
        }
        if (marks[0] !== 0) return { score: INVALID, feedback: "invalid: first mark must be 0" };
        const seen = new Map<number, string>();
        const collisions: string[] = [];
        for (let i = 0; i < marks.length; i++) {
          for (let j = i + 1; j < marks.length; j++) {
            const d = marks[j]! - marks[i]!;
            const pair = `${marks[j]}-${marks[i]}`;
            if (seen.has(d)) collisions.push(`${d} (${seen.get(d)} and ${pair})`);
            else seen.set(d, pair);
          }
        }
        if (collisions.length > 0) {
          return { score: INVALID, feedback: `invalid: ${collisions.length} colliding difference(s): ${collisions.slice(0, 8).join(", ")}${collisions.length > 8 ? ", …" : ""}` };
        }
        const length = marks[marks.length - 1]!;
        return { score: length, feedback: `valid ruler of length ${length} (optimum is ${OPTIMUM}, gap ${length - OPTIMUM})` };
      },
      inputs: ["ruler"],
      outputs: ["score", "feedback"],
    },

    keep: {
      runtime: "refine",
      candidate: "ruler",
      minimize: true,      // shorter is better
      patience: 4,         // hard problem: give it four misses before calling it
      target: OPTIMUM,
      outputs: ["ruler", "best", "verdict", "reason", "converged", "history"],
    },
  },

  edges: [
    { from: "proposer", to: "check" },
    { from: "check", to: "keep" },
    { from: "keep", to: "proposer", when: (s) => !s.converged, maxLoops: 12 },
  ],

  entry: "proposer",
  exit: "keep",
});
