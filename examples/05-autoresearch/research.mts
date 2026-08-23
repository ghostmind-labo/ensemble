import { scene, z } from "@ghostmind-dev/ensemble";

/**
 * 05 — Autoresearch: propose → measure → keep or revert → repeat.
 *
 * One file may change (heuristic.mjs). One command measures it (measure.mjs).
 * One scalar decides (score, code-graded). The experiment node keeps a winner
 * and reverts everything else, and results.tsv is the audit trail.
 */
export default scene({
  name: "autoresearch",
  description: "Improve heuristic.mjs against a fixed metric, one experiment at a time",
  defaults: { model: "openrouter/anthropic/claude-sonnet-5" },

  research: {
    edit: "examples/05-autoresearch/heuristic.mjs",
    measure: "node examples/05-autoresearch/measure.mjs",
    metric: "score",
    budget: "30s",
    threshold: 0,            // the metric is deterministic — any gain is real
    log: "examples/05-autoresearch/results.tsv",
  },

  state: {
    iteration: z.number().int(),
    verdict: z.enum(["baseline", "keep", "revert", "crash"]),
    hypothesis: z.string(),
  },

  nodes: {
    propose: {
      runtime: "agent",
      prompt: [
        "You are running an experiment loop on examples/05-autoresearch/heuristic.mjs.",
        "Read the artefact and examples/05-autoresearch/measure.mjs (the metric — you cannot edit it,",
        "and must not special-case its data). Read examples/05-autoresearch/results.tsv to see what",
        "was tried. Make ONE focused change to heuristic.mjs with edit_file or write_file,",
        "keep it a pure function, then stop. Output the hypothesis behind the change.",
      ].join(" "),
      inputs: ["best", "verdict", "reason", "output"],
      outputs: ["hypothesis"],
      maxTurns: 8,
    },
    experiment: {
      runtime: "experiment",
      note: "hypothesis",      // logged beside the score in results.tsv
      outputs: ["iteration", "score", "best", "verdict", "reason", "output"],
    },
  },

  edges: [
    { from: "experiment", to: "propose", when: (s) => s.iteration <= 6 && s.best < 100 },
    { from: "propose", to: "experiment" },
  ],

  entry: "experiment",       // the first pass measures the baseline
  exit: "experiment",
});
