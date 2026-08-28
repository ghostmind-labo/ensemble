/**
 * Autoresearch mode — the sealed form. Three things, and nothing else.
 *
 * `scene()` gives you the whole graph: any nodes, any edges, any topology. That
 * freedom is exactly wrong for an experiment loop, because the loop only works
 * if the thing being studied is the ONLY thing that varies. Karpathy's
 * autoresearch gets its power from what the researcher is NOT allowed to touch:
 * one file changes, one command scores it, and the directive is written once
 * and read identically on every iteration. Anything else you could turn into a
 * knob is a confound.
 *
 * So `research()` accepts exactly three keys and refuses every other by name:
 *
 *   modify      — the artefact under study. The one thing that may change.
 *   evaluate    — the command that scores it. Code, never a model judge.
 *   instruction — the research directive. Written once; never varies.
 *
 * No nodes, no edges, no entry, no exit, no state, no model, no prompts. The
 * loop is generated and identical for every research file in the world, which
 * is the point: two people's results are comparable because their scaffolding
 * is not a variable. Operational choices that do not shape the experiment
 * (which model proposes, how many iterations, the noise threshold) are run-time
 * flags on `ensemble research`, not keys in the file — the file is the
 * experiment, the flags are the session.
 *
 * The output is an ordinary Scene, so `validate`, `view`, `serve`, `resume`,
 * the MCP tools and the run store all work on it unchanged. This module adds a
 * front door, not a second engine.
 */
import { z } from "zod";
import type { SceneSpec } from "./dsl.ts";
import type { ResearchSpec } from "./research.ts";

/** The three things, and the shapes they may take. */
export interface ResearchProgram {
  /**
   * The artefact under study — the ONE thing the agent may change. A path, or
   * a few paths that must move together (a file and its header, say).
   */
  modify: string | string[];
  /**
   * How a candidate is scored. A shell command whose output carries a number:
   * `"python train.py"`, `"node bench.mjs"`. The object form pins which number
   * and which direction when the defaults are not enough.
   */
  evaluate:
    | string
    | {
        /** The command to run. Its exit code does not decide anything; the metric does. */
        command: string;
        /** Name of the metric in the output, e.g. "val_bpb". Default: the last number printed. */
        metric?: string;
        /** true when lower is better (a loss). Default false. */
        minimize?: boolean;
        /** Wall clock per experiment: "5m", "90s", seconds. Default "5m". */
        budget?: string | number;
      };
  /**
   * The research directive, read identically on every iteration — Karpathy's
   * `program.md`. Say what to aim for and what is off limits. It is deliberately
   * the only prose in the file, and deliberately constant: an instruction that
   * drifts between iterations makes the results incomparable.
   */
  instruction: string;
}

/** Why each rejected key is rejected — a refusal that teaches is worth writing. */
const REFUSALS: Record<string, string> = {
  nodes: "the loop is generated — a research program describes the experiment, not the graph",
  edges: "the loop is generated — propose → evaluate → keep or revert is the whole topology",
  entry: "the loop is generated — it always starts by measuring the baseline",
  exit: "the loop is generated — it ends when the iteration budget runs out",
  groups: "there is nothing to parallelise: experiments must be compared one at a time",
  state: "the blackboard is fixed (iteration, score, best, verdict) so results are comparable",
  defaults: "the proposing model is a run-time choice: ensemble research --model <ref>",
  model: "the proposing model is a run-time choice: ensemble research --model <ref>",
  prompt: "the directive is `instruction`, and it is the only prose the loop reads",
  iterations: "how long to run is a run-time choice: ensemble research --iterations <n>",
  threshold: "the noise floor is a run-time choice: ensemble research --threshold <n>",
  research: "you are already in research mode — `modify` and `evaluate` are that block",
  name: "the program is named by its file",
  goal: "the goal IS `instruction`, and it never changes",
};

const evaluateSchema = z.union([
  z.string().min(1),
  z
    .object({
      command: z.string().min(1),
      metric: z.string().min(1).optional(),
      minimize: z.boolean().optional(),
      budget: z.union([z.string(), z.number().positive()]).optional(),
    })
    .strict(),
]);

const programSchema = z
  .object({
    modify: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    evaluate: evaluateSchema,
    instruction: z.string().min(1),
  })
  .strict();

export class ProgramError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "ProgramError";
    this.problems = problems;
  }
}

/** Splits `evaluate` into the ResearchSpec fields the capability already knows. */
function evaluationOf(evaluate: ResearchProgram["evaluate"]): Omit<ResearchSpec, "edit"> {
  const e = typeof evaluate === "string" ? { command: evaluate } : evaluate;
  return {
    measure: e.command,
    ...(e.metric !== undefined ? { metric: e.metric } : {}),
    ...(e.minimize !== undefined ? { minimize: e.minimize } : {}),
    budget: e.budget ?? "5m",
    log: "results.tsv",
  };
}

/**
 * The proposer's operating instructions.
 *
 * Two halves, and the split is load-bearing. The fixed half is method — one
 * change at a time, read the log, do not touch the evaluator — and is identical
 * for every program so that it is never a variable between experiments. The
 * user's `instruction` is the only part that differs, and it is quoted verbatim
 * on every iteration.
 */
function proposerPrompt(program: ResearchProgram, targets: string[], measure: string): string {
  return [
    "You are running one iteration of an experiment loop.",
    "",
    "THE DIRECTIVE (fixed for every iteration — read it as written):",
    program.instruction.trim(),
    "",
    "METHOD (not negotiable):",
    `- The ONLY thing you may change is: ${targets.join(", ")}.`,
    "  Your write tools refuse every other path, by design. Do not try to work around it.",
    `- It is scored by: ${measure}`,
    "  You may READ that command's script to understand the metric. You may never",
    "  change it, and you must never special-case its inputs — optimising the",
    "  scorer instead of the artefact is a fabricated result, not a finding.",
    "- Read results.tsv first. It lists every previous attempt, its score, and",
    "  whether it was kept or reverted. Do not re-propose a change that was",
    "  already reverted; a revert is evidence, so use it.",
    "- Make ONE focused, motivated change per iteration. A change big enough to",
    "  bundle two ideas cannot be attributed when the score moves.",
    "- Then STOP. You do not run the evaluation — the loop does that, under a",
    "  fixed time budget, and keeps or reverts your change on the measurement.",
    "",
    "Report the hypothesis behind your change in one sentence: what you altered",
    "and why you expect it to move the metric.",
  ].join("\n");
}

/**
 * Builds the sealed loop.
 *
 * `entry` is the experiment node, not the proposer: the first pass measures
 * whatever is already on disk, which is the baseline every later candidate is
 * compared against. Starting at the proposer would overwrite the baseline
 * before it was ever measured.
 */
/**
 * Who proposes. Not a key in the program file — the artefact and the metric
 * define the experiment; which model does the thinking is a property of the
 * session, overridden by `--model` and by this env var for a whole machine.
 * It is defaulted rather than omitted so a program file is a VALID scene on its
 * own: `ensemble validate` and `view` work with nothing else supplied.
 */
export const defaultProposer = (): string =>
  process.env["ENSEMBLE_RESEARCH_MODEL"] ?? "openrouter/anthropic/claude-sonnet-5";

/** The reminder every refusal ends with — the mode in one line. */
const THREE_THINGS =
  "    A program is: modify (what may change) · evaluate (how it is scored) · instruction (the directive).";

const REQUIRED: Array<[keyof ResearchProgram, string]> = [
  ["modify", "the artefact under study — the one thing the loop may change"],
  ["evaluate", "the command that scores it — code, never a model judge"],
  ["instruction", "the research directive, read identically on every iteration"],
];

export function research(program: ResearchProgram): SceneSpec {
  // Presence and extra keys are checked BEFORE shapes, because in a mode whose
  // whole purpose is refusal the error message is the interface: "modify:
  // Invalid input" from a union teaches nothing, and a missing key and a
  // forbidden key are different mistakes deserving different sentences.
  if (typeof program !== "object" || program === null || Array.isArray(program)) {
    throw new ProgramError([`research() takes an object.\n${THREE_THINGS}`]);
  }
  const supplied = Object.keys(program);
  const missing = REQUIRED.filter(([key]) => program[key] === undefined);
  const extra = supplied.filter((key) => !REQUIRED.some(([k]) => k === key));
  if (missing.length > 0 || extra.length > 0) {
    throw new ProgramError([
      ...missing.map(([key, why]) => `research() requires "${key}" — ${why}.\n${THREE_THINGS}`),
      ...extra.map(
        (key) =>
          `research() does not accept "${key}" — ${REFUSALS[key] ?? "a research program is exactly three things"}.\n${THREE_THINGS}`,
      ),
    ]);
  }

  const parsed = programSchema.safeParse(program);
  if (!parsed.success) {
    throw new ProgramError(
      parsed.error.issues.map((issue) => `${String(issue.path[0] ?? "<root>")}: ${issue.message}`),
    );
  }

  const targets = Array.isArray(program.modify) ? program.modify : [program.modify];
  const evaluation = evaluationOf(program.evaluate);

  return {
    name: "autoresearch",
    description: program.instruction.trim().split("\n")[0]!.slice(0, 120),
    research: { edit: program.modify, ...evaluation } as ResearchSpec,
    defaults: { model: defaultProposer() },

    nodes: {
      propose: {
        runtime: "agent",
        prompt: proposerPrompt(program, targets, evaluation.measure),
        // What the proposer is told about the last experiment. `output` carries
        // the evaluator's own tail, so a crash is debuggable from inside the loop.
        inputs: ["best", "score", "verdict", "reason", "output"],
        outputs: ["hypothesis"],
        maxTurns: 12,
      },
      evaluate: {
        runtime: "experiment",
        note: "hypothesis",
        outputs: ["iteration", "score", "best", "verdict", "reason", "output"],
      },
    },

    edges: [
      // maxLoops is rewritten from --iterations before the run; the default is
      // a sane unattended session rather than an unbounded one.
      { from: "evaluate", to: "propose", maxLoops: 10 },
      { from: "propose", to: "evaluate" },
    ],

    entry: "evaluate",
    exit: "evaluate",
  };
}

/** The generated edge whose budget `--iterations` sets. */
export const ITERATION_EDGE = 0;

/** True when a loaded scene came from `research()` — the CLI routes on this. */
export function isProgram(scene: { name: string; research?: unknown }): boolean {
  return scene.name === "autoresearch" && scene.research !== undefined;
}
