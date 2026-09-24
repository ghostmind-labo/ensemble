/**
 * The front door.
 *
 * `runner()` is almost an identity function. It takes the declarative spec and
 * hands back something callable, with the three things you ever do to a runner
 * hanging off it: run it, prove it, or emit it.
 *
 * It deliberately does NOT validate at construction. A broken runner must stay
 * inspectable — `graph()` and `validate()` are exactly what you reach for when
 * something is wrong, and a factory that threw on import would take them away
 * at the moment they are needed. `execute` is what refuses.
 */
import { execute, resume, type HumanAnswer, type Paused, type RunOptions, type RunOutcome } from "./execute.ts";
import { toGraph, type GraphDoc } from "./graph.ts";
import { validate } from "./validate.ts";
import type { RunnerSpec, State } from "./spec.ts";

export interface Runner {
  /** Run it. Throws RunnerError if the spec does not validate, RunFailed if a node does. */
  (inputs?: State, options?: RunOptions): Promise<RunOutcome>;
  /** Continue a run that paused for a person, with their answer. */
  resume(paused: Paused, answer: HumanAnswer, options?: RunOptions): Promise<RunOutcome>;
  readonly spec: RunnerSpec;
  /** The structure, as data. Free and offline. */
  graph(): GraphDoc;
  /** Problems, as plain strings. Empty means sound. Free and offline. */
  validate(): string[];
}

export function runner(spec: RunnerSpec): Runner {
  const call = (inputs: State = {}, options: RunOptions = {}): Promise<RunOutcome> =>
    execute(spec, inputs, options);

  return Object.assign(call, {
    spec,
    resume: (paused: Paused, answer: HumanAnswer, options: RunOptions = {}): Promise<RunOutcome> =>
      resume(spec, paused, answer, options),
    graph: (): GraphDoc => toGraph(spec),
    validate: (): string[] => validate(spec),
  });
}

/** Is this the default export of a runner file? Used by the CLI, and by you. */
export const isRunner = (value: unknown): value is Runner =>
  typeof value === "function" && typeof (value as Runner).graph === "function" && "spec" in value;
