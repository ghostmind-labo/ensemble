/**
 * Runners, callable as tools.
 *
 * The core is an MCP client (`mcp.ts`) and serves nothing. But a runner is
 * exactly a tool seen from outside: arguments go in, a result comes out. So this
 * module is a separate entry point (`@ghostmind-dev/ensemble/mcp`) that the core
 * never imports, and it exposes runners you already wrote to anything that
 * speaks the Model Context Protocol. It adds no concept to either side:
 *
 *   one runner                → one tool, named after it; its inputs are the arguments
 *   the RunEvent stream       → `notifications/progress`, when the caller asked for progress
 *   a `by: "human"` pause     → an elicitation form with the same closed questions
 *   the caller hanging up     → the run's AbortSignal
 *   the result                → text, plus the run's record as structured content
 *
 * The caller can only CALL. It cannot create or edit a runner: the runners are
 * the ones this process was started with, which is why no sandbox is needed.
 *
 * It is a connector, not a server, and it authenticates nobody. Locally an
 * assistant starts it as a child process and talks over stdio, where there is
 * no network to guard. Hosted, it is a request handler inside YOUR server,
 * behind whatever sign-in that server already has.
 *
 * It keeps nothing between requests that a second instance would need, as the
 * protocol now requires: a paused run travels to the caller and back as an
 * encrypted token, so any instance holding the same `secret` can resume it.
 * The one exception is opt-in and local: with `control`, runs are tracked in
 * memory so an assistant can start one, watch it and stop it.
 *
 * It speaks the current revision (2026-07-28: no handshake, metadata on every
 * request) and the handshake-based ones before it, because most deployed
 * clients, including this library's own, still open with `initialize`.
 *
 *   npx ensemble serve mcp triage.mts refunds.mts        # stdio, for a local assistant
 *   app.use("/mcp", mcpTools([triage]).handler)          # inside your own server
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  HumanAnswerError,
  ResumeError,
  RunFailed,
  type GraphQuestion,
  type HumanAnswer,
  type Paused,
  type Pending,
  type RunDoc,
  type RunEvent,
  type RunOptions,
  type RunOutcome,
  type RunStep,
  type Runner,
  type State,
} from "./index.ts";

type Json = Record<string, unknown>;

export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const META = "io.modelcontextprotocol/";
const SERVER_INFO = { name: "ensemble", version: "1" };
/** The tool that answers a paused run for callers that cannot be sent a form. */
const ANSWER_TOOL = "answer";
/** The tools that run nothing themselves: they watch and steer runs. */
const CONTROL_TOOLS = ["start_run", "get_run", "list_runs", "cancel_run"];

/** A run this process started, as it stands now. */
interface Tracked {
  id: string;
  tool: string;
  status: string;
  started: string;
  inputs: State;
  steps: RunStep[];
  /** Nodes that have started and not ended, by step number. */
  active: Map<number, string>;
  cost: number;
  abort: AbortController;
  done: Promise<void>;
  /** The tool result it ended with. */
  result?: Json;
  /** The id of its run.json, once it has one. */
  record?: string;
}

export interface ToolsOptions {
  /** USD cap on each call. */
  budget?: number;
  /** Seals paused runs. Set it to resume across restarts or instances; default: random, per process. */
  secret?: string;
  /** How long a paused run may wait for its answer. Default 24 hours. */
  pauseTtlMs?: number;
  /**
   * A folder to record every run in, one subfolder each with `run.json` and `graph.json`: the
   * layout `ensemble run` writes, so the same viewer and tools read both. Also where `get_run` and
   * `list_runs` look for runs this process did not make.
   */
  runsDir?: string;
  /**
   * Offer the tools that watch and steer runs: `start_run` (do not wait), `get_run`, `list_runs`
   * and `cancel_run`. They track runs in this process's memory, so they suit one process (a local
   * assistant over stdio); across several instances, serve the runner as an A2A agent instead.
   */
  control?: boolean;
  /** Origins a browser may call from, besides the server's own host. */
  allowedOrigins?: string[];
  /** Passed to every run: a stub decider in a test, a step timeout, a secret resolver. */
  run?: Omit<RunOptions, "signal" | "onEvent" | "human" | "budget">;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;
/** What a framework may have added to the request: an already-parsed body. */
type Parsed = IncomingMessage & { body?: unknown };

/** What one message is answered with: a response, and for an HTTP status the reason it failed. */
interface Reply {
  body?: Json;
  status: number;
}

interface Context {
  /** Sends a notification that belongs to this request, when the transport can carry one. */
  notify?: (message: Json) => void;
  signal: AbortSignal;
  /** The `MCP-Protocol-Version` header, on HTTP. */
  header?: string | undefined;
}

export interface McpTools {
  /** One JSON-RPC message in, its reply out (none for a notification). */
  handle(message: unknown, context: Context): Promise<Reply>;
  /** Streamable HTTP: `createServer(handler)`, or `app.use("/mcp", handler)` in Express. */
  handler: Handler;
  /** Newline-delimited JSON-RPC over two streams. Resolves when the input ends. */
  stdio(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): Promise<void>;
  /**
   * Shut down without breaking anything: refuse new calls (503 over HTTP, so the caller or a load
   * balancer tries elsewhere) and wait for the calls in flight to return. Whatever is still running
   * after `graceMs` (default 25 s) is stopped.
   */
  drain(graceMs?: number): Promise<void>;
  /** Stop every run in flight, now. */
  close(): void;
}

const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const failure = (code: number, message: string, data?: Json): Error => Object.assign(new Error(message), { code, ...(data ? { data } : {}) });

const summary = (run: RunDoc): Json => ({
  id: run.run.id,
  runner: run.run.runner,
  graph: run.run.graph,
  status: run.run.status,
  cost: run.run.cost,
  steps: run.steps.map((step) => ({
    node: step.node,
    kind: step.kind,
    took: step.took,
    cost: step.cost,
    ...(step.answers ? { answers: step.answers } : {}),
    ...(step.error ? { error: step.error } : {}),
  })),
});

/** One closed question as a form field: an enum for a choice, a boolean for a noul, a level for a score. */
function field(question: GraphQuestion): Json {
  const description = typeof question.instructions === "string" ? question.instructions : JSON.stringify(question.instructions);
  if (question.type === "choice") return { type: "string", title: question.key, description, enum: (question.options ?? []).map((option) => option.name) };
  if (question.type === "noul") return { type: "boolean", title: question.key, description };
  return { type: "integer", title: question.key, description, minimum: 0, maximum: Math.max(0, (question.levels?.length ?? 1) - 1) };
}

const formOf = (pending: Pending): Json => ({
  type: "object",
  properties: {
    ...Object.fromEntries(pending.questions.map((question) => [question.key, field(question)])),
    ...(pending.comment ? { [pending.comment]: { type: "string", title: pending.comment, description: "An optional note." } } : {}),
  },
  required: pending.questions.map((question) => question.key),
});

/** The pending questions, in words, for a caller that answers through the `answer` tool. */
function inWords(pending: Pending): string {
  const lines = pending.questions.map((question) => {
    const allowed =
      question.type === "choice" ? `one of: ${(question.options ?? []).map((option) => option.name).join(", ")}`
      : question.type === "noul" ? "true or false"
      : `a level from 0 to ${(question.levels?.length ?? 1) - 1}`;
    return `- ${question.key} (${allowed}): ${typeof question.instructions === "string" ? question.instructions : JSON.stringify(question.instructions)}`;
  });
  return `"${pending.node}" is waiting for an answer.\n${lines.join("\n")}`;
}

/** Serve these runners as MCP tools. Nothing in a runner changes: the adapter listens to each run from outside. */
export function mcpTools(runners: Runner[] | Record<string, Runner>, options: ToolsOptions = {}): McpTools {
  const byName = new Map<string, Runner>();
  for (const runner of Array.isArray(runners) ? runners : Object.values(runners)) {
    const { name } = runner.spec;
    const problems = runner.validate();
    if (problems.length) throw new Error(`runner "${name}" does not validate, so it is not served:\n  - ${problems.join("\n  - ")}`);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) throw new Error(`runner "${name}" cannot be a tool: a tool name is 1 to 128 letters, digits, "_", "-" or "."`);
    if (name === ANSWER_TOOL) throw new Error(`a runner named "${ANSWER_TOOL}" cannot be served: that name is the tool that answers a paused run`);
    if (CONTROL_TOOLS.includes(name)) throw new Error(`a runner named "${name}" cannot be served: that name is one of the connector's own tools (${CONTROL_TOOLS.join(", ")})`);
    if (byName.has(name)) throw new Error(`two runners are named "${name}": a tool name is unique within a server`);
    byName.set(name, runner);
  }
  const graphs = new Map([...byName].map(([name, runner]) => [name, runner.graph()]));
  const pauses = [...graphs.values()].some((graph) => graph.nodes.some((node) => node.decide?.by === "human"));
  const key = createHash("sha256").update(options.secret ?? randomBytes(32)).digest();
  const ttl = options.pauseTtlMs ?? 24 * 3_600_000;
  const live = new Set<AbortController>();

  /* ── a paused run, sealed: it travels through the caller, so it is encrypted and authenticated ── */

  const seal = (tool: string, paused: Paused): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({ tool, paused, exp: Date.now() + ttl }), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  };
  const unseal = (token: unknown, tool?: string): { tool: string; paused: Paused } => {
    try {
      const raw = Buffer.from(String(token), "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const opened = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as { tool: string; paused: Paused; exp: number };
      if (opened.exp < Date.now()) throw new Error("expired");
      if (tool !== undefined && opened.tool !== tool) throw new Error("another tool's");
      return opened;
    } catch (cause) {
      const why = cause instanceof Error && (cause.message === "expired" || cause.message === "another tool's") ? `it is ${cause.message}` : "it was not issued by this server, or the server restarted without a --secret";
      throw failure(-32602, `the paused run cannot be resumed: ${why}. Call the tool again from the start.`);
    }
  };

  /* ── tools ── */

  const tools = (): Json[] => {
    const list: Json[] = [...graphs].map(([name, graph]) => ({
      name,
      description:
        (graph.runner.description ?? `The ensemble runner "${name}".`) +
        ` Returns its result, and the path it took with each decision's answer and confidence.` +
        (graph.nodes.some((node) => node.decide?.by === "human") ? ` It may stop and ask a closed question before finishing.` : ``),
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          graph.runner.inputs.map((input) => [input, input === "goal" ? { type: "string", description: "What to do, in plain words." } : { description: `The runner's "${input}" input.` }]),
        ),
        ...(graph.runner.inputs.includes("goal") ? { required: ["goal"] } : {}),
      },
    }));
    if (options.control) {
      const run = { type: "string", description: "A run id, as `start_run` and `list_runs` give it." };
      list.push(
        {
          name: "start_run",
          description: "Starts a runner and returns at once with a run id, instead of waiting for the result. Follow it with get_run.",
          inputSchema: { type: "object", properties: { runner: { type: "string", enum: [...byName.keys()] }, inputs: { type: "object", description: "The runner's inputs, e.g. { \"goal\": \"…\" }." } }, required: ["runner", "inputs"] },
        },
        {
          name: "get_run",
          description: "A run as it stands: its status, the nodes running now, each finished step with its answers and confidence, the state so far, the cost, and the result or the pending question.",
          inputSchema: { type: "object", properties: { run }, required: ["run"] },
        },
        {
          name: "list_runs",
          description: "Recent runs, newest first: those this process started and those recorded on disk.",
          inputSchema: { type: "object", properties: { runner: { type: "string", description: "Only this runner's." }, limit: { type: "integer", minimum: 1, maximum: 200 } } },
        },
        { name: "cancel_run", description: "Stops a run that is still going. Every handler is told to stop.", inputSchema: { type: "object", properties: { run }, required: ["run"] } },
      );
    }
    if (pauses) {
      list.push({
        name: ANSWER_TOOL,
        description: "Answers a run that stopped to ask a question. Pass the `resume` token from that result, and one value per question.",
        inputSchema: {
          type: "object",
          properties: {
            resume: { type: "string", description: "The `resume` token of the paused result." },
            answers: { type: "object", description: "One value per question key: an option name, true or false, or a level number." },
            comment: { type: "string", description: "An optional note." },
          },
          required: ["resume", "answers"],
        },
      });
    }
    return list;
  };

  const text = (value: string): Json[] => [{ type: "text", text: value }];

  /** A run waiting for an answer: a form for a caller that can show one, else words and a token for the `answer` tool. */
  function pausedResult(tool: string, paused: Paused, form: boolean, note?: string): Json {
    const { pending } = paused;
    const token = seal(tool, paused);
    if (form) {
      return {
        resultType: "input_required",
        inputRequests: { [pending.node]: { method: "elicitation/create", params: { mode: "form", message: `${note ? `${note} ` : ""}${tool}: ${pending.node} needs an answer.`, requestedSchema: formOf(pending) } } },
        requestState: token,
      };
    }
    return {
      content: text(`${note ? `${note}\n` : ""}${inWords(pending)}\nAnswer with the "${ANSWER_TOOL}" tool, passing the resume token of this result.`),
      structuredContent: {
        status: "paused",
        resume: token,
        pending,
        run: { id: paused.run.id, runner: paused.runner, graph: paused.graph, status: "paused", cost: { total: paused.total, currency: "USD" }, steps: paused.steps.length },
      },
    };
  }

  /** A finished, paused or failed run, as a tool result. `form` says whether this caller can be sent a form. */
  function resultOf(tool: string, outcome: RunOutcome, form: boolean): Json {
    const { run } = outcome;
    if (outcome.paused) return pausedResult(tool, outcome.paused, form);
    if (run.run.status !== "completed") {
      const why = run.run.status === "budget" ? "the run stopped at its budget" : `the run stopped at ${run.run.status}`;
      return { content: text(`${why} after ${run.steps.length} steps`), structuredContent: { status: run.run.status, run: summary(run) }, isError: true };
    }
    const { result } = outcome;
    return {
      content: text(typeof result === "string" ? result : JSON.stringify(result ?? null)),
      structuredContent: { status: "completed", result: result ?? null, run: summary(run) },
    };
  }

  /* ── runs, tracked: what `get_run`, `list_runs` and `cancel_run` look at ── */

  const tracked = new Map<string, Tracked>();
  function track(tool: string, inputs: State): Tracked {
    const entry: Tracked = { id: `run_${randomBytes(5).toString("hex")}`, tool, status: "running", started: new Date().toISOString(), inputs, steps: [], active: new Map(), cost: 0, abort: new AbortController(), done: Promise.resolve() };
    tracked.set(entry.id, entry);
    // Keep the last hundred; one still running is never dropped.
    for (const [id, old] of tracked) {
      if (tracked.size <= 100) break;
      if (old.status !== "running") tracked.delete(id);
    }
    return entry;
  }

  /** Write a run where `ensemble run` would, so the viewer and the next process can read it. Never fails a run. */
  function record(tool: string, run: RunDoc, paused?: Paused): void {
    if (!options.runsDir) return;
    try {
      const dir = join(options.runsDir, run.run.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
      writeFileSync(join(dir, "graph.json"), `${JSON.stringify(graphs.get(tool), null, 2)}\n`);
      if (paused) writeFileSync(join(dir, "paused.json"), `${JSON.stringify(paused, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`mcp: could not record the run under ${options.runsDir}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  const brief = (step: RunStep): Json => ({
    node: step.node,
    kind: step.kind,
    took: step.took,
    cost: step.cost,
    ...(step.answers ? { answers: step.answers } : {}),
    ...(step.error ? { error: step.error } : {}),
  });

  /** A tracked run as it stands. The state is rebuilt from what each step wrote, so it is true mid-run. */
  const viewOf = (entry: Tracked): Json => {
    const ended = obj(entry.result?.["structuredContent"]);
    return {
      run: entry.id,
      runner: entry.tool,
      status: entry.status,
      started: entry.started,
      cost: Number(entry.cost.toFixed(8)),
      running: [...entry.active.values()],
      steps: entry.steps.map(brief),
      state: Object.assign({}, entry.inputs, ...entry.steps.map((step) => step.writes ?? {})),
      ...(entry.record ? { record: entry.record } : {}),
      ...("result" in ended ? { result: ended["result"] } : {}),
      ...(ended["pending"] ? { pending: ended["pending"], resume: ended["resume"] } : {}),
      ...(entry.result?.["isError"] ? { error: obj((entry.result["content"] as Json[] | undefined)?.[0])["text"] } : {}),
    };
  };

  /** A run recorded on disk, by its run.json id. */
  function recorded(id: string): Json | undefined {
    if (!options.runsDir || !/^[\w.-]+$/.test(id)) return undefined;
    try {
      const run = JSON.parse(readFileSync(join(options.runsDir, id, "run.json"), "utf8")) as RunDoc;
      let resultKey: string | undefined;
      try {
        resultKey = (JSON.parse(readFileSync(join(options.runsDir, id, "graph.json"), "utf8")) as { runner?: { result?: string } }).runner?.result;
      } catch {
        /* a run without its graph still reads */
      }
      return {
        run: run.run.id,
        runner: run.run.runner,
        status: run.run.status,
        started: run.run.started,
        ended: run.run.ended,
        cost: run.run.cost.total,
        running: [],
        steps: run.steps.map(brief),
        state: run.state,
        record: run.run.id,
        ...(resultKey && run.state && resultKey in run.state ? { result: run.state[resultKey] } : {}),
        ...(run.pending ? { pending: run.pending } : {}),
      };
    } catch {
      return undefined;
    }
  }

  const told = (value: Json, isError = false): Json => ({ content: text(JSON.stringify(value, null, 2)), structuredContent: value, ...(isError ? { isError: true } : {}) });

  async function control(name: string, args: Json): Promise<Json> {
    if (name === "start_run") {
      const tool = String(args["runner"] ?? "");
      const runner = byName.get(tool);
      if (!runner) return told({ error: `no runner named "${tool}": the runners are ${[...byName.keys()].join(", ")}` }, true);
      const entry = track(tool, obj(args["inputs"]) as State);
      // Its own life: the request that started it returns now, so nothing of that request may stop it.
      entry.done = drive(tool, (runOptions) => runner(entry.inputs, runOptions), {}, { signal: new AbortController().signal }, false, undefined, entry).then(() => {});
      return told({ run: entry.id, runner: tool, status: "running" });
    }
    if (name === "list_runs") {
      const only = typeof args["runner"] === "string" ? args["runner"] : undefined;
      const limit = Number.isInteger(args["limit"]) ? Number(args["limit"]) : 20;
      const rows = [...tracked.values()].map((entry) => ({ run: entry.id, runner: entry.tool, status: entry.status, started: entry.started, cost: Number(entry.cost.toFixed(8)), steps: entry.steps.length, ...(entry.record ? { record: entry.record } : {}) }));
      const known = new Set(rows.map((row) => row.record));
      if (options.runsDir && existsSync(options.runsDir)) {
        for (const id of readdirSync(options.runsDir)) {
          if (known.has(id)) continue;
          const run = recorded(id);
          if (run) rows.push({ run: id, runner: String(run["runner"]), status: String(run["status"]), started: String(run["started"]), cost: Number(run["cost"]), steps: (run["steps"] as unknown[]).length, record: id });
        }
      }
      const runs = rows.filter((row) => !only || row.runner === only).sort((a, b) => b.started.localeCompare(a.started)).slice(0, limit);
      return told({ runs });
    }
    const id = String(args["run"] ?? "");
    const entry = tracked.get(id);
    if (name === "get_run") {
      const found = entry ? viewOf(entry) : recorded(id);
      return found ? told(found) : told({ error: `no run "${id}": list_runs shows the ones there are` }, true);
    }
    // cancel_run
    if (!entry) return told({ error: `no run "${id}" is tracked by this process, so there is nothing to stop` }, true);
    if (entry.status !== "running") return told({ ...viewOf(entry), error: `the run is ${entry.status}, not running` }, true);
    entry.abort.abort();
    await entry.done;
    // A blocking call ends on its own request; give its result a moment to land.
    for (let waited = 0; entry.status === "running" && waited < 2_000; waited += 20) await new Promise((done) => setTimeout(done, 20));
    return told(viewOf(entry));
  }

  /** Run or resume, with progress and cancel wired. Every ending is a tool result; only a bad token throws. */
  async function drive(tool: string, start: (runOptions: RunOptions) => Promise<RunOutcome>, params: Json, context: Context, form: boolean, resumed?: Paused, entry: Tracked = track(tool, resumed?.state ?? {})): Promise<Json> {
    const token = obj(params["_meta"])["progressToken"];
    let progress = 0;
    const tell = (message: string): void => {
      if (token === undefined || !context.notify) return;
      context.notify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++progress, message } });
    };
    const onEvent = (event: RunEvent): void => {
      if (event.type === "node:start") {
        entry.active.set(event.n, event.node);
        tell(event.waiting);
      } else if (event.type === "node:end") {
        entry.active.delete(event.step.n);
        entry.steps.push(event.step);
        entry.cost += event.step.cost;
        tell(`${event.step.node} ${event.step.error ? "failed" : event.step.took ? `took ${event.step.took}` : "ended"}`);
      }
    };
    const abort = entry.abort;
    const relay = (): void => abort.abort();
    const ended = (result: Json, run?: RunDoc, paused?: Paused): Json => {
      entry.status = String(obj(result["structuredContent"])["status"] ?? (result["resultType"] === "input_required" ? "paused" : "failed"));
      entry.result = result;
      entry.active.clear();
      if (run?.run?.id) {
        entry.record = run.run.id;
        record(tool, run, paused);
      }
      return result;
    };
    if (context.signal.aborted) relay();
    else context.signal.addEventListener("abort", relay, { once: true });
    live.add(abort);
    try {
      const outcome = await start({ ...options.run, signal: abort.signal, onEvent, ...(options.budget !== undefined ? { budget: options.budget } : {}) });
      return ended(resultOf(tool, outcome, form), outcome.run, outcome.paused);
    } catch (error) {
      const cause = error instanceof RunFailed ? error.cause : error;
      // An answer that does not fit ran nothing: ask again, on the same snapshot, and say what was wrong.
      if (resumed && (cause instanceof HumanAnswerError || cause instanceof ResumeError)) return ended(pausedResult(tool, resumed, form, cause.message));
      const message = error instanceof Error ? error.message : String(error);
      return ended(
        { content: text(message), ...(error instanceof RunFailed ? { structuredContent: { status: "failed", run: summary(error.run) } } : {}), isError: true },
        error instanceof RunFailed ? error.run : undefined,
      );
    } finally {
      context.signal.removeEventListener("abort", relay);
      live.delete(abort);
    }
  }

  async function call(params: Json, context: Context, form: boolean): Promise<Json> {
    const name = String(params["name"] ?? "");
    const args = obj(params["arguments"]);

    // The caller answering through the `answer` tool.
    if (name === ANSWER_TOOL && pauses) {
      const { tool, paused } = unseal(args["resume"]);
      const answer: HumanAnswer = { answers: obj(args["answers"]) as HumanAnswer["answers"], by: "mcp", ...(typeof args["comment"] === "string" ? { comment: args["comment"] } : {}) };
      return drive(tool, (runOptions) => byName.get(tool)!.resume(paused, answer, runOptions), params, context, false, paused);
    }

    if (options.control && CONTROL_TOOLS.includes(name)) return control(name, args);

    const runner = byName.get(name);
    if (!runner) throw failure(-32602, `Unknown tool: ${name}`);

    // The same call again, carrying the form the user filled in.
    if (params["requestState"] !== undefined) {
      const { paused } = unseal(params["requestState"], name);
      const response = obj(obj(params["inputResponses"])[paused.pending.node]);
      if (response["action"] === "decline" || response["action"] === "cancel") {
        return { content: text(`${paused.pending.node} was not answered (${String(response["action"])}), so the run did not continue.`), structuredContent: { status: "paused", pending: paused.pending }, isError: true };
      }
      if (response["action"] !== "accept") return pausedResult(name, paused, form);
      const content = { ...obj(response["content"]) };
      const note = paused.pending.comment ? content[paused.pending.comment] : undefined;
      if (paused.pending.comment) delete content[paused.pending.comment];
      const answer: HumanAnswer = { answers: content as HumanAnswer["answers"], by: "mcp", ...(typeof note === "string" && note ? { comment: note } : {}) };
      return drive(name, (runOptions) => runner.resume(paused, answer, runOptions), params, context, form, paused);
    }

    return drive(name, (runOptions) => runner(args as State, runOptions), params, context, form, undefined, track(name, args as State));
  }

  /* ── the protocol: one message at a time, nothing remembered ── */

  const inFlight = new Map<string | number, AbortController>();
  /** Calls being served right now, for drain(). */
  const calls = new Set<Promise<void>>();
  let draining = false;

  async function handle(message: unknown, context: Context): Promise<Reply> {
    const request = obj(message);
    const id = request["id"] as string | number | undefined;
    const method = String(request["method"] ?? "");
    const params = obj(request["params"]);
    const meta = obj(params["_meta"]);
    const error = (status: number, code: number, text: string, data?: Json): Reply =>
      id === undefined ? { status } : { status, body: { jsonrpc: "2.0", id, error: { code, message: text, ...(data ? { data } : {}) } } };

    if (request["jsonrpc"] !== "2.0" || !method) return { status: 400, body: { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid request" } } };

    if (id === undefined) {
      // stdio's only way to cancel; on HTTP the caller hangs up instead.
      if (method === "notifications/cancelled") inFlight.get(params["requestId"] as string | number)?.abort();
      return { status: 202 };
    }

    // Which era is this request from? Its own metadata says, or (on HTTP) its version header.
    const asked = meta[`${META}protocolVersion`] ?? context.header;
    const modern = method !== "initialize" && typeof asked === "string" && !LEGACY_VERSIONS.includes(asked);
    const ok = (result: Json): Reply => ({
      status: 200,
      body: { jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result, _meta: { ...obj(result["_meta"]), [`${META}serverInfo`]: SERVER_INFO } } : result },
    });

    if (modern) {
      if (meta[`${META}protocolVersion`] === undefined || meta[`${META}clientCapabilities`] === undefined) {
        return error(400, -32602, `Invalid params: every request carries _meta["${META}protocolVersion"] and _meta["${META}clientCapabilities"]`);
      }
      if (!MODERN_VERSIONS.includes(String(asked))) {
        return error(400, -32022, "Unsupported protocol version", { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: String(asked) });
      }
    }

    try {
      if (method === "initialize") {
        const wanted = String(params["protocolVersion"] ?? "");
        return ok({ protocolVersion: LEGACY_VERSIONS.includes(wanted) ? wanted : LEGACY_VERSIONS[0], capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      }
      if (method === "ping") return ok({});
      if (method === "server/discover") return ok({ supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], capabilities: { tools: {} } });
      if (method === "tools/list") return ok({ tools: tools() });
      if (method === "tools/call") {
        // Shutting down: this call would not have time to finish here.
        if (draining) return error(503, -32603, "this instance is shutting down: send the call again");
        // A form may be sent only to a caller that said it can show one, and only in the current revision.
        const elicitation = obj(meta[`${META}clientCapabilities`])["elicitation"];
        const form = modern && elicitation !== undefined && (Object.keys(obj(elicitation)).length === 0 || obj(elicitation)["form"] !== undefined);
        const abort = new AbortController();
        const relay = (): void => abort.abort();
        context.signal.addEventListener("abort", relay, { once: true });
        inFlight.set(id, abort);
        try {
          const working = call(params, { ...context, signal: abort.signal }, form);
          const tracked = working.then(() => {}, () => {});
          calls.add(tracked);
          void tracked.then(() => calls.delete(tracked));
          const result = await working;
          if (result["resultType"] === "input_required") return { status: 200, body: { jsonrpc: "2.0", id, result: { ...result, _meta: { [`${META}serverInfo`]: SERVER_INFO } } } };
          return ok(result);
        } finally {
          context.signal.removeEventListener("abort", relay);
          inFlight.delete(id);
        }
      }
      return error(modern ? 404 : 200, -32601, `Method not found: ${method}`);
    } catch (cause) {
      const failed = cause as { code?: number; message: string; data?: Json };
      return error(modern ? 400 : 200, failed.code ?? -32603, failed.message, failed.data);
    }
  }

  /* ── Streamable HTTP ── */

  const decoded = (value: string): string => {
    const match = /^=\?base64\?(.*)\?=$/.exec(value);
    return match ? Buffer.from(match[1]!, "base64").toString("utf8") : value;
  };

  const handler: Handler = (req, res) => {
    const json = (status: number, body?: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, body === undefined ? headers : { "content-type": "application/json", ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const rejected = (status: number, code: number, message: string): void => json(status, { jsonrpc: "2.0", error: { code, message } });

    // A page on another site must not be able to drive a server on this machine.
    const origin = req.headers.origin;
    if (origin) {
      let host = "";
      try {
        host = new URL(origin).host;
      } catch {
        /* not a url: refused below */
      }
      if (host !== req.headers.host && !(options.allowedOrigins ?? []).includes(origin)) return rejected(403, -32600, `Origin ${origin} is not allowed`);
    }
    if (req.method !== "POST") return json(405, undefined, { allow: "POST" });

    const answer = async (raw: string): Promise<void> => {
      let message: Json;
      try {
        message = obj(JSON.parse(raw));
      } catch {
        return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      const id = message["id"];
      const params = obj(message["params"]);
      const bodyVersion = obj(params["_meta"])[`${META}protocolVersion`];
      const header = typeof req.headers["mcp-protocol-version"] === "string" ? req.headers["mcp-protocol-version"] : undefined;

      // The current revision mirrors the body into headers, and a mismatch is refused: a proxy may have routed on them.
      if (bodyVersion !== undefined && id !== undefined) {
        const mismatch = (text: string): void => json(400, { jsonrpc: "2.0", id, error: { code: -32020, message: `Header mismatch: ${text}` } });
        if (header === undefined) return mismatch("the MCP-Protocol-Version header is missing");
        if (header !== bodyVersion) return mismatch(`MCP-Protocol-Version header value '${header}' does not match body value '${String(bodyVersion)}'`);
        const named = req.headers["mcp-method"];
        if (named === undefined) return mismatch("the Mcp-Method header is missing");
        if (named !== message["method"]) return mismatch(`Mcp-Method header value '${String(named)}' does not match body value '${String(message["method"])}'`);
        if (message["method"] === "tools/call") {
          const name = req.headers["mcp-name"];
          if (typeof name !== "string") return mismatch("the Mcp-Name header is missing");
          if (decoded(name) !== params["name"]) return mismatch(`Mcp-Name header value '${decoded(name)}' does not match body value '${String(params["name"])}'`);
        }
      }

      // The caller hanging up is the cancel.
      const gone = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) gone.abort();
      });

      const streams = String(req.headers.accept ?? "").includes("text/event-stream") && obj(params["_meta"])["progressToken"] !== undefined && message["method"] === "tools/call";
      let opened = false;
      const notify = streams
        ? (note: Json): void => {
            if (!opened) {
              res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
              opened = true;
            }
            res.write(`data: ${JSON.stringify(note)}\n\n`);
          }
        : undefined;
      const reply = await handle(message, { signal: gone.signal, header, ...(notify ? { notify } : {}) });
      if (gone.signal.aborted) return;
      if (opened) return void res.end(`data: ${JSON.stringify(reply.body)}\n\n`);
      json(reply.status, reply.body, reply.status === 503 ? { "retry-after": "1" } : {});
    };

    const parsed = (req as Parsed).body;
    if (parsed && typeof parsed === "object") return void answer(JSON.stringify(parsed));
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => void answer(raw));
  };

  /* ── stdio ── */

  function stdio(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
    const write = (message: Json): void => void output.write(`${JSON.stringify(message)}\n`);
    const ended = new AbortController();
    const cancelled = new Set<unknown>();
    const lines = createInterface({ input });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      const request = obj(message);
      // After a cancel, nothing more is said about that request.
      const target = obj(request["params"])["requestId"] as string | number;
      if (request["method"] === "notifications/cancelled" && inFlight.has(target)) cancelled.add(target);
      const quiet = (): boolean => cancelled.delete(request["id"]);
      void handle(message, { signal: ended.signal, notify: (note) => void (cancelled.has(request["id"]) || write(note)) }).then((reply) => {
        if (reply.body && !quiet()) write(reply.body);
      });
    });
    return new Promise((done) =>
      lines.on("close", () => {
        ended.abort();
        done();
      }),
    );
  }

  return {
    handle,
    handler,
    stdio,
    drain: async (graceMs = 25_000) => {
      draining = true;
      const settled = Promise.all([...calls]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([settled, new Promise((done) => (timer = setTimeout(done, graceMs)))]);
      clearTimeout(timer);
      for (const abort of live) abort.abort();
      await settled;
    },
    close: () => {
      for (const abort of live) abort.abort();
    },
  };
}
