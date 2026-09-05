// Trivia night — the interactive-loop stress test.
//
// Humans in the loop FIVE times: every round the run parks on `collect`
// (an `always` ask node), the generated question travels in the pause's
// context, and the answers come back through resume. Score lives on the
// blackboard and survives every pause.
//
//   run routine trivia          # then answer with:
//   ensemble resume <run-dir> --answer players="Ana, Ben" --answer subject="space"
//   ensemble resume <run-dir> --answer answers="Ana: Mars — Ben: Venus"
//   …or let an agent drive it over MCP with resume_run.
import { scene, z } from "@ghostmind-dev/ensemble";

export default scene({
  name: "trivia",
  // Supplied from OUTSIDE the game, mid-run, through `answers` — no node
  // produces it. Declaring it here is what makes the judge's optional read
  // an honest dependency rather than a silently-missing one.
  inputs: ["house_rules"],
  description: "5-question quiz: questions generated on the fly, first correct answer takes the point.",
  defaults: { model: "openrouter/deepseek/deepseek-v4-flash" },

  state: {
    players: z.string().describe("comma-separated player names, e.g. 'Ana, Ben'"),
    subject: z.string(),
    round: z.number().int().min(1),
    trivia_question: z.string(),
    correct_answer: z.string(),
    asked: z.array(z.string()).describe("questions already used — NEVER repeat one"),
    answers: z.string().describe("who answered what, in order: 'Ana: Mars — Ben: Venus'"),
    scoreboard: z.record(z.number()),
    done: z.enum(["yes", "no"]),
    house_rules: z.string().describe("rule amendments the table agreed on mid-game; the judge must honour them"),
  },

  nodes: {
    host_intro: {
      prompt: [
        "You are a lively quiz host. In 3 short sentences: welcome everyone,",
        "explain that there are 5 questions and the FIRST correct answer takes",
        "the point, and say the highest score at the end wins.",
      ].join("\n"),
      outputs: ["welcome"],
    },

    // Pause #1 — the humans define the game.
    setup: {
      runtime: "ask",
      question: "Who is playing (comma-separated names), and what subject should the questions be about?",
      inputs: ["welcome"],
      outputs: ["players", "subject"],
    },

    open_board: {
      prompt: "Set up the game state. round is 1, done is 'no', asked is an empty list, and scoreboard has every player at 0.",
      inputs: ["players"],
      outputs: ["round", "scoreboard", "asked", "done"],
    },

    quizmaster: {
      prompt: [
        "Write ONE trivia question about the subject for this round.",
        "It must NOT repeat or resemble anything in `asked`. Make it answerable",
        "in a few words, and put the exact expected answer in `correct_answer`.",
        "Append the new question to `asked` and return the full list.",
      ].join("\n"),
      inputs: ["subject", "round", "asked"],
      outputs: ["trivia_question", "correct_answer", "asked"],
    },

    // Pause #2..#6 — `always`, so every round parks for fresh answers.
    collect: {
      runtime: "ask",
      always: true,
      question: "Players, answer! Reply in the order people answered: 'Name: answer — Name: answer'",
      inputs: ["round", "trivia_question", "scoreboard"],
      outputs: ["answers"],
    },

    judge: {
      prompt: [
        "You are the scorer. The answers are listed in the order given.",
        "The FIRST player whose answer matches `correct_answer` (be tolerant of",
        "spelling and phrasing) takes 1 point; if nobody is right, nobody scores.",
        "If `house_rules` is present it OVERRIDES the default scoring — the table",
        "agreed on it, so apply it faithfully and mention it when it decides a point.",
        "Update the scoreboard, write 2 sentences of lively commentary naming",
        "who scored and the correct answer, and increment `round` by 1.",
        "Set done to 'yes' if the round you just judged was round 5, else 'no'.",
      ].join("\n"),
      inputs: ["trivia_question", "correct_answer", "answers", "scoreboard", "round", "players", "house_rules"],
      outputs: ["scoreboard", "round", "commentary", "done"],
    },

    podium: {
      prompt: "Announce the final scoreboard and crown the winner with flair. 4 sentences max.",
      inputs: ["scoreboard", "players"],
      outputs: ["finale"],
    },
  },

  edges: [
    { from: "host_intro", to: "setup" },
    { from: "setup", to: "open_board" },
    { from: "open_board", to: "quizmaster" },
    { from: "quizmaster", to: "collect" },
    { from: "collect", to: "judge" },
    // Loop-back FIRST; maxLoops 4 = 5 rounds total, a hard backstop even if the
    // judge never says done.
    { from: "judge", to: "quizmaster", when: (s) => s.done !== "yes", maxLoops: 4 },
    { from: "judge", to: "podium" },
  ],

  entry: "host_intro",
  exit: "podium",
});
