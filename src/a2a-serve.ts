/**
 * A runner, callable as an agent.
 *
 * The core consumes agents (`a2a.ts`) and serves nothing. But a runner is exactly
 * what Agent2Agent describes from the outside: a goal goes in, a task moves
 * through declared states, and a result comes out. So this module is a separate
 * entry point (`@ghostmind-dev/ensemble/a2a`) that the core never imports, and
 * it maps one onto the other without adding a concept to either:
 *
 *   a message                 → the runner's `goal` (and inputs, as a data part)
 *   the RunEvent stream       → status updates, one as each node starts and ends
 *   a `by: "human"` pause     → `input-required`; the caller answers, the run resumes
 *   CancelTask                → the run's AbortSignal
 *   GetTask                   → the task, with each finished step in its `history`
 *   the result                → one artifact
 *
 * The caller steers only where the graph declared a pause, with the same closed
 * questions a person would get, so the record still says who answered what. It
 * cannot push state into a run at any other moment: that would be a write with
 * no origin, which `validate` exists to rule out.
 *
 * Tasks live in a store, not in the process: the default is memory, and behind a
 * load balancer every instance is given the same one (`store`), so any of them
 * can report on, answer or cancel a task another is running.
 *
 * A2A has no field for what a task cost, so the run's cost travels in the
 * task's `metadata.ensemble`, next to the run id and the steps taken.
 *
 * It is a connector, not a server, and it authenticates nobody: it is a request
 * handler mounted in YOUR server, behind whatever sign-in that server has.
 *
 *   app.use("/agents/triage", a2aAgent(triage).handler)
 *   agents: { triage: { protocol: "a2a", url: "https://example.com/agents/triage" } }
 *
 * Mounting costs nothing; each task is a real run.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HumanAnswerError,
  ResumeError,
  RunFailed,
  type HumanAnswer,
  type Paused,
  type Pending,
  type RunDoc,
  type RunEvent,
  type RunOptions,
  type Runner,
  type State,
} from "./index.ts";

type Json = Record<string, unknown>;

export interface AgentOptions {
  /**
   * Merged into the agent card. The adapter authenticates nobody: when your server requires a
   * credential, declare it here (`securitySchemes`, `securityRequirements`) so callers know.
   */
  card?: Record<string, unknown>;
  /** USD cap per task. A caller may ask for less (`metadata.budget`), never more. */
  budget?: number;
  /** The address callers reach this server at, for the card. Default: the request's Host. */
  publicUrl?: string;
  /** Passed to every run: a stub decider in a test, a step timeout, a secret resolver. */
  run?: Omit<RunOptions, "signal" | "onEvent" | "human" | "budget">;
  /** Finished tasks kept for GetTask by the default, in-memory store. Default 200. */
  keep?: number;
  /**
   * Where tasks are kept. Default: this process's memory, which is right for one instance and wrong
   * for several. Behind a load balancer, give every instance the same store (Redis, Postgres, any
   * key-value table) and any of them can answer for a task another one ran.
   */
  store?: TaskStore;
  /** How often a running task is saved and checked for a cancel sent to another instance. Default 10 s. */
  heartbeatMs?: number;
  /** A task still "working" with no heartbeat for this long is reported failed: its instance is gone. Default 45 s. */
  staleMs?: number;
}

/**
 * A key-value store of JSON, shared by every instance of the agent. Three methods, so an adapter for
 * Redis or a database table is a few lines. Keys are `task:<id>` and `cancel:<id>`; expiry is the
 * store's business (a paused task waits as long as the store keeps it).
 */
export interface TaskStore {
  get(key: string): Promise<Record<string, unknown> | undefined>;
  set(key: string, value: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The default store: this process's memory. Values are copied in and out, as a real store would. */
export function memoryStore(keep = 200): TaskStore {
  const values = new Map<string, Record<string, unknown>>();
  const done = (value: Record<string, unknown>): boolean => DONE.has(String(obj(obj(value["task"])["status"])["state"]));
  return {
    get: async (key) => {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    set: async (key, value) => {
      values.delete(key);
      values.set(key, structuredClone(value));
      // Forget the oldest finished tasks; a waiting or running one is never dropped.
      for (const [old, kept] of values) {
        if (values.size <= keep) break;
        if (!old.startsWith("task:") || done(kept)) values.delete(old);
      }
    },
    delete: async (key) => void values.delete(key),
  };
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;
/** What a framework may have added to the request: a mount point, an already-parsed body. */
type Mounted = IncomingMessage & { baseUrl?: string; body?: unknown };

export interface A2aAgent {
  handler: Handler;
  /**
   * Shut down without breaking anything: refuse new work (503, so the caller or a load balancer
   * tries elsewhere), keep answering status checks and cancels, and wait for the runs in flight to
   * end or pause. Whatever is still running after `graceMs` (default 25 s) is stopped.
   */
  drain(graceMs?: number): Promise<void>;
  /** Stop every run in flight, now. */
  close(): void;
}

/** A task running in THIS process. Once it ends or pauses it lives only in the store. */
interface Entry {
  task: Json;
  abort: AbortController;
  /** Present while the run waits for the caller's answer. */
  paused?: Paused;
  budget?: number;
  listeners: Set<(event: Json) => void>;
  settled: Promise<void>;
  /** The chain of writes to the store, in order. */
  saved: Promise<void>;
  beat?: ReturnType<typeof setInterval>;
}

/** A task as the store holds it. */
interface Stored {
  task: Json;
  paused?: Paused;
  budget?: number;
  /** When the instance running it last said so. */
  beat: number;
}

const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const DONE = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED"]);
const refuse = (code: number, message: string): Error => Object.assign(new Error(message), { code });

const status = (state: string, text?: string): Json => ({
  state,
  timestamp: new Date().toISOString(),
  ...(text ? { message: { messageId: randomUUID(), role: "ROLE_AGENT", parts: [{ text }] } } : {}),
});

/** The text of a message, and the first object it carries as data. */
function readMessage(message: Json): { text: string; data: Json | undefined } {
  const text: string[] = [];
  let data: Json | undefined;
  for (const entry of Array.isArray(message["parts"]) ? message["parts"] : []) {
    const part = obj(entry);
    if (typeof part["text"] === "string") text.push(part["text"]);
    else if (data === undefined && part["data"] && typeof part["data"] === "object") data = obj(part["data"]);
  }
  return { text: text.join("\n").trim(), data };
}

/** The pending questions, as a sentence a calling agent can answer. */
function ask(pending: Pending): string {
  const lines = pending.questions.map((question) => {
    const allowed =
      question.type === "choice" ? `one of: ${(question.options ?? []).map((option) => option.name).join(", ")}`
      : question.type === "noul" ? "yes or no"
      : `a level from 0 to ${(question.levels?.length ?? 1) - 1}`;
    return `${question.key} (${allowed}): ${typeof question.instructions === "string" ? question.instructions : JSON.stringify(question.instructions)}`;
  });
  const how = pending.questions.length === 1 ? "Answer with the value alone" : "Answer with one key=value per line";
  return `"${pending.node}" is waiting for an answer.\n${lines.join("\n")}\n${how}, or with a data part { "answers": { … } }.`;
}

/** A caller's reply to a pause, as the answer `resume` takes. Shape only: `resume` checks it against the questions. */
function toAnswer(message: Json, pending: Pending): HumanAnswer {
  const { text, data } = readMessage(message);
  const by = "a2a";
  if (data) {
    const answers = obj(data["answers"] ?? data) as HumanAnswer["answers"];
    return { answers, by, ...(typeof data["comment"] === "string" ? { comment: data["comment"] } : {}) };
  }
  const typed = (key: string, raw: string): string | number => {
    const question = pending.questions.find((candidate) => candidate.key === key);
    return question?.type === "score" && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  };
  const only = pending.questions.length === 1 ? pending.questions[0] : undefined;
  if (only && !text.includes("=")) return { answers: { [only.key]: typed(only.key, text) }, by };
  const answers: HumanAnswer["answers"] = {};
  for (const line of text.split(/\n|,/)) {
    const at = line.indexOf("=");
    if (at > 0) answers[line.slice(0, at).trim()] = typed(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return { answers, by };
}

const summary = (run: RunDoc): Json => ({
  run: run.run.id,
  runner: run.run.runner,
  graph: run.run.graph,
  status: run.run.status,
  steps: run.steps.length,
  cost: run.run.cost,
});

/**
 * One runner as an A2A agent (protocol 1.0, the JSON-RPC binding, streaming), as a request handler.
 * Nothing in the runner changes and no node knows about it: the adapter listens to the run from outside.
 */
export function a2aAgent(runner: Runner, options: AgentOptions = {}): A2aAgent {
  const problems = runner.validate();
  if (problems.length) throw new Error(`runner "${runner.spec.name}" does not validate, so it is not served:\n  - ${problems.join("\n  - ")}`);
  const graph = runner.graph();
  /** Tasks running in this process. Everything else is asked of the store. */
  const tasks = new Map<string, Entry>();
  let draining = false;
  const store = options.store ?? memoryStore(options.keep ?? 200);
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const staleMs = options.staleMs ?? 45_000;
  const stateOf = (task: Json): string => String(obj(task["status"])["state"]);

  /** Write the task as it is now. Writes are chained, so the store never sees them out of order. */
  const save = (entry: Entry): Promise<void> => {
    const record: Stored = { task: entry.task, ...(entry.paused ? { paused: entry.paused } : {}), ...(entry.budget !== undefined ? { budget: entry.budget } : {}), beat: Date.now() };
    const snapshot = structuredClone(record) as unknown as Record<string, unknown>;
    entry.saved = entry.saved
      .then(() => store.set(`task:${String(entry.task["id"])}`, snapshot))
      .catch((error: unknown) => void process.stderr.write(`a2a: the task store refused a write: ${error instanceof Error ? error.message : String(error)}\n`));
    return entry.saved;
  };

  /** A cancel may have reached another instance: it leaves a mark in the store, and the one running the task acts on it. */
  const heedCancel = (entry: Entry): void => {
    void store.get(`cancel:${String(entry.task["id"])}`).then((mark) => mark && entry.abort.abort(), () => {});
  };

  /** Start the clock on a task this process is about to run. */
  const begin = (entry: Entry): void => {
    tasks.set(String(entry.task["id"]), entry);
    entry.beat = setInterval(() => {
      void save(entry);
      heedCancel(entry);
    }, heartbeatMs);
    entry.beat.unref();
  };

  /** The task as the store has it. One that says "working" but has gone quiet lost its instance. */
  async function stored(id: string): Promise<Stored | undefined> {
    const record = (await store.get(`task:${id}`)) as unknown as Stored | undefined;
    if (!record) return undefined;
    if (stateOf(record.task) === "TASK_STATE_WORKING" && Date.now() - record.beat > staleMs && !tasks.has(id)) {
      record.task["status"] = status("TASK_STATE_FAILED", "the instance running this task stopped before it finished");
      record.beat = Date.now();
      await store.set(`task:${id}`, record as unknown as Record<string, unknown>);
    }
    return record;
  }

  const card = (base: string): Json => ({
    name: graph.runner.name,
    description: graph.runner.description ?? `The ensemble runner "${graph.runner.name}".`,
    version: graph.runner.hash,
    supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: graph.runner.name,
        name: graph.runner.name,
        description:
          `Send the goal as text` +
          (graph.runner.inputs.filter((key) => key !== "goal").length
            ? `, and these inputs as a data part: ${graph.runner.inputs.filter((key) => key !== "goal").join(", ")}.`
            : `.`) +
          (graph.nodes.some((node) => node.decide?.by === "human") ? ` It may stop at input-required and ask a closed question.` : ``),
        tags: ["ensemble", ...new Set(graph.nodes.map((node) => node.kind))],
      },
    ],
    ...options.card,
  });

  const emit = (entry: Entry, event: Json): void => {
    for (const listener of entry.listeners) listener(event);
  };
  const update = (entry: Entry, next: Json, metadata?: Json): void => {
    entry.task["status"] = next;
    emit(entry, {
      statusUpdate: { taskId: entry.task["id"], contextId: entry.task["contextId"], status: next, ...(metadata ? { metadata: { ensemble: metadata } } : {}) },
    });
  };

  /** One more message in the task's history: what the caller sent, and each step as it finished. */
  const remember = (entry: Entry, role: string, parts: unknown): void => {
    const history = (entry.task["history"] ??= []) as Json[];
    history.push({ messageId: randomUUID(), role, parts, taskId: entry.task["id"], contextId: entry.task["contextId"] });
  };

  /** Run, or resume, until the task ends or pauses. Never rejects: every ending is a task state. */
  function drive(entry: Entry, start: (runOptions: RunOptions) => ReturnType<Runner>, resumed?: Paused): Promise<void> {
    const onEvent = (event: RunEvent): void => {
      if (event.type === "node:start") {
        update(entry, status("TASK_STATE_WORKING", event.waiting), { event: event.type, n: event.n, node: event.node, kind: event.kind, lane: event.lane });
      } else if (event.type === "node:end") {
        const { step } = event;
        update(entry, status("TASK_STATE_WORKING"), {
          event: event.type,
          n: step.n,
          node: step.node,
          kind: step.kind,
          lane: step.lane,
          took: step.took,
          ms: step.ms,
          cost: step.cost,
          ...(step.answers ? { answers: step.answers } : {}),
          ...(step.meta ? { meta: step.meta } : {}),
          ...(step.error ? { error: step.error } : {}),
        });
        // The same step, kept: a caller that polls with GetTask sees as much as one that streamed.
        remember(entry, "ROLE_AGENT", [
          { text: `${step.node} ${step.error ? `failed: ${step.error}` : step.took ? `took ${step.took}` : "ended"}` },
          { data: { n: step.n, node: step.node, kind: step.kind, lane: step.lane, took: step.took, ms: step.ms, cost: step.cost, ...(step.answers ? { answers: step.answers } : {}), ...(step.meta ? { meta: step.meta } : {}) } },
        ]);
      }
      if (event.type === "node:start") heedCancel(entry);
      if (event.type !== "run:end") void save(entry);
    };
    const finish = (state: string, run: RunDoc | undefined, text?: string, extra: Json = {}): void => {
      entry.task["metadata"] = { ensemble: { ...(run ? summary(run) : {}), ...extra } };
      update(entry, status(state, text), obj(obj(entry.task["metadata"])["ensemble"]));
    };
    return start({ ...options.run, signal: entry.abort.signal, onEvent, ...(entry.budget !== undefined ? { budget: entry.budget } : {}) })
      .then((outcome) => {
        const { run } = outcome;
        if (outcome.paused) {
          entry.paused = outcome.paused;
          return finish("TASK_STATE_INPUT_REQUIRED", run, ask(outcome.paused.pending), { pending: outcome.paused.pending });
        }
        if (run.run.status === "cancelled" || entry.abort.signal.aborted) return finish("TASK_STATE_CANCELED", run);
        if (run.run.status !== "completed") {
          const why = run.run.status === "budget" ? "the run stopped at its budget" : `the run stopped at ${run.run.status}`;
          return finish("TASK_STATE_FAILED", run, `${why} after ${run.steps.length} steps`);
        }
        const { result } = outcome;
        const parts = typeof result === "string" ? [{ text: result }] : [{ text: JSON.stringify(result ?? null) }, { data: result ?? null }];
        const artifact = { artifactId: randomUUID(), name: graph.runner.result ?? "result", parts };
        entry.task["artifacts"] = [artifact];
        emit(entry, { artifactUpdate: { taskId: entry.task["id"], contextId: entry.task["contextId"], artifact } });
        finish("TASK_STATE_COMPLETED", run);
      })
      .catch((error: unknown) => {
        const run = error instanceof RunFailed ? error.run : undefined;
        if (entry.abort.signal.aborted) return finish("TASK_STATE_CANCELED", run);
        // An answer that does not fit the questions is not a failure of the run: the task goes back to
        // waiting on the same snapshot, and says what was wrong.
        const cause = error instanceof RunFailed ? error.cause : error;
        if (resumed && (cause instanceof HumanAnswerError || cause instanceof ResumeError)) {
          entry.paused = resumed;
          return finish("TASK_STATE_INPUT_REQUIRED", undefined, `${cause.message}\n${ask(resumed.pending)}`, { pending: resumed.pending });
        }
        finish("TASK_STATE_FAILED", run, error instanceof Error ? error.message : String(error));
      })
      .finally(async () => {
        // It ended or it is waiting: either way this process is done with it, and the store has the last word.
        clearInterval(entry.beat);
        await save(entry);
        tasks.delete(String(entry.task["id"]));
        await store.delete(`cancel:${String(entry.task["id"])}`).catch(() => {});
      });
  }

  /** A new task, or the answer to one that is waiting. Returns the entry, already running. */
  async function accept(params: Json, listen?: (event: Json) => void): Promise<Entry> {
    const message = obj(params["message"]);
    const waitingId = typeof message["taskId"] === "string" ? message["taskId"] : undefined;
    if (waitingId) {
      const record = tasks.has(waitingId) ? undefined : await stored(waitingId);
      if (!record && !tasks.has(waitingId)) throw refuse(-32001, "Task not found");
      const paused = record?.paused;
      if (!record || !paused) throw refuse(-32602, `Task ${waitingId} is not waiting for an answer: it is ${stateOf(record?.task ?? tasks.get(waitingId)!.task)}`);
      const answer = toAnswer(message, paused.pending);
      // Whichever instance was asked takes the task over from the store and runs it from here.
      const entry: Entry = { task: record.task, abort: new AbortController(), ...(record.budget !== undefined ? { budget: record.budget } : {}), listeners: new Set(), settled: Promise.resolve(), saved: Promise.resolve() };
      remember(entry, "ROLE_USER", message["parts"] ?? []);
      entry.task["status"] = status("TASK_STATE_WORKING");
      begin(entry);
      // Saved without its snapshot before anything runs, so a second answer finds nothing to resume.
      await save(entry);
      if (listen) entry.listeners.add(listen);
      entry.settled = drive(entry, (runOptions) => runner.resume(paused, answer, runOptions), paused);
      return entry;
    }

    const { text, data } = readMessage(message);
    const inputs: State = { ...(data ?? {}), ...(text || data?.["goal"] === undefined ? { goal: text } : {}) };
    const asked = Number(obj(params["metadata"])["budget"] ?? obj(message["metadata"])["budget"]);
    const budget = Number.isFinite(asked) && asked > 0 ? Math.min(asked, options.budget ?? Infinity) : options.budget;
    const entry: Entry = {
      task: {
        id: randomUUID(),
        contextId: typeof message["contextId"] === "string" ? message["contextId"] : randomUUID(),
        status: status("TASK_STATE_WORKING"),
      },
      abort: new AbortController(),
      ...(budget !== undefined ? { budget } : {}),
      listeners: new Set(),
      settled: Promise.resolve(),
      saved: Promise.resolve(),
    };
    remember(entry, "ROLE_USER", message["parts"] ?? []);
    begin(entry);
    await save(entry);
    // Before the run starts: its first node:start fires synchronously.
    if (listen) entry.listeners.add(listen);
    entry.settled = drive(entry, (runOptions) => runner(inputs, runOptions));
    return entry;
  }

  /** The task wherever it is: running here, or in the store. */
  const find = async (params: Json): Promise<Json> => {
    const id = String(params["id"]);
    const task = tasks.get(id)?.task ?? (await stored(id))?.task;
    if (!task) throw refuse(-32001, "Task not found");
    return task;
  };

  const methods: Record<string, (params: Json) => Promise<Json>> = {
    SendMessage: async (params) => {
      const entry = await accept(params);
      const configuration = obj(params["configuration"]);
      if (configuration["returnImmediately"] !== true && configuration["blocking"] !== false) await entry.settled;
      return { task: entry.task };
    },
    GetTask: async (params) => {
      const task = await find(params);
      const length = params["historyLength"];
      const history = (task["history"] ?? []) as Json[];
      return typeof length === "number" && length >= 0 ? { ...task, history: length === 0 ? [] : history.slice(-length) } : task;
    },
    CancelTask: async (params) => {
      const id = String(params["id"]);
      const local = tasks.get(id);
      if (local) {
        local.abort.abort();
        await local.settled;
        return local.task;
      }
      const record = await stored(id);
      if (!record) throw refuse(-32001, "Task not found");
      if (DONE.has(stateOf(record.task))) throw refuse(-32002, "Task cannot be canceled");
      if (stateOf(record.task) !== "TASK_STATE_WORKING") {
        // Nothing is running: the run rests in its snapshot, so dropping the snapshot is the cancel.
        delete record.paused;
        record.task["status"] = status("TASK_STATE_CANCELED");
        await store.set(`task:${id}`, record as unknown as Record<string, unknown>);
        return record.task;
      }
      // Another instance is running it: leave a mark it will see, and wait a moment for it to stop.
      await store.set(`cancel:${id}`, { at: Date.now() });
      for (let waited = 0; waited < 5_000; waited += 100) {
        await new Promise((done) => setTimeout(done, 100));
        const now = await stored(id);
        if (now && stateOf(now.task) !== "TASK_STATE_WORKING") return now.task;
      }
      return (await stored(id))?.task ?? record.task;
    },
  };

  /** A `(req, res)` handler: `createServer(handler)`, or `app.use("/agents/triage", handler)` in Express. */
  const handler: Handler = (req, res) => {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // Under a mount point (Express sets `baseUrl`), the card must name the mounted address.
    const mount = typeof (req as Mounted).baseUrl === "string" ? (req as Mounted).baseUrl! : "";
    const base = (options.publicUrl ?? `http://${req.headers.host}${mount}`).replace(/\/+$/, "");
    const path = new URL(req.url ?? "/", "http://local").pathname;

    if (req.method === "GET" && path === "/.well-known/agent-card.json") return json(200, card(base));
    if (req.method !== "POST" || path !== "/a2a") return json(404, { error: "not found: the card is at /.well-known/agent-card.json and the agent at POST /a2a" });

    // A body parser upstream (express.json()) has already read the stream.
    const parsed = (req as Mounted).body;
    if (parsed && typeof parsed === "object") return void answer(req, res, JSON.stringify(parsed), json);
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => void answer(req, res, raw, json));
  };

  async function answer(req: IncomingMessage, res: ServerResponse, raw: string, json: (code: number, body: unknown) => void): Promise<void> {
    let call: Json;
    try {
      call = obj(JSON.parse(raw));
    } catch {
      return json(200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON payload" } });
    }
    const id = call["id"] ?? null;
    const reply = (body: Json): void => json(200, { jsonrpc: "2.0", id, ...body });
    const failed = (error: unknown): Json => ({ error: { code: (error as { code?: number }).code ?? -32603, message: (error as Error).message } });
    const version = req.headers["a2a-version"];
    if (version && version !== "1.0") return reply({ error: { code: -32009, message: `A2A version ${String(version)} is not supported: this agent speaks 1.0` } });
    const params = obj(call["params"]);

    // Shutting down: no new work here. Asking after a task, or cancelling one, still works.
    if (draining && (call["method"] === "SendMessage" || call["method"] === "SendStreamingMessage")) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      return void res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "this instance is shutting down: send the message again" } }));
    }

    if (call["method"] === "SendStreamingMessage") {
      let entry: Entry;
      const early: Json[] = [];
      const hold = (event: Json): void => void early.push(event);
      try {
        entry = await accept(params, hold);
      } catch (error) {
        return reply(failed(error));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const write = (event: Json): void => void res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: event })}\n\n`);
      write({ task: entry.task });
      for (const event of early) write(event);
      entry.listeners.delete(hold);
      entry.listeners.add(write);
      // The caller hanging up is not a cancel: the task is asked after with GetTask, or stopped with CancelTask.
      res.on("close", () => entry.listeners.delete(write));
      await entry.settled;
      entry.listeners.delete(write);
      return void res.end();
    }

    const method = methods[String(call["method"])];
    if (!method) return reply({ error: { code: -32601, message: "Method not found" } });
    try {
      reply({ result: await method(params) });
    } catch (error) {
      reply(failed(error));
    }
  }

  const close = (): void => {
    for (const entry of tasks.values()) {
      clearInterval(entry.beat);
      entry.abort.abort();
    }
  };
  return {
    handler,
    drain: async (graceMs = 25_000) => {
      draining = true;
      const settled = Promise.all([...tasks.values()].map((entry) => entry.settled));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([settled, new Promise((done) => (timer = setTimeout(done, graceMs)))]);
      clearTimeout(timer);
      // Past the deadline: stop what is left, and let each task record that it was cancelled.
      close();
      await settled;
    },
    close,
  };
}
