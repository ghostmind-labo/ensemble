/**
 * The public surface.
 *
 * Nine names do the work: `runner` to define one, `choice` / `score` / `noul`
 * to ask, and the rest to prove, emit or run it. Everything else exported here
 * is a type, or a seam someone will eventually need — `jev` to configure the
 * decider, `Decider` to replace it.
 */
export { runner, isRunner } from "./runner.ts";
export type { Runner } from "./runner.ts";

export {
  choice,
  score,
  noul,
  valueOf,
  confidenceOf,
  optionsOf,
  CHOICE_MAX_OPTIONS,
  SCORE_MIN_LEVELS,
  SCORE_MAX_LEVELS,
} from "./questions.ts";
export type {
  Answer,
  AnswerFor,
  AnswersFor,
  ChoiceAnswer,
  ChoiceQuestion,
  Description,
  Instructions,
  NoulAnswer,
  NoulQuestion,
  Question,
  ScoreAnswer,
  ScoreQuestion,
} from "./questions.ts";

export { jev, JevError, DEFAULT_BASE_URL, DEFAULT_MODEL, USD_PER_INPUT_TOKEN } from "./jev.ts";
export type { Decider, Decision, JevConfig } from "./jev.ts";

export { execute, RunFailed, RunnerError, RUN_SCHEMA } from "./execute.ts";
export type { RunDoc, RunEvent, RunOptions, RunOutcome, RunStatus, RunStep, StepAnswer } from "./execute.ts";

export { toGraph, GRAPH_SCHEMA } from "./graph.ts";
export type { GraphDoc, GraphEdge, GraphNode, GraphQuestion } from "./graph.ts";

export { validate } from "./validate.ts";

export { reporter, summarise, money } from "./report.ts";
export type { ReporterOptions } from "./report.ts";

export { branchHolds, parseBranch, probeReads, producers, readsOf, writesOf } from "./spec.ts";
export type {
  Branch,
  CodeNode,
  DecideNode,
  Edge,
  Handler,
  HandlerContext,
  NodeSpec,
  RunnerSpec,
  State,
  WorkNode,
} from "./spec.ts";
