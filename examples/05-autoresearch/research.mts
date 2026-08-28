import { research } from "@ghostmind-dev/ensemble";

/**
 * 05 — Autoresearch: three things, and nothing else.
 *
 * There is no graph here, and that is the feature. A loop that measures its own
 * changes only means something if the artefact is the only thing that varies —
 * so the mode accepts the artefact, the scorer, and the directive, generates
 * the loop itself, and refuses every other key.
 */
export default research({
  // 1 · what may change — the ONE artefact under study
  modify: "examples/05-autoresearch/heuristic.mjs",

  // 2 · how it is scored — code, never a model judge
  evaluate: {
    command: "node examples/05-autoresearch/measure.mjs",
    metric: "score",
    budget: "30s",
  },

  // 3 · the directive — written once, read identically every iteration
  instruction: `
Raise the spam-classification accuracy of heuristic.mjs.

isSpam(message) must stay a pure function: no I/O, no network, no randomness,
no reading the test data. Generalisable signals only — the kinds of things that
would still work on messages you have not seen (urgency, money, credentials,
link shorteners, prize language). Hard-coding the sample sentences is a
fabricated result, not a finding.
  `.trim(),
});
