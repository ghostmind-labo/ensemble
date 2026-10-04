#!/usr/bin/env node
/**
 * A runner, callable as an agent.
 *
 * The library consumes agents (`src/a2a.ts`) and serves nothing, on purpose. But
 * a runner is exactly what Agent2Agent describes from the outside: a goal goes
 * in, a task moves through declared states, and a result comes out. So this
 * adapter stands beside the library, not inside it (it is not in the npm
 * package), and maps one onto the other without adding a concept to either:
 *
 *   a message                 → the runner's `goal` (and inputs, as a data part)
 *   the RunEvent stream       → status updates, one as each node starts and ends
 *   a `by: "human"` pause     → `input-required`; the caller answers, the run resumes
 *   CancelTask                → the run's AbortSignal
 *   the result                → one artifact
 *
 * The caller steers only where the graph declared a pause, with the same closed
 * questions a person would get, so the record still says who answered what. It
 * cannot push state into a run at any other moment: that would be a write with
 * no origin, which `validate` exists to rule out.
 *
 * A2A has no field for what a task cost, so the run's cost travels in the
 * task's `metadata.ensemble`, next to the run id and the steps taken.
 *
 *   node a2a/serve.mts examples/01-triage/triage.mts --port 4320
 *   agents: { triage: { protocol: "a2a", url: "http://localhost:4320" } }
 *
 * Options: --port (4320), --host (127.0.0.1), --token or A2A_TOKEN (require a
 * bearer token), --budget (USD cap per task), --public-url (the address callers
 * reach this at, for the card). Serving costs nothing; each task is a real run.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  HumanAnswerError,
  isRunner,
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
} from "../src/index.ts";

type Json = Record<string, unknown>;

export interface AgentOptions {
  /** Require `Authorization: Bearer <token>` on every call. The card says so. */
  token?: string;
  /** USD cap per task. A caller may ask for less (`metadata.budget`), never more. */
  budget?: number;
  /** The address callers reach this server at, for the card. Default: the request's Host. */
  publicUrl?: string;
  /** Passed to every run: a stub decider in a test, a step timeout, a secret resolver. */
  run?: Omit<RunOptions, "signal" | "onEvent" | "human" | "budget">;
  /** Finished tasks kept for GetTask. Default 200. */
  keep?: number;
}

export interface ServeOptions extends AgentOptions {
  port?: number;
  host?: string;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;
/** What a framework may have added to the request: a mount point, an already-parsed body. */
type Mounted = IncomingMessage & { baseUrl?: string; body?: unknown };

export interface A2aAgent {
  handler: Handler;
  /** Stop every run in flight. */
  close(): void;
}

export interface Served {
  url: string;
  server: Server;
  close(): Promise<void>;
}

interface Entry {
  task: Json;
  abort: AbortController;
  /** Present while the run waits for the caller's answer. */
  paused?: Paused;
  budget?: number;
  listeners: Set<(event: Json) => void>;
  settled: Promise<void>;
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
  const tasks = new Map<string, Entry>();
  const keep = options.keep ?? 200;

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
    ...(options.token
      ? {
          securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
          securityRequirements: [{ schemes: { bearer: { list: [] } } }],
        }
      : {}),
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
          ...(step.error ? { error: step.error } : {}),
        });
      }
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
      .finally(() => {
        // Forget the oldest finished tasks; a waiting or running one is never dropped.
        for (const [id, old] of tasks) {
          if (tasks.size <= keep) break;
          if (DONE.has(String(obj(old.task["status"])["state"]))) tasks.delete(id);
        }
      });
  }

  /** A new task, or the answer to one that is waiting. Returns the entry, already running. */
  function accept(params: Json, listen?: (event: Json) => void): Entry {
    const message = obj(params["message"]);
    const waitingId = typeof message["taskId"] === "string" ? message["taskId"] : undefined;
    if (waitingId) {
      const entry = tasks.get(waitingId);
      if (!entry) throw refuse(-32001, "Task not found");
      const paused = entry.paused;
      if (!paused) throw refuse(-32602, `Task ${waitingId} is not waiting for an answer: it is ${String(obj(entry.task["status"])["state"])}`);
      const answer = toAnswer(message, paused.pending);
      delete entry.paused;
      entry.task["status"] = status("TASK_STATE_WORKING");
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
    };
    tasks.set(String(entry.task["id"]), entry);
    // Before the run starts: its first node:start fires synchronously.
    if (listen) entry.listeners.add(listen);
    entry.settled = drive(entry, (runOptions) => runner(inputs, runOptions));
    return entry;
  }

  const find = (params: Json): Entry => {
    const entry = tasks.get(String(params["id"]));
    if (!entry) throw refuse(-32001, "Task not found");
    return entry;
  };

  const methods: Record<string, (params: Json) => Promise<Json>> = {
    SendMessage: async (params) => {
      const entry = accept(params);
      const configuration = obj(params["configuration"]);
      if (configuration["returnImmediately"] !== true && configuration["blocking"] !== false) await entry.settled;
      return { task: entry.task };
    },
    GetTask: async (params) => find(params).task,
    CancelTask: async (params) => {
      const entry = find(params);
      if (DONE.has(String(obj(entry.task["status"])["state"]))) throw refuse(-32002, "Task cannot be canceled");
      entry.abort.abort();
      if (entry.paused) {
        // Nothing is running: the run rests in its snapshot, so dropping the snapshot is the cancel.
        delete entry.paused;
        update(entry, status("TASK_STATE_CANCELED"));
      } else await entry.settled;
      return entry.task;
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
    if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
      res.writeHead(401, { "www-authenticate": `Bearer realm="${graph.runner.name}"` });
      return void res.end();
    }

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

    if (call["method"] === "SendStreamingMessage") {
      let entry: Entry;
      const early: Json[] = [];
      const hold = (event: Json): void => void early.push(event);
      try {
        entry = accept(params, hold);
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

  return {
    handler,
    close: () => {
      for (const entry of tasks.values()) entry.abort.abort();
    },
  };
}

/** Serve one runner on its own port: the handler, listening. */
export async function serveRunner(runner: Runner, options: ServeOptions = {}): Promise<Served> {
  const agent = a2aAgent(runner, options);
  const server = createServer(agent.handler);
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 4320, options.host ?? "127.0.0.1", () => done());
  });
  const { address, port } = server.address() as AddressInfo;
  return {
    url: options.publicUrl ?? `http://${address.includes(":") ? `[${address}]` : address}:${port}`,
    server,
    close: () =>
      new Promise<void>((done) => {
        agent.close();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { port: { type: "string" }, host: { type: "string" }, token: { type: "string" }, budget: { type: "string" }, "public-url": { type: "string" } },
  });
  const file = positionals[0];
  if (!file) {
    process.stderr.write("Usage: node a2a/serve.mts <runner-file> [--port 4320] [--host 127.0.0.1] [--token …] [--budget <usd>] [--public-url …]\n");
    process.exit(2);
  }
  const module = (await import(pathToFileURL(resolve(file)).href)) as { default?: unknown };
  if (!isRunner(module.default)) {
    process.stderr.write(`${file} has no runner as its default export: export default runner({ … })\n`);
    process.exit(2);
  }
  const token = values.token ?? process.env["A2A_TOKEN"];
  const served = await serveRunner(module.default, {
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.host ? { host: values.host } : {}),
    ...(token ? { token } : {}),
    ...(values.budget ? { budget: Number(values.budget) } : {}),
    ...(values["public-url"] ? { publicUrl: values["public-url"] } : {}),
  });
  process.stderr.write(`${module.default.spec.name} is an A2A agent at ${served.url} (card: ${served.url}/.well-known/agent-card.json)\n`);
}
