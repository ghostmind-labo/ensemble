#!/usr/bin/env node
/**
 * Runners, callable as tools.
 *
 * The library is an MCP client (`src/mcp.ts`) and serves nothing, on purpose.
 * But a runner is exactly a tool seen from outside: arguments go in, a result
 * comes out. So this adapter stands beside the library, like `a2a/` (it is not
 * in the npm package), and exposes runners you already wrote to anything that
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
 * It keeps nothing between requests, as the protocol now requires. A paused run
 * travels to the caller and back as an encrypted token, so any instance holding
 * the same `secret` can resume it.
 *
 * It speaks the current revision (2026-07-28: no handshake, metadata on every
 * request) and the handshake-based ones before it, because most deployed
 * clients, including this library's own, still open with `initialize`.
 *
 *   node mcp/serve.mts examples/01-triage/triage.mts              # stdio
 *   node mcp/serve.mts triage.mts refunds.mts --port 4321         # Streamable HTTP at /mcp
 *
 * Options: --port (serve over HTTP instead of stdio), --host (127.0.0.1),
 * --token or MCP_TOKEN (require a bearer token), --budget (USD cap per call),
 * --secret or MCP_SECRET (the key paused runs are sealed with).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  HumanAnswerError,
  isRunner,
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
  type Runner,
  type State,
} from "../src/index.ts";

type Json = Record<string, unknown>;

export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const META = "io.modelcontextprotocol/";
const SERVER_INFO = { name: "ensemble", version: "1" };
/** The tool that answers a paused run for callers that cannot be sent a form. */
const ANSWER_TOOL = "answer";

export interface ToolsOptions {
  /** Require `Authorization: Bearer <token>` on every HTTP call. */
  token?: string;
  /** USD cap on each call. */
  budget?: number;
  /** Seals paused runs. Set it to resume across restarts or instances; default: random, per process. */
  secret?: string;
  /** How long a paused run may wait for its answer. Default 24 hours. */
  pauseTtlMs?: number;
  /** Origins a browser may call from, besides the server's own host. */
  allowedOrigins?: string[];
  /** Passed to every run: a stub decider in a test, a step timeout, a secret resolver. */
  run?: Omit<RunOptions, "signal" | "onEvent" | "human" | "budget">;
}

export interface ServeOptions extends ToolsOptions {
  port?: number;
  host?: string;
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
  /** Stop every run in flight. */
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

  /** Run or resume, with progress and cancel wired. Every ending is a tool result; only a bad token throws. */
  async function drive(tool: string, start: (runOptions: RunOptions) => Promise<RunOutcome>, params: Json, context: Context, form: boolean, resumed?: Paused): Promise<Json> {
    const token = obj(params["_meta"])["progressToken"];
    let progress = 0;
    const tell = (message: string): void => {
      if (token === undefined || !context.notify) return;
      context.notify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++progress, message } });
    };
    const onEvent = (event: RunEvent): void => {
      if (event.type === "node:start") tell(event.waiting);
      else if (event.type === "node:end") tell(`${event.step.node} ${event.step.error ? "failed" : event.step.took ? `took ${event.step.took}` : "ended"}`);
    };
    const abort = new AbortController();
    const relay = (): void => abort.abort();
    if (context.signal.aborted) relay();
    else context.signal.addEventListener("abort", relay, { once: true });
    live.add(abort);
    try {
      const outcome = await start({ ...options.run, signal: abort.signal, onEvent, ...(options.budget !== undefined ? { budget: options.budget } : {}) });
      return resultOf(tool, outcome, form);
    } catch (error) {
      const cause = error instanceof RunFailed ? error.cause : error;
      // An answer that does not fit ran nothing: ask again, on the same snapshot, and say what was wrong.
      if (resumed && (cause instanceof HumanAnswerError || cause instanceof ResumeError)) return pausedResult(tool, resumed, form, cause.message);
      const message = error instanceof Error ? error.message : String(error);
      return { content: text(message), ...(error instanceof RunFailed ? { structuredContent: { status: "failed", run: summary(error.run) } } : {}), isError: true };
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

    return drive(name, (runOptions) => runner(args as State, runOptions), params, context, form);
  }

  /* ── the protocol: one message at a time, nothing remembered ── */

  const inFlight = new Map<string | number, AbortController>();

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
        // A form may be sent only to a caller that said it can show one, and only in the current revision.
        const elicitation = obj(meta[`${META}clientCapabilities`])["elicitation"];
        const form = modern && elicitation !== undefined && (Object.keys(obj(elicitation)).length === 0 || obj(elicitation)["form"] !== undefined);
        const abort = new AbortController();
        const relay = (): void => abort.abort();
        context.signal.addEventListener("abort", relay, { once: true });
        inFlight.set(id, abort);
        try {
          const result = await call(params, { ...context, signal: abort.signal }, form);
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
    if (options.token && req.headers.authorization !== `Bearer ${options.token}`) return json(401, undefined, { "www-authenticate": 'Bearer realm="ensemble"' });

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
      json(reply.status, reply.body);
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
    close: () => {
      for (const abort of live) abort.abort();
    },
  };
}

export interface Served {
  url: string;
  server: Server;
  close(): Promise<void>;
}

/** Serve runners over Streamable HTTP on their own port: the handler, listening at `/mcp`. */
export async function serveTools(runners: Runner[] | Record<string, Runner>, options: ServeOptions = {}): Promise<Served> {
  const tools = mcpTools(runners, options);
  const server = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://local").pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "not found: the MCP endpoint is POST /mcp" }));
    }
    tools.handler(req, res);
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 4321, options.host ?? "127.0.0.1", () => done());
  });
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://${address.includes(":") ? `[${address}]` : address}:${port}/mcp`,
    server,
    close: () =>
      new Promise<void>((done) => {
        tools.close();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { port: { type: "string" }, host: { type: "string" }, token: { type: "string" }, budget: { type: "string" }, secret: { type: "string" } },
  });
  if (!positionals.length) {
    process.stderr.write("Usage: node mcp/serve.mts <runner-file> [more files] [--port 4321] [--host 127.0.0.1] [--token …] [--budget <usd>] [--secret …]\n       without --port it speaks MCP over stdio\n");
    process.exit(2);
  }
  // On stdio, stdout carries protocol messages only: whatever a handler logs goes to stderr.
  if (!values.port) console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  const runners: Runner[] = [];
  for (const file of positionals) {
    const module = (await import(pathToFileURL(resolve(file)).href)) as { default?: unknown };
    if (!isRunner(module.default)) {
      process.stderr.write(`${file} has no runner as its default export: export default runner({ … })\n`);
      process.exit(2);
    }
    runners.push(module.default);
  }
  const token = values.token ?? process.env["MCP_TOKEN"];
  const secret = values.secret ?? process.env["MCP_SECRET"];
  const options: ServeOptions = {
    ...(token ? { token } : {}),
    ...(secret ? { secret } : {}),
    ...(values.budget ? { budget: Number(values.budget) } : {}),
    ...(values.host ? { host: values.host } : {}),
  };
  const names = runners.map((runner) => runner.spec.name).join(", ");
  if (values.port) {
    const served = await serveTools(runners, { ...options, port: Number(values.port) });
    process.stderr.write(`${names}: MCP tools at ${served.url}\n`);
  } else {
    process.stderr.write(`${names}: MCP tools on stdio\n`);
    await mcpTools(runners, options).stdio();
  }
}
