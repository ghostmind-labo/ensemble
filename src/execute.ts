/**
 * The cursor, and the record it leaves.
 *
 * Small on purpose. The engine walks one node at a time, asks the decider when
 * it reaches a decide node, calls YOUR handler when it reaches a work node, and
 * writes down what happened. It never calls a model itself, holds a prompt, or
 * decides anything a node did not ask.
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
  isCode,
  isDecide,
  isMcp,
  isModel,
  isWork,
  parseBranch,
  writesOf,
  type Edge,
  type NodeSpec,
  type RunnerSpec,
  type State,
} from "./spec.ts";
import { confidenceOf, valueOf, type Answer } from "./questions.ts";
import { jev, type Decider } from "./jev.ts";
import { openrouter, type Caller } from "./openrouter.ts";
import { pool } from "./mcp.ts";
import { findSkill, renderSkills } from "./skills.ts";
import { validate } from "./validate.ts";
import { toGraph } from "./graph.ts";

export const RUN_SCHEMA = "https://ghostmind.dev/ensemble/run-v1.json";

export type RunStatus = "completed" | "failed" | "maxSteps" | "budget" | "cancelled";

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
  ms: number;
  cost: number;
  answers?: Record<string, StepAnswer>;
  gate?: { on: string; passed: boolean; min: number; measured: number };
  handler?: string;
  meta?: Record<string, unknown>;
  writes?: Record<string, unknown>;
  error?: string;
  /** The edge id taken, "gate" when the confidence gate fired, or null at the exit. */
  took: string | null;
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
}

/**
 * What a run says as it happens.
 *
 * Three events, because a live view needs exactly two things the record cannot
 * give it: that a node has STARTED, and what it is waiting on. Everything else
 * is already in the step. Keeping the vocabulary this small is what lets a
 * terminal reporter and any future renderer consume the same stream without
 * either becoming the other's constraint.
 */
export type RunEvent =
  | { type: "node:start"; n: number; node: string; kind: RunStep["kind"]; waiting: string }
  | { type: "node:end"; step: RunStep }
  | { type: "run:end"; run: RunDoc };

export interface RunOptions {
  /** Hard cap on node executions. Default 50. */
  maxSteps?: number;
  /** Stop once total cost exceeds this, in USD. */
  budget?: number;
  signal?: AbortSignal;
  /** Swap the decider — a fallback model, a cache, a stub in a test. */
  decider?: Decider;
  /** Swap the generative caller — a stub, a cache, another vendor. */
  caller?: Caller;
  /** Live progress. Fires before a node runs and again when it finishes. */
  onEvent?: (event: RunEvent) => void;
}

export interface RunOutcome {
  result: unknown;
  state: State;
  run: RunDoc;
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
): Promise<RunOutcome> {
  const problems = validate(spec);
  if (problems.length) throw new RunnerError(spec.name, problems);

  const maxSteps = options.maxSteps ?? 50;
  const decider = options.decider ?? jev(spec.jev);
  const caller = options.caller ?? openrouter(spec.openrouter);
  const servers = pool(spec.mcpServers ?? {});
  const edges = spec.edges ?? [];
  const startedAt = new Date();
  const graphHash = toGraph(spec).runner.hash;

  const state: State = { goal: "", ...inputs };
  const goal = String(state["goal"] ?? "");
  const steps: RunStep[] = [];
  const taken = new Map<number, number>();

  // One controller for the whole run: budget, cancellation and the caller's own
  // signal all land on it, and every handler is handed the same one.
  const controller = new AbortController();
  const relay = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) relay();
  else options.signal?.addEventListener("abort", relay, { once: true });

  let status: RunStatus = "completed";
  let total = 0;
  let lastValue: unknown;
  let cursor: string | undefined = spec.entry;
  let failure: { message: string; cause: unknown } | undefined;

  const finish = (): RunDoc => ({
    $schema: RUN_SCHEMA,
    version: 1,
    run: {
      id: `${stamp(startedAt)}-${spec.name}`,
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
  });

  try {
    while (cursor) {
      if (controller.signal.aborted) {
        status = "cancelled";
        break;
      }
      if (steps.length >= maxSteps) {
        status = "maxSteps";
        break;
      }

      const name: string = cursor;
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
        waiting: isDecide(node)
          ? `asking the decider · ${Object.keys(node.decide).length} question${Object.keys(node.decide).length === 1 ? "" : "s"}`
          : isWork(node)
            ? `running work "${node.work}"`
            : isModel(node)
              ? `calling ${typeof node.model === "string" ? node.model : String(state[node.model.from] ?? "?")}` +
                (node.sees?.length ? ` · looking at ${node.sees.join(", ")}` : "")
              : "computing",
      });

      let gated: string | undefined;

      try {
        if (isDecide(node)) {
          const decision = await decider(pick(state, node.reads), node.decide);
          step.cost = decision.cost;
          step.meta = { model: decision.model, usage: decision.usage };
          step.answers = {};
          const written: Record<string, unknown> = {};
          for (const key of Object.keys(node.decide)) {
            const answer = decision.answers[key];
            if (!answer) {
              throw new Error(`node "${name}" asked "${key}" but the decider returned no answer for it`);
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
          const value = await handler({
            state,
            goal,
            signal: controller.signal,
            report: ({ cost, meta }) => {
              if (cost !== undefined) step.cost = cost;
              if (meta) step.meta = { ...step.meta, ...meta };
            },
          });
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

          const reply = await caller({
            model: id,
            prompt: typeof node.prompt === "function" ? node.prompt(state) : node.prompt,
            ...(system ? { system } : {}),
            images: (node.sees ?? []).flatMap((key) => asUrls(state[key])),
            ...(node.temperature !== undefined ? { temperature: node.temperature } : {}),
            ...(node.maxTokens !== undefined ? { maxTokens: node.maxTokens } : {}),
            signal: controller.signal,
          });
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
          const outcome = await session.call(tool, args);
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
          const value = await node.code(state);
          lastValue = value;
          step.writes = applyWrites(name, writesOf(node), value);
          Object.assign(state, step.writes);
        }
      } catch (cause) {
        step.error = cause instanceof Error ? cause.message : String(cause);
        step.ms = Date.now() - began;
        status = "failed";
        failure = { message: `node "${name}" failed: ${step.error}`, cause };
        options.onEvent?.({ type: "node:end", step });
        break;
      }

      step.ms = Date.now() - began;
      total += step.cost;

      if (gated) {
        step.took = "gate";
        options.onEvent?.({ type: "node:end", step });
        cursor = gated;
        continue;
      }

      if (options.budget !== undefined && total > options.budget) {
        status = "budget";
        options.onEvent?.({ type: "node:end", step });
        break;
      }

      const next = select(edges, name, state, taken);
      step.took = next ? edgeId(next.index) : null;
      options.onEvent?.({ type: "node:end", step });
      cursor = next?.edge.to;
    }
  } finally {
    options.signal?.removeEventListener("abort", relay);
    controller.abort();
    // A server that was never reached was never started, so this is usually a no-op.
    servers.closeAll();
  }

  const run = finish();
  options.onEvent?.({ type: "run:end", run });
  if (failure) throw new RunFailed(failure.message, run, failure.cause);

  return {
    result: spec.result ? state[spec.result] : lastValue,
    state,
    run,
  };
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
