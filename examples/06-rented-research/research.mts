// 06 — A research loop whose proposer is a RENTED coding agent.
//
// Example 05 uses the sealed mode (`research({ modify, evaluate, instruction })`),
// which always proposes with our own `runtime: "agent"`. This one needs opencode
// to do the editing, so it drops to the documented escape hatch: an ordinary
// scene with a scene-level `research:` block and `runtime: "experiment"` — the
// same measure / keep-or-revert machinery, with the proposer left open.
//
// The artefact starts at 42.9%: `parser.mjs` is `line.split(",")`, which knows
// nothing about quoting. The scorer is code — 21 RFC-4180 cases the artefact
// cannot see — so iteration 1 and iteration 20 are directly comparable.
//
// Run it from the REPO ROOT:
//   ensemble run examples/06-rented-research/research.mts "" --budget 0.25
//
// Needs `opencode` on PATH. It reads the same OPENROUTER_API_KEY.
import { scene, z } from "@ghostmind-dev/ensemble";

const HERE = "examples/06-rented-research";

/** How many experiments after the baseline. Small on purpose: this is cheap to watch. */
const ITERATIONS = 4;

export default scene({
  name: "rented-research",

  // The same block the sealed mode compiles to. `edit` is the artefact under
  // study; everything else in the repo is off limits to the keep/revert logic.
  research: {
    edit: `${HERE}/parser.mjs`,
    measure: `node ${HERE}/measure.mjs`,
    metric: "score",
    minimize: false,
    budget: "30s",
    threshold: 0,          // the scorer is deterministic, so there is no noise floor
    log: `${HERE}/results.tsv`,
  },

  state: {
    score: z.number(),
    best: z.number(),
    iteration: z.number(),
    verdict: z.string(),
    hypothesis: z.string().min(1),
  },

  nodes: {
    // ⧉ THE RENTED PROPOSER. opencode owns the editing loop — it reads the file,
    // rewrites it, and reports what it tried.
    //
    // `dir` is the safety boundary. A backend node's write access is opencode's
    // own, not ensemble's scoped tools, so `--dir` is what keeps it inside this
    // folder. Point it at the repo root and it could edit anything.
    propose: {
      runtime: "opencode",
      dir: HERE,
      model: "openrouter/deepseek/deepseek-v4-flash",
      timeout: 240,
      prompt: [
        "You are improving a CSV field parser.",
        "",
        "EDIT `parser.mjs` in your working directory — that file and nothing else.",
        "It must keep exporting `parseLine(line)` returning an array of strings.",
        "",
        "Implement real RFC-4180 field parsing: double-quoted fields, commas inside",
        "quotes, doubled quotes (\"\") meaning one literal quote, empty fields, and",
        "whitespace preserved outside quotes.",
        "",
        "Do NOT read or edit measure.mjs, and do not special-case specific inputs —",
        "hard-coding the test strings is a fabricated result, not a finding.",
        "",
        "When done, state your hypothesis: what you changed and why it should score better.",
      ].join("\n"),
      inputs: ["best", "score", "verdict", "reason", "output"],
      outputs: ["hypothesis"],
    },

    // 🔬 Measures under the budget, keeps the candidate only if it beats `best`,
    // restores the incumbent otherwise, and appends a row to results.tsv.
    experiment: {
      runtime: "experiment",
      note: "hypothesis",
      outputs: ["iteration", "score", "best", "verdict", "reason", "output"],
    },
  },

  edges: [
    // Loop back FIRST: first match wins, so the retry edge must precede the exit.
    { from: "experiment", to: "propose", when: (s) => Number(s.iteration) <= ITERATIONS },
    { from: "propose", to: "experiment" },
  ],

  // Entry is the EXPERIMENT, not the proposer: the first pass measures the
  // baseline, so there is something to beat before anything is changed.
  entry: "experiment",
  exit: "experiment",
});
