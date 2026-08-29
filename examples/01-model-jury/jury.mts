// Three vendors answer the same question independently and in parallel, then a
// foreman reads all three and synthesises one answer — naming where they agreed,
// where they disagreed, and which was strongest.
//
// The jurors deliberately receive NO `inputs`. They only see the goal, so none of
// them can be anchored by another's answer. Independence is the whole point.
//
// Every node here is runtime "model" (the default): a direct OpenRouter call.
// No tools, no skills — pure model calls, no subprocess, nothing to install.
import { scene } from "@ghostmind-dev/ensemble";

const jurorPrompt = [
  "Answer the goal directly and concretely in about 150 words.",
  'Lead with your actual position — no throat-clearing, no "it depends"',
  "unless you then say what it depends on.",
  "State the single strongest objection to your own answer.",
].join("\n");

export default scene({
  name: "model-jury",

  defaults: {
    model: "openrouter/anthropic/claude-sonnet-5",
  },

  nodes: {
    juror_anthropic: {
      model: "openrouter/anthropic/claude-sonnet-5",
      description: "Anthropic's take.",
      prompt: jurorPrompt,
      outputs: ["answer_anthropic"],
    },
    juror_google: {
      model: "openrouter/google/gemini-2.5-pro",
      description: "Google's take.",
      prompt: jurorPrompt,
      outputs: ["answer_google"],
    },
    juror_deepseek: {
      model: "openrouter/deepseek/deepseek-v4-flash",
      description: "DeepSeek's take.",
      prompt: jurorPrompt,
      outputs: ["answer_deepseek"],
    },

    foreman: {
      model: "openrouter/anthropic/claude-sonnet-5",
      description: "Reads all three and returns one answer.",
      prompt: [
        "You are the jury foreman. You have three independent answers to the same",
        "question, each from a different model.",
        "",
        "Produce:",
        "  - `consensus`  — what all three agreed on, in markdown.",
        "  - `dissent`    — where they genuinely disagreed, and who was right.",
        "                   If they all agreed, say so plainly. Do not invent conflict.",
        "  - `strongest`  — which juror gave the most useful answer: exactly one of",
        '                   "anthropic", "google", or "deepseek".',
        "  - `answer`     — the single best answer to the original goal, built from",
        "                   the strongest parts of all three. This is what the user reads.",
      ].join("\n"),
      inputs: ["answer_anthropic", "answer_google", "answer_deepseek"],
      outputs: ["consensus", "dissent", "strongest", "answer"],
    },
  },

  groups: {
    // All three run concurrently; the engine merges their outputs before `foreman`.
    jury: ["juror_anthropic", "juror_google", "juror_deepseek"],
  },

  edges: [{ from: "jury", to: "foreman" }],

  entry: "jury",
  exit: "foreman",
});
