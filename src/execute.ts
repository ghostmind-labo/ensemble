/**
 * The cursor, and the record it leaves.
 *
 * Small on purpose. The engine walks one node at a time per lane, asks the decider when
 * it reaches a decide node, calls YOUR handler when it reaches a work node, and
 * writes down what happened. It holds no prompt of its own and decides nothing a
 * node did not ask: where a model node names one, the instruction is the node's
 * and the call goes out through the one seam in `openrouter.ts`.
 *
 * What it will not do is as important as what it does. It refuses to start a
 * run that does not validate, because a graph with an unhandled branch fails
 * silently at the exit rather than loudly at the fault. And it records every
 * decision as its full distribution, not just the winner — a run you can only
 * read as "the critic rejected it" is a run you cannot audit.
 */
import {
  branchHolds,
  edgeId,
  forksFrom,
  isCode,
  isDecide,
  isMcp,
  isModel,
  isWork,
  parseBranch,
  readsOf,
  writesOf,
  type DecideNode,
  type Edge,
  type NodeSpec,
  type RunnerSpec,
  type State,
} from "./spec.ts";
import { confidenceOf, misfit, valueOf, type Answer } from "./questions.ts";
import { jev, jevConfigFor, type Decider } from "./jev.ts";
import { openrouter, type Caller } from "./openrouter.ts";
import { pool } from "./mcp.ts";
import { findSkill, renderSkills } from "./skills.ts";
import { validate } from "./validate.ts";
import { toGraph, type GraphQuestion } from "./graph.ts";

export const RUN_SCHEMA = "https://ghostmind.dev/ensemble/run-v1.json";

export type RunStatus = "completed" | "failed" | "maxSteps" | "budget" | "cancelled" | "paused";

export interface StepAnswer {
  type: "choice" | "score" | "noul";
  /** The option name, the score, or P(yes) — what landed on the blackboard. */
  value: string | number;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

export interface RunStep {
  n: number;
  node: string;
  kind: "decide" | "work" | "code" | "model" | "mcp";
  /** The lane this step ran on: "main", the forking edge that started it, or the join node that merged it. */
  lane: string;
  started: string;
  ended: string;
  ms: number;
  cost: number;
  /** The state the node was given — its declared reads, as they were. What an audit or a replay needs. */
  asked?: Record<string, unknown>;
  answers?: Record<string, StepAnswer>;
  gate?: { on: string; passed: boolean; min: number; measured: number };
  handler?: string;
  meta?: Record<string, unknown>;
  writes?: Record<string, unknown>;
  error?: string;
  /**
   * The edge id taken, "gate" when the confidence gate fired, "fallback" when the
   * decider could not answer at all, or null at the exit.
   */
  took: string | null;
  /** The forking edges that fired from here, each starting a lane. `took` is then null. */
  forked?: string[];
}

export interface RunDoc {
  $schema: string;
  version: 1;
  run: {
    id: string;
    runner: string;
    /** The graph hash this run walked — join it to graph.json. */
    graph: string;
    goal: string;
    started: string;
    ended: string;
    status: RunStatus;
    cost: { total: number; currency: "USD" };
  };
  steps: RunStep[];
  state: State;
  /** Only when `status` is "paused": what the run is waiting for a person to answer. */
  pending?: Pending;
}

/**
 * What a paused run is waiting for — the half a person or a UI reads. The
 * questions are in graph.json's readable form, so the same renderer that draws
 * the graph can draw the question.
 */
export interface Pending {
  node: string;
  questions: GraphQuestion[];
  /** What the person should be shown: the node's declared reads, as they were. */
  asked: State;
  /** Present when the node takes a free-text note, and names where it will land. */
  comment?: string;
}

/**
 * Everything needed to continue a paused run later, in another process. Plain
 * JSON — store it in a file, a row, a queue. `resume` refuses it if the graph
 * has changed since, because the node, the edges and the loop budgets it
 * refers to might no longer mean the same thing.
 */
export interface Paused {
  version: 1;
  runner: string;
  /** The graph hash it paused on. */
  graph: string;
  run: { id: string; started: string };
  /** The node waiting for a person, and the lane it is on. */
  node: string;
  lane: string;
  state: State;
  steps: RunStep[];
  /** Loop budgets already spent, by edge index — a pause must not reset them. */
  taken: Array<[number, number]>;
  total: number;
  pending: Pending;
}

/** What a `human` handler is asked. */
export interface HumanRequest {
  run: string;
  node: string;
  questions: GraphQuestion[];
  asked: State;
  /** Present when the node takes a free-text note: offer a box for it. */
  comment?: string;
  signal: AbortSignal;
}

/**
 * A person's answer. One value per question: an option name for a choice,
 * yes/no for a noul (`true`/`false`, or "yes"/"no"), a 0-based level for a score.
 */
export interface HumanAnswer {
  answers: Record<string, string | number | boolean>;
  /** Who answered, for the record. */
  by?: string;
  /** A free-text note, written to the node's `comment` key when it declares one. */
  comment?: string;
}

/**
 * Ask a person, and wait. Return the answer, or `undefined` to pause the run and
 * be resumed later. A terminal prompt, a chat message with buttons, a form —
 * anything that can turn the questions into an answer.
 */
export type Human = (request: HumanRequest) => HumanAnswer | undefined | Promise<HumanAnswer | undefined>;

/**
 * What a run says as it happens.
 *
 * Three events, because a live view needs exactly two things the record cannot
 * give it: that a node has STARTED, and what it is waiting on. Everything else
 * is already in the step. Keeping the vocabulary this small is what lets a
 * terminal reporter and any future renderer consume the same stream without
 * either becoming the other's constraint.
 *
 * One asymmetry to know about: a node that PAUSES for a person emits
 * `node:start` and no `node:end`, because it did not run — its step is removed
 * from the record and the same node will start again on resume. `run:end`
 * always follows, with `status: "paused"`, so anything holding per-node state
 * should clear it there rather than wait for an end that is not coming.
 */
export type RunEvent =
  | {
      type: "node:start";
      n: number;
      node: string;
      kind: RunStep["kind"];
      lane: string;
      /** For a person to read. Prose, so never branch on it — that is what `asks` is for. */
      waiting: string;
      /**
       * True when this step is about to ask a PERSON and wait. A view needs it
       * structurally: a spinner would paint over the question, and the wait is
       * unbounded. Derived from the node, not from parsing `waiting`.
       */
      asks?: "human";
    }
  | { type: "node:end"; step: RunStep }
  | { type: "run:end"; run: RunDoc };

export interface RunOptions {
  /** Hard cap on node executions. Default 50. */
  maxSteps?: number;
  /** Stop once total cost exceeds this, in USD. */
  budget?: number;
  /**
   * Fail any step still running after this many ms, and abort its signal.
   * Off by default. A loop meant to live for days needs it: one handler that
   * never returns would otherwise stall the whole thing without a sound.
   */
  stepTimeout?: number;
  signal?: AbortSignal;
  /** Swap the decider — a fallback model, a cache, a stub in a test. */
  decider?: Decider;
  /** Swap the generative caller — a stub, a cache, another vendor. */
  caller?: Caller;
  /**
   * Answers `by: "human"` nodes. Without it, a run that reaches one PAUSES and
   * hands back a snapshot; with it, the run waits for this. A person's wait is
   * not subject to `stepTimeout`, which exists for machines that hang.
   */
  human?: Human;
  /** Live progress. Fires before a node runs and again when it finishes. */
  onEvent?: (event: RunEvent) => void;
}

export interface RunOutcome {
  result: unknown;
  state: State;
  run: RunDoc;
  /** Present when the run is waiting for a person. Pass it to `resume` with their answer. */
  paused?: Paused;
}

/** A paused run cannot be continued as given. Nothing ran. */
export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

/** A person's answer does not fit the questions. Deliberately NOT a reason to fall back: it is a bug to fix. */
export class HumanAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanAnswerError";
  }
}

/**
 * The decider answered outside the question it was asked.
 *
 * A separate class because a host app must be able to tell this apart from its
 * own handler throwing: this one says the classifier — or whatever was mounted
 * on the `Decider` seam — returned something the graph cannot route, which is an
 * upstream fault, not a bug in the workflow. It IS a reason to take `fallback`:
 * an answer that does not fit is no answer.
 */
export class DeciderAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeciderAnswerError";
  }
}

/** The runner does not validate — refuse to run it. */
export class RunnerError extends Error {
  readonly problems: string[];
  constructor(name: string, problems: string[]) {
    super(`runner "${name}" has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  - ${problems.join("\n  - ")}`);
    this.name = "RunnerError";
    this.problems = problems;
  }
}

/** A node threw. The partial record is attached, because that is where the answer is. */
export class RunFailed extends Error {
  readonly run: RunDoc;
  constructor(message: string, run: RunDoc, cause?: unknown) {
    super(message, { cause });
    this.name = "RunFailed";
    this.run = run;
  }
}

const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");

const pick = (state: Readonly<State>, keys: string[]): State =>
  Object.fromEntries(keys.map((key) => [key, state[key]]));

function toStepAnswer(answer: Answer): StepAnswer {
  const base: StepAnswer = { type: answer.type, value: valueOf(answer) };
  const confidence = confidenceOf(answer);
  if (confidence !== undefined) base.confidence = confidence;
  if (answer.type !== "noul") base.probabilities = { ...answer.probabilities };
  if (answer.type === "score") base.legend = { ...answer.legend };
  return base;
}

/**
 * Check a person's answer against the closed questions and turn it into state.
 * A yes lands as 1 and a no as 0 — a person's certainty — so `on: "ok>=0.6"`
 * means the same thing whoever answered.
 */
function fromHuman(
  name: string,
  node: DecideNode,
  answer: HumanAnswer,
): { written: Record<string, unknown>; recorded: Record<string, StepAnswer> } {
  const written: Record<string, unknown> = {};
  const recorded: Record<string, StepAnswer> = {};
  const keys = Object.keys(node.decide);
  for (const [key, question] of Object.entries(node.decide)) {
    const raw = answer?.answers?.[key];
    if (raw === undefined) {
      throw new HumanAnswerError(`node "${name}" asked a person "${key}" and got no answer — answer every question: ${keys.join(", ")}`);
    }
    if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      if (typeof raw !== "string" || !options.includes(raw)) {
        throw new HumanAnswerError(`node "${name}": "${key}" is one of ${options.join(", ")}, not ${JSON.stringify(raw)}`);
      }
      written[key] = raw;
    } else if (question.type === "noul") {
      const said = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
      const yes = said === true || said === 1 || said === "true" || said === "yes" || said === "y" || said === "1";
      const no = said === false || said === 0 || said === "false" || said === "no" || said === "n" || said === "0";
      if (!yes && !no) throw new HumanAnswerError(`node "${name}": "${key}" is yes or no, not ${JSON.stringify(raw)}`);
      written[key] = yes ? 1 : 0;
    } else {
      const level = typeof raw === "number" ? raw : Number(raw);
      const top = question.criteria.length - 1;
      if (!Number.isInteger(level) || level < 0 || level > top) {
        throw new HumanAnswerError(`node "${name}": "${key}" is a level from 0 to ${top}, not ${JSON.stringify(raw)}`);
      }
      written[key] = level;
    }
    recorded[key] = { type: question.type, value: written[key] as string | number };
  }
  // Always written when declared, even empty. Every other write key in the
  // system is unconditional, `graph.json` promises this one has a producer, and
  // validate lets a node downstream read it — so leaving it undefined when the
  // person skipped the box turns an empty note into a crash in someone's code.
  if (node.comment) {
    written[node.comment] = typeof answer.comment === "string" ? answer.comment.trim() : "";
  }
  return { written, recorded };
}

/**
 * A deep copy that is, provably, the plain JSON the snapshot claims to be.
 *
 * Named keys in the error because the fix is always in one state value, and
 * "Do not know how to serialize a BigInt" on its own does not say which.
 */
function plainJson<T>(value: T, node: string): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (cause) {
    const state = (value as { state?: State }).state ?? {};
    const culprits = Object.keys(state).filter((key) => {
      try {
        JSON.stringify(state[key]);
        return false;
      } catch {
        return true;
      }
    });
    throw new TypeError(
      `the run paused at "${node}" but its state cannot be stored as JSON` +
        `${culprits.length ? ` — ${culprits.map((key) => `"${key}"`).join(", ")} ${culprits.length === 1 ? "holds" : "hold"} something JSON cannot carry` : ""}` +
        ` (${(cause as Error).message}). A paused run is handed out as plain JSON to be kept in a file, ` +
        `a row or a queue, so write plain values: a date as an ISO string, a Map as an object`,
      { cause },
    );
  }
}

/** Image state may hold one url or several; a model node wants them flat either way. */
const asUrls = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** One key takes the value whole; several destructure it; none writes nothing. */
function applyWrites(node: string, keys: string[], value: unknown): Record<string, unknown> {
  if (keys.length === 0) return {};
  if (keys.length === 1) return { [keys[0]!]: value };
  if (typeof value !== "object" || value === null) {
    throw new TypeError(
      `node "${node}" declares writes ${keys.join(", ")} but returned ${typeof value} — ` +
        `a node writing several keys must return an object with them`,
    );
  }
  const record = value as Record<string, unknown>;
  const missing = keys.filter((key) => !(key in record));
  if (missing.length) {
    throw new TypeError(`node "${node}" returned no ${missing.join(", ")} — it declares writes ${keys.join(", ")}`);
  }
  return pick(record, keys);
}

export async function execute(
  spec: RunnerSpec,
  inputs: State = {},
  options: RunOptions = {},
  /** @internal — how `resume` re-enters. Use `resume()`. */
  from?: { paused: Paused; answer: HumanAnswer },
): Promise<RunOutcome> {
  const problems = validate(spec);
  if (problems.length) throw new RunnerError(spec.name, problems);

  const maxSteps = options.maxSteps ?? 50;
  const decider = options.decider ?? jev(jevConfigFor(spec.openrouter, spec.jev));
  const caller = options.caller ?? openrouter(spec.openrouter);
  const servers = pool(spec.mcpServers ?? {});
  const edges = spec.edges ?? [];
  const graphDoc = toGraph(spec);
  const graphHash = graphDoc.runner.hash;

  if (from) {
    const { paused } = from;
    if (paused?.version !== 1) throw new ResumeError(`this is not a paused ensemble run — expected version 1, got ${JSON.stringify(paused?.version)}`);
    if (paused.runner !== spec.name) {
      throw new ResumeError(`this run paused in "${paused.runner}", not "${spec.name}" — resume it with the runner that paused it`);
    }
    if (paused.graph !== graphHash) {
      throw new ResumeError(
        `the graph changed since this run paused (${paused.graph} → ${graphHash}), so its node, edges and loop budgets ` +
          `may no longer mean the same thing — resume with the graph that paused it, or start a new run`,
      );
    }
  }

  const startedAt = from ? new Date(from.paused.run.started) : new Date();
  const runId = `${stamp(startedAt)}-${spec.name}`;
  const state: State = from ? { ...from.paused.state } : { goal: "", ...inputs };
  const goal = String(state["goal"] ?? "");
  const steps: RunStep[] = from ? [...from.paused.steps] : [];
  const taken = new Map<number, number>(from?.paused.taken ?? []);
  // A resumed run consumes its answer at the node that paused, once.
  const presets = new Map<string, HumanAnswer>(from ? [[from.paused.node, from.answer]] : []);
  let pausedAt: { node: string; lane: string; pending: Pending } | undefined;

  // One controller for the whole run: budget, cancellation, a failure on any
  // lane and the caller's own signal all land on it, and every handler is
  // handed the same one. That is what makes a fork safe to cancel.
  const controller = new AbortController();
  const relay = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) relay();
  else options.signal?.addEventListener("abort", relay, { once: true });

  let status: RunStatus = "completed";
  let total = from?.paused.total ?? 0;
  let lastValue: unknown;
  let failure: { message: string; cause: unknown } | undefined;
  // The first reason to stop wins; later lanes noticing the abort must not overwrite it.
  const halt = (why: RunStatus): void => {
    if (status === "completed") status = why;
    controller.abort();
  };

  const finish = (): RunDoc => ({
    $schema: RUN_SCHEMA,
    version: 1,
    run: {
      id: runId,
      runner: spec.name,
      graph: graphHash,
      goal,
      started: startedAt.toISOString(),
      ended: new Date().toISOString(),
      status,
      cost: { total: Number(total.toFixed(8)), currency: "USD" },
    },
    steps,
    state,
    ...(pausedAt ? { pending: pausedAt.pending } : {}),
  });

  /** Run one node on one lane. Returns where the lane goes next, or what it spawned. */
  const runNode = async (
    name: string,
    lane: string,
  ): Promise<{ next?: string; spawn?: Array<{ edge: Edge; id: string }> }> => {
    const node: NodeSpec = spec.nodes[name]!;
    const began = Date.now();
    const step: RunStep = {
      n: steps.length + 1,
      node: name,
      kind: isDecide(node)
        ? "decide"
        : isWork(node)
          ? "work"
          : isModel(node)
            ? "model"
            : isMcp(node)
              ? "mcp"
              : "code",
      lane,
      started: new Date(began).toISOString(),
      ended: "",
      ms: 0,
      cost: 0,
      took: null,
    };
    steps.push(step);
    options.onEvent?.({
      type: "node:start",
      n: step.n,
      node: name,
      kind: step.kind,
      lane,
      waiting: isDecide(node)
        ? `${node.by === "human" ? (presets.has(name) ? "resuming with a person's answer" : "waiting for a person") : "asking the decider"} · ${Object.keys(node.decide).length} question${Object.keys(node.decide).length === 1 ? "" : "s"}`
        : isWork(node)
          ? `running work "${node.work}"`
          : isModel(node)
            ? `calling ${typeof node.model === "string" ? node.model : String(state[node.model.from] ?? "?")}` +
              (node.sees?.length ? ` · looking at ${node.sees.join(", ")}` : "")
            : "computing",
      // A person is only actually WAITED on when there is no answer in hand
      // already: a resume walks through the same node with one.
      ...(isDecide(node) && node.by === "human" && !presets.has(name) ? { asks: "human" as const } : {}),
    });

    let gated: string | undefined;

    // The step's deadline. The race is what enforces it, because a handler
    // that ignores its signal would otherwise hold the run forever. A plain
    // timer, not AbortSignal.timeout: that one is unref'd, so a step hung on
    // nothing would let the process exit instead of failing.
    const expire = new AbortController();
    const signal = options.stepTimeout ? AbortSignal.any([controller.signal, expire.signal]) : controller.signal;
    const bounded = <T>(work: T | Promise<T>): Promise<T> => {
      const limit = options.stepTimeout;
      if (!limit) return Promise.resolve(work);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const late = new Error(`did not finish within ${limit}ms`);
          expire.abort(late);
          reject(late);
        }, limit);
        Promise.resolve(work).then(
          (value) => (clearTimeout(timer), resolve(value)),
          (error: unknown) => (clearTimeout(timer), reject(error)),
        );
      });
    };

    const close = (): void => {
      step.ended = new Date().toISOString();
      step.ms = Date.now() - began;
    };

    try {
      // What the node was given, as it was. A work handler sees the whole
      // state, but what it DECLARED is what the record keeps.
      const wanted = readsOf(node);
      if (wanted.length) step.asked = pick(state, wanted);

      if (isDecide(node) && node.by === "human") {
        const questions = graphDoc.nodes.find((n) => n.id === name)!.decide!.questions;
        const asked = pick(state, node.reads);
        let answer = presets.get(name);
        presets.delete(name);
        // A person is not a hung machine: no stepTimeout here, only cancellation.
        answer ??=
          (await options.human?.({
            run: runId,
            node: name,
            questions,
            asked,
            ...(node.comment ? { comment: node.comment } : {}),
            signal: controller.signal,
          })) ?? undefined;
        if (!answer) {
          // Nobody to ask right now. Stop cleanly, and leave everything needed
          // to pick this up again.
          //
          // But only if this lane is the whole run. A pause stops everything,
          // and `resume` restarts one lane, so pausing beside a live sibling
          // would abandon it silently — a node in the graph would simply never
          // run and the record would call it a clean pause. `validate` rejects
          // the shapes it can prove; this is the net under the ones it cannot.
          if (running.size > 1 || parked.size > 0) {
            const others = running.size - 1 + parked.size;
            step.error =
              `node "${name}" asks a person, but ${others} other lane${others === 1 ? "" : "s"} ` +
              `${others === 1 ? "is" : "are"} still running — a run pauses as a whole and resumes on one lane, ` +
              `so the ${others === 1 ? "other" : "others"} would be dropped. Move the question after the join`;
            close();
            if (!failure) failure = { message: `node "${name}" failed: ${step.error}`, cause: undefined };
            halt("failed");
            options.onEvent?.({ type: "node:end", step });
            return {};
          }
          pausedAt = { node: name, lane, pending: { node: name, questions, asked, ...(node.comment ? { comment: node.comment } : {}) } };
          steps.splice(steps.indexOf(step), 1);
          halt("paused");
          return {};
        }
        // Recorded before the answer is checked, so a REJECTED answer is still
        // filed as a person's: a reader should see who was asked, not a step
        // that looks like the classifier tripped.
        step.meta = { by: "human", ...(answer.by ? { who: answer.by } : {}) };
        const { written, recorded } = fromHuman(name, node, answer);
        step.answers = recorded;
        step.writes = written;
        Object.assign(state, written);
        lastValue = written;
      } else if (isDecide(node)) {
        const decision = await bounded(decider(pick(state, node.reads), node.decide, { signal }));
        step.cost = decision.cost;
        step.meta = { model: decision.model, usage: decision.usage };
        step.answers = {};
        const written: Record<string, unknown> = {};
        for (const [key, question] of Object.entries(node.decide)) {
          const answer = decision.answers[key];
          if (!answer) {
            throw new DeciderAnswerError(`node "${name}" asked "${key}" but the decider returned no answer for it`);
          }
          // An answer outside the declared set would match no edge and leave the
          // run to exit quietly, reporting success. Refuse it at the fault.
          const wrong = misfit(question, answer);
          if (wrong) {
            throw new DeciderAnswerError(
              `node "${name}" asked "${key}" and the decider said something the graph cannot route: ${wrong}. ` +
                `The run would have fallen through to the exit having done nothing`,
            );
          }
          step.answers[key] = toStepAnswer(answer);
          written[key] = valueOf(answer);
          state[key] = written[key];
        }
        step.writes = written;
        lastValue = written;

        if (node.gate) {
          const measured = step.answers[node.gate.on]?.confidence ?? 0;
          const passed = measured >= node.gate.min;
          step.gate = { on: node.gate.on, passed, min: node.gate.min, measured };
          if (!passed) gated = node.gate.to;
        }
      } else if (isWork(node)) {
        const handler = spec.work![node.work]!;
        step.handler = node.work;
        const value = await bounded(
          handler({
            state,
            goal,
            signal,
            report: ({ cost, meta }) => {
              if (cost !== undefined) step.cost = cost;
              if (meta) step.meta = { ...step.meta, ...meta };
            },
          }),
        );
        lastValue = value;
        step.writes = applyWrites(name, writesOf(node), value);
        Object.assign(state, step.writes);
      } else if (isModel(node)) {
        const id = typeof node.model === "string" ? node.model : String(state[node.model.from] ?? "");
        if (!id) {
          throw new Error(
            `node "${name}" takes its model from "${(node.model as { from: string }).from}", which is empty — ` +
              `nothing upstream chose one`,
          );
        }
        // Skills are instructions, so they are text: inlined ahead of the
        // node's own system prompt. "none" resolves to nothing, which is how
        // a decide node declines to pick one.
        const wanted = Array.isArray(node.skills)
          ? node.skills
          : node.skills
            ? [String(state[node.skills.from] ?? "")]
            : [];
        const attached = wanted
          .filter((skillName) => skillName && skillName !== "none")
          .map((skillName) => {
            const skill = findSkill(spec.skills ?? [], skillName);
            if (!skill) throw new Error(`node "${name}" wants skill "${skillName}", which is not loaded`);
            return skill;
          });
        const system = [attached.length ? renderSkills(attached) : "", node.system ?? ""]
          .filter(Boolean)
          .join("\n\n");

        const reply = await bounded(
          caller({
            model: id,
            prompt: typeof node.prompt === "function" ? node.prompt(state) : node.prompt,
            ...(system ? { system } : {}),
            images: (node.sees ?? []).flatMap((key) => asUrls(state[key])),
            ...(node.temperature !== undefined ? { temperature: node.temperature } : {}),
            ...(node.maxTokens !== undefined ? { maxTokens: node.maxTokens } : {}),
            signal,
          }),
        );
        step.cost = reply.cost;
        step.meta = {
          model: reply.model,
          usage: reply.usage,
          ...(attached.length ? { skills: attached.map((skill) => skill.name) } : {}),
          ...(reply.images.length ? { drew: reply.images.length } : {}),
        };
        // Positional, and documented as such: [text] or [text, images].
        const keys = writesOf(node);
        const written: Record<string, unknown> = {};
        if (keys[0]) written[keys[0]] = reply.text;
        if (keys[1]) written[keys[1]] = reply.images;
        step.writes = written;
        Object.assign(state, written);
        lastValue = keys.length > 1 ? { text: reply.text, images: reply.images } : reply.text;
      } else if (isMcp(node)) {
        const tool =
          typeof node.mcp.tool === "string" ? node.mcp.tool : String(state[node.mcp.tool.from] ?? "");
        if (!tool || tool === "none") {
          throw new Error(
            `node "${name}" takes its tool from "${(node.mcp.tool as { from: string }).from}", which is ` +
              `${tool === "none" ? `"none"` : "empty"} — wire that answer to a different branch`,
          );
        }
        const session = await servers.get(node.mcp.server);
        const args = typeof node.args === "function" ? node.args(state) : (node.args ?? {});
        const outcome = await bounded(session.call(tool, args));
        step.handler = `${node.mcp.server}/${tool}`;
        step.meta = { server: node.mcp.server, tool, isError: outcome.isError };
        if (outcome.isError) throw new Error(`mcp ${node.mcp.server}/${tool} failed: ${outcome.text.slice(0, 300)}`);

        const keys = writesOf(node);
        const written: Record<string, unknown> = {};
        if (keys[0]) written[keys[0]] = outcome.text;
        if (keys[1]) written[keys[1]] = outcome.data;
        step.writes = written;
        Object.assign(state, written);
        lastValue = keys.length > 1 ? { text: outcome.text, data: outcome.data } : outcome.text;
      } else if (isCode(node)) {
        const value = await bounded(node.code(state));
        lastValue = value;
        step.writes = applyWrites(name, writesOf(node), value);
        Object.assign(state, step.writes);
      }
    } catch (cause) {
      step.error = cause instanceof Error ? cause.message : String(cause);
      close();
      // Money spent before the throw was still spent. A handler that reported
      // a cost and then failed must count toward the total and the budget, or
      // a run that keeps failing looks free.
      total += step.cost;
      // No answer at all — an outage, a timeout — becomes a route when the node
      // declares one. A malformed human answer does not: that is a bug.
      if (isDecide(node) && node.fallback && !(cause instanceof HumanAnswerError) && !controller.signal.aborted) {
        step.took = "fallback";
        options.onEvent?.({ type: "node:end", step });
        return { next: node.fallback };
      }
      // The run was already stopping — the caller hung up, the budget ran out, a
      // sibling lane failed — and this step was cut off rather than broken. Say
      // why the RUN stopped and do not invent a failure on top of it. (A step
      // timeout aborts its own signal, not this one, so it still reads as the
      // failure it is.)
      if (controller.signal.aborted) {
        halt("cancelled");
        options.onEvent?.({ type: "node:end", step });
        return {};
      }
      if (!failure) failure = { message: `node "${name}" failed: ${step.error}`, cause };
      halt("failed");
      options.onEvent?.({ type: "node:end", step });
      return {};
    }

    close();
    total += step.cost;

    if (gated) {
      step.took = "gate";
      options.onEvent?.({ type: "node:end", step });
      return { next: gated };
    }

    if (options.budget !== undefined && total > options.budget) {
      halt("budget");
      options.onEvent?.({ type: "node:end", step });
      return {};
    }

    if (forksFrom(spec, name)) {
      const spawn = selectAll(edges, name, state, taken);
      step.forked = spawn.map((s) => s.id);
      options.onEvent?.({ type: "node:end", step });
      return { spawn };
    }

    const next = select(edges, name, state, taken);
    step.took = next ? edgeId(next.index) : null;
    options.onEvent?.({ type: "node:end", step });
    return { next: next?.edge.to };
  };

  // Lanes. One at first; a fork starts more; a join waits for them. A lane
  // that reaches a join parks there and ends. When no lane is left running,
  // every join with a lane parked at it fires once, on a fresh lane named
  // after it. That rule is the whole scheduler, and it is deterministic.
  const running = new Set<Promise<void>>();
  const parked = new Map<string, string[]>();

  const lane = async (start: string, id: string, arrived = false): Promise<void> => {
    let cursor: string | undefined = start;
    let first = true;
    while (cursor) {
      if (controller.signal.aborted) {
        halt("cancelled");
        return;
      }
      if (steps.length >= maxSteps) {
        halt("maxSteps");
        return;
      }
      const node = spec.nodes[cursor]!;
      if (node.join && !(first && arrived)) {
        parked.set(cursor, [...(parked.get(cursor) ?? []), id]);
        return;
      }
      first = false;
      const { next, spawn } = await runNode(cursor, id);
      if (spawn) {
        for (const { edge, id: laneId } of spawn) start_(edge.to, laneId);
        return;
      }
      cursor = next;
    }
  };
  const start_ = (at: string, id: string, arrived = false): void => {
    const p = lane(at, id, arrived).finally(() => running.delete(p));
    running.add(p);
  };

  try {
    if (from) start_(from.paused.node, from.paused.lane, true);
    else start_(spec.entry, "main");
    while (true) {
      if (running.size) {
        await Promise.race(running);
        continue;
      }
      if (controller.signal.aborted || parked.size === 0) break;
      for (const [at] of [...parked]) {
        parked.delete(at);
        start_(at, at, true);
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", relay);
    controller.abort();
    // A server that was never reached was never started, so this is usually a no-op.
    servers.closeAll();
  }

  // A pause is a resting place, and nothing rests if something also broke: the
  // snapshot would promise a continuation the failed lane has already made
  // impossible. So a failure wins, and the record says failed rather than
  // handing back a `pending` nobody can act on.
  if (failure && pausedAt) {
    status = "failed";
    pausedAt = undefined;
  }

  const run = finish();
  options.onEvent?.({ type: "run:end", run });
  if (failure) throw new RunFailed(failure.message, run, failure.cause);

  if (pausedAt) {
    return {
      result: undefined,
      state,
      run,
      // Round-tripped through JSON here, at the pause, and not left to whoever
      // stores it. Otherwise a run resumed in this process and the same run
      // resumed from a file compute different things — a Date is an object on
      // one path and a string on the other — and a value that cannot be
      // serialised at all pauses happily and explodes later, in the caller's
      // writeFileSync, where nothing knows what to say about it.
      paused: plainJson<Paused>(
        {
          version: 1,
          runner: spec.name,
          graph: graphHash,
          run: { id: runId, started: startedAt.toISOString() },
          node: pausedAt.node,
          lane: pausedAt.lane,
          state,
          steps,
          taken: [...taken],
          total,
          pending: pausedAt.pending,
        },
        pausedAt.node,
      ),
    };
  }

  return {
    result: spec.result ? state[spec.result] : lastValue,
    state,
    run,
  };
}

/**
 * Continue a paused run with a person's answer. The answer is checked against
 * the node's closed questions, the run carries on from that node's edges, and
 * the finished run.json is one continuous record — same id, same steps, the
 * person's answer in the middle of it. It can pause again at a later node.
 */
export function resume(
  spec: RunnerSpec,
  paused: Paused,
  answer: HumanAnswer,
  options: RunOptions = {},
): Promise<RunOutcome> {
  return execute(spec, {}, options, { paused, answer });
}

/** Declaration order, first match wins. A loop budget is spent on the edge, by index. */
function select(
  edges: Edge[],
  from: string,
  state: Readonly<State>,
  taken: Map<number, number>,
): { edge: Edge; index: number } | undefined {
  for (const [index, edge] of edges.entries()) {
    if (edge.from !== from) continue;
    if (edge.maxLoops !== undefined && (taken.get(index) ?? 0) >= edge.maxLoops) continue;
    if (edge.on && !branchHolds(parseBranch(edge.on), state)) continue;
    if (edge.when && !edge.when(state as State)) continue;
    taken.set(index, (taken.get(index) ?? 0) + 1);
    return { edge, index };
  }
  return undefined;
}

/** Every forking edge that holds, in declaration order. Each becomes a lane named after its edge. */
function selectAll(
  edges: Edge[],
  from: string,
  state: Readonly<State>,
  taken: Map<number, number>,
): Array<{ edge: Edge; id: string }> {
  const fired: Array<{ edge: Edge; id: string }> = [];
  for (const [index, edge] of edges.entries()) {
    if (edge.from !== from || !edge.fork) continue;
    if (edge.maxLoops !== undefined && (taken.get(index) ?? 0) >= edge.maxLoops) continue;
    if (edge.on && !branchHolds(parseBranch(edge.on), state)) continue;
    if (edge.when && !edge.when(state as State)) continue;
    taken.set(index, (taken.get(index) ?? 0) + 1);
    fired.push({ edge, id: edgeId(index) });
  }
  return fired;
}
