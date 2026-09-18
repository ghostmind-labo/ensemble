/**
 * The three questions, and nothing else.
 *
 * Jev answers in exactly three shapes — a yes/no probability, one option out of
 * a declared set, and a position on a declared rubric. That closed answer space
 * is the whole reason this library exists: because the options are written down
 * before anything runs, every branch of every decision is knowable statically.
 * A router built on a generative model cannot make that promise, and a graph
 * you cannot enumerate is a graph you cannot draw, prove, or replay.
 *
 * So the builders here do two jobs. They carry the types that make an answer
 * typed at the call site, and they refuse a question the API would reject —
 * at authoring time, where the fix is free.
 */

/** A description Jev reads. Prose works; the object form draws the boundary. */
export type Description =
  | string
  | {
      /** What belongs here. */
      what?: string;
      /** What belongs in the NEIGHBOURING option instead — the field that earns its keep. */
      not_for?: string;
      examples?: string[];
      summary?: string;
      signals?: string[];
      [field: string]: unknown;
    };

/** What the question asks. The object form separates guidance that would otherwise blur. */
export type Instructions =
  | string
  | {
      question?: string;
      focus?: string;
      /** A backticked state path, e.g. "`ticket.message`". */
      inspect?: string;
      compare?: string[];
      [field: string]: unknown;
    };

export interface ChoiceQuestion<O extends string = string> {
  readonly type: "choice";
  readonly instructions: Instructions;
  readonly criteria: Readonly<Record<O, Description | null>>;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: Instructions;
  /** Ordered low → high. Level numbers come from position; Jev never sees them. */
  readonly criteria: readonly Description[];
}

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: Instructions;
  readonly criteria?: { readonly true: Description; readonly false: Description };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/** API limits, enforced here so a typo fails before it costs a request. */
export const CHOICE_MAX_OPTIONS = 255;
export const SCORE_MIN_LEVELS = 2;
export const SCORE_MAX_LEVELS = 10;

/**
 * One of a declared set. The option names are the branch labels of the graph,
 * so they must read as identifiers a human can follow in a diagram.
 */
export function choice<O extends string>(
  instructions: Instructions,
  criteria: Record<O, Description | null>,
): ChoiceQuestion<O> {
  const options = Object.keys(criteria);
  if (options.length < 2) {
    throw new TypeError(
      `choice() needs at least 2 options, got ${options.length}. A one-option choice is not a decision.`,
    );
  }
  if (options.length > CHOICE_MAX_OPTIONS) {
    throw new TypeError(
      `choice() accepts at most ${CHOICE_MAX_OPTIONS} options, got ${options.length}. ` +
        `Filter the candidates in code first, then ask.`,
    );
  }
  return { type: "choice", instructions, criteria };
}

/**
 * A position on an ordered rubric. The answer is the EXPECTED value across the
 * levels, so it is fractional: 1.3 means mostly level 1 with some level 2.
 */
export function score(instructions: Instructions, levels: readonly Description[]): ScoreQuestion {
  if (levels.length < SCORE_MIN_LEVELS || levels.length > SCORE_MAX_LEVELS) {
    throw new TypeError(
      `score() needs between ${SCORE_MIN_LEVELS} and ${SCORE_MAX_LEVELS} levels, got ${levels.length}.`,
    );
  }
  return { type: "score", instructions, criteria: levels };
}

/** Yes or no, as a probability. There is no separate confidence: the number IS the confidence. */
export function noul(
  instructions: Instructions,
  criteria?: { true: Description; false: Description },
): NoulQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

/* ─────────────────────────────── answers ─────────────────────────────── */

export interface ChoiceAnswer<O extends string = string> {
  readonly type: "choice";
  readonly choice: O;
  /** 0–1, derived from how concentrated the distribution is. */
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface ScoreAnswer {
  readonly type: "score";
  /** Σ(level × P(level)) — fractional by design. */
  readonly score: number;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly legend: Readonly<Record<string, string>>;
}

export interface NoulAnswer {
  readonly type: "noul";
  /** P(yes). Near 1 is a strong yes, near 0 a strong no, near 0.5 genuinely unsure. */
  readonly noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type AnswerFor<Q> = Q extends ChoiceQuestion<infer O>
  ? ChoiceAnswer<O>
  : Q extends ScoreQuestion
    ? ScoreAnswer
    : Q extends NoulQuestion
      ? NoulAnswer
      : never;

export type AnswersFor<Q extends Record<string, Question>> = { [K in keyof Q]: AnswerFor<Q[K]> };

/**
 * The plain value an answer contributes to state.
 *
 * State stays boring on purpose — `state.picture_kind === "photo"`, not a
 * nested answer object — so a `when` predicate reads like ordinary code. The
 * full answer, distribution and all, goes to the run record instead.
 */
export function valueOf(answer: Answer): string | number {
  switch (answer.type) {
    case "choice":
      return answer.choice;
    case "score":
      return answer.score;
    case "noul":
      return answer.noul;
  }
}

/** Confidence, where the question has one. Noul reports none — its value is its certainty. */
export function confidenceOf(answer: Answer): number | undefined {
  return answer.type === "noul" ? undefined : answer.confidence;
}

/** The declared options of a choice — the branch labels the validator checks against. */
export function optionsOf(question: Question): string[] {
  return question.type === "choice" ? Object.keys(question.criteria) : [];
}
