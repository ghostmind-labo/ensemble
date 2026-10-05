/**
 * A2A — one message to a hosted agent, and the wait for its task to end.
 *
 * Agent2Agent is how an agent on somebody else's server is reached without
 * knowing what it is built from: a card at a well-known address says who it is
 * and where to talk, one call sends a message, and the answer is a task that
 * moves through declared states until it is done. That last part is why it fits
 * here. A task has a closed set of outcomes, so "delegate and wait" is one step
 * with a known end, not a conversation this library would have to steer.
 *
 * So the client does exactly one thing per node: discover, send, wait — by
 * streaming when the card offers it and by asking again when it does not — and
 * hand back the text and the artifacts. Two outcomes are refused rather than
 * papered over: `input-required` and `auth-required` are the agent asking a
 * question mid-task, and nothing inside a run can answer it, so the step fails
 * and says what to change.
 *
 * It speaks the protocol as published (v1.0: `SendMessage`, `TASK_STATE_*`,
 * parts without `kind`) and the 0.3 dialect still widely deployed
 * (`message/send`, lowercase states), choosing by what the card declares. The
 * JSON-RPC and HTTP+JSON bindings are both here; gRPC is not, because it cannot
 * be spoken without a dependency.
 *
 * Credentials are the ones `mcp-auth.ts` already knows — the same modes, the
 * same `${NAME}` secrets, the same redaction — because a hosted agent asks who
 * you are in exactly the ways a hosted MCP server does.
 */
import { randomUUID } from "node:crypto";
import { AgentError, type A2aAgentSpec, type AgentArtifact, type AgentReply, type AgentRequest } from "./agent.ts";
import { McpError, type ConnectOptions, type RemoteServerSpec } from "./mcp.ts";
import { authorizer, httpRequest, safeUrl, type Authorizer, type HttpResponse } from "./mcp-auth.ts";
import { events } from "./mcp-remote.ts";

export const A2A_VERSION = "1.0";
const CARD_PATHS = [".well-known/agent-card.json", ".well-known/agent.json"];
const REQUEST_TIMEOUT = 30_000;
const DEFAULT_TIMEOUT = 600_000;

export interface AgentInterface {
  url: string;
  /** `JSONRPC`, `HTTP+JSON`, `GRPC`, or a custom binding's name. */
  binding: string;
  /** `Major.Minor`, as the card declares it. */
  version?: string;
  tenant?: string;
}

/** An Agent Card, reduced to what a caller decides on. `raw` is the document as served. */
export interface AgentCard {
  name: string;
  description: string;
  version: string;
  /** Where the card was found. */
  url: string;
  interfaces: AgentInterface[];
  streaming: boolean;
  skills: Array<{ id: string; name: string; description: string; tags: string[] }>;
  /** Declared security schemes, by name and kind — what to configure, never a value. */
  security: Array<{ name: string; type: string }>;
  raw: Record<string, unknown>;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

const unprefixed = (error: unknown): string =>
  error instanceof McpError ? error.message.replace(/^mcp "[^"]*": /, "") : error instanceof Error ? error.message : String(error);

type CardOptions = Pick<ConnectOptions, "secretResolver" | "tokenStore" | "signal"> & { auth?: Authorizer };

const remoteSpec = (spec: A2aAgentSpec): RemoteServerSpec => ({
  url: spec.url,
  ...(spec.headers ? { headers: spec.headers } : {}),
  ...(spec.auth !== undefined ? { auth: spec.auth } : {}),
});

async function authFor(name: string, spec: A2aAgentSpec, options: CardOptions): Promise<Authorizer> {
  if (options.auth) return options.auth;
  try {
    return await authorizer(name, remoteSpec(spec), {
      ...(options.secretResolver ? { secretResolver: options.secretResolver } : {}),
      ...(options.tokenStore ? { tokenStore: options.tokenStore } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: REQUEST_TIMEOUT,
    });
  } catch (cause) {
    throw new AgentError(name, unprefixed(cause), { cause });
  }
}

/** Send, and when the server says 401 or 403, let auth answer and send again — twice at most. */
async function authed(auth: Authorizer, send: (headers: Record<string, string>) => Promise<HttpResponse>): Promise<HttpResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await send(await auth.headers());
    if ((response.status === 401 || response.status === 403) && attempt < 2) {
      const challenge = response.headers["www-authenticate"];
      response.body.resume();
      if (await auth.challenge(response.status, Array.isArray(challenge) ? challenge.join(", ") : challenge)) continue;
    }
    return response;
  }
}

function cardUrls(name: string, spec: A2aAgentSpec): URL[] {
  try {
    if (spec.card) return [new URL(spec.card, spec.url)];
    const given = new URL(spec.url);
    if (given.pathname.endsWith(".json")) return [given];
    const base = new URL(given.pathname.endsWith("/") ? given.href : `${given.origin}${given.pathname}/`);
    const out: URL[] = [];
    for (const path of CARD_PATHS) {
      out.push(new URL(path, base));
      if (base.pathname !== "/") out.push(new URL(`/${path}`, base));
    }
    // The current well-known name first wherever it is, then the legacy one.
    return out.sort((a, b) => Number(a.pathname.endsWith("agent.json")) - Number(b.pathname.endsWith("agent.json")));
  } catch {
    throw new AgentError(name, `"${spec.url}" is not a url — e.g. https://agent.example.com`);
  }
}

/** Both card generations, read into one shape. */
export function readCard(raw: Json, foundAt: string): AgentCard {
  const interfaces: AgentInterface[] = [];
  for (const entry of arr(raw["supportedInterfaces"])) {
    const face = obj(entry);
    if (!str(face["url"])) continue;
    interfaces.push({
      url: str(face["url"]),
      binding: str(face["protocolBinding"]) || "JSONRPC",
      ...(str(face["protocolVersion"]) ? { version: str(face["protocolVersion"]) } : {}),
      ...(str(face["tenant"]) ? { tenant: str(face["tenant"]) } : {}),
    });
  }
  if (!interfaces.length && str(raw["url"])) {
    // 0.2 / 0.3: one url, a preferred transport, and the rest beside it.
    const version = str(raw["protocolVersion"]) || "0.3";
    interfaces.push({ url: str(raw["url"]), binding: str(raw["preferredTransport"]) || "JSONRPC", version });
    for (const entry of arr(raw["additionalInterfaces"])) {
      const face = obj(entry);
      if (str(face["url"])) interfaces.push({ url: str(face["url"]), binding: str(face["transport"]) || "JSONRPC", version });
    }
  }
  const security = Object.entries(obj(raw["securitySchemes"])).map(([name, scheme]) => {
    const body = obj(scheme);
    const type = str(body["type"]) || (Object.keys(body)[0] ?? "unknown").replace(/SecurityScheme$/, "");
    return { name, type };
  });
  return {
    name: str(raw["name"]),
    description: str(raw["description"]),
    version: str(raw["version"]),
    url: foundAt,
    interfaces,
    streaming: obj(raw["capabilities"])["streaming"] === true,
    skills: arr(raw["skills"]).map((entry) => {
      const skill = obj(entry);
      return {
        id: str(skill["id"]),
        name: str(skill["name"]),
        description: str(skill["description"]),
        tags: arr(skill["tags"]).filter((tag): tag is string => typeof tag === "string"),
      };
    }),
    security,
    raw,
  };
}

/**
 * Fetch an agent's card.
 *
 * Discovery is the point of the protocol: the card says what the agent is
 * called, what it can do, where to talk to it and how to prove who you are.
 * `preflight` and `ensemble agents card` read it before a run does.
 */
export async function agentCard(name: string, spec: A2aAgentSpec, options: CardOptions = {}): Promise<AgentCard> {
  const candidates = cardUrls(name, spec);
  const auth = await authFor(name, spec, options);
  const tried: string[] = [];
  for (const url of candidates) {
    let response: HttpResponse;
    try {
      response = await authed(auth, (headers) =>
        httpRequest(auth.url(url), {
          headers: { ...headers, accept: "application/json" },
          tls: auth.tls,
          signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]) : AbortSignal.timeout(REQUEST_TIMEOUT),
        }),
      );
    } catch (cause) {
      if (options.signal?.aborted) throw new AgentError(name, "was aborted before its card was read", { cause });
      throw new AgentError(name, auth.redact(`could not reach ${safeUrl(url)}: ${unprefixed(cause)}`), { cause });
    }
    if (response.status === 200) {
      const text = await response.text();
      try {
        const card = readCard(obj(JSON.parse(text)), safeUrl(url));
        if (card.name || card.interfaces.length) return card;
      } catch {
        /* not JSON — fall through and say so */
      }
      throw new AgentError(name, `${safeUrl(url)} answered, but not with an Agent Card — set card: "<the card's url>" on the agent`);
    }
    response.body.resume();
    tried.push(`${safeUrl(url)} (HTTP ${response.status})`);
    if (response.status !== 404 && response.status !== 405 && response.status !== 400) break;
  }
  throw new AgentError(
    name,
    `no Agent Card found — tried ${tried.join(", ")}. An A2A agent publishes one at /.well-known/agent-card.json; ` +
      `set card: "<url>" on the agent if it is elsewhere`,
  );
}

type Dialect = "1.0" | "0.3";
interface Route {
  endpoint: URL;
  binding: "JSONRPC" | "HTTP+JSON";
  dialect: Dialect;
  tenant?: string;
}

const sameBinding = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

/** Which of the card's interfaces this client talks to, and in which dialect. */
export function chooseInterface(name: string, spec: A2aAgentSpec, card: AgentCard): Route {
  const speakable = card.interfaces.filter((face) => sameBinding(face.binding, "JSONRPC") || sameBinding(face.binding, "HTTP+JSON"));
  const wanted = spec.binding ? speakable.filter((face) => sameBinding(face.binding, spec.binding!)) : speakable;
  if (!wanted.length) {
    const offered = [...new Set(card.interfaces.map((face) => face.binding))].join(", ") || "none";
    throw new AgentError(
      name,
      spec.binding && speakable.length
        ? `its card offers no ${spec.binding} interface (offered: ${offered}) — drop binding, or pick one it offers`
        : `its card offers ${offered}, and this client speaks JSONRPC and HTTP+JSON — ask the agent's owner to enable the JSON-RPC binding`,
    );
  }
  const rank = (face: AgentInterface): number =>
    (sameBinding(face.binding, "JSONRPC") ? 0 : 2) + ((face.version ?? "1").startsWith("0.") ? 1 : 0);
  const face = [...wanted].sort((a, b) => rank(a) - rank(b))[0]!;
  const dialect: Dialect = spec.version ?? ((face.version ?? "1").startsWith("0.") ? "0.3" : "1.0");
  const binding = sameBinding(face.binding, "JSONRPC") ? "JSONRPC" : "HTTP+JSON";
  if (binding === "HTTP+JSON" && dialect === "0.3") {
    throw new AgentError(name, `offers A2A 0.3 over HTTP+JSON only, which this client does not speak — it needs the JSON-RPC binding or A2A 1.0`);
  }

  let endpoint: URL;
  try {
    endpoint = new URL(spec.endpoint ?? face.url);
  } catch {
    throw new AgentError(name, `its card names "${face.url}" as its address, which is not a url — set endpoint: "<url>" on the agent`);
  }
  if (!spec.endpoint) {
    const credentials = Boolean(spec.auth) || Object.keys(spec.headers ?? {}).length > 0;
    let home: string | undefined;
    try {
      home = new URL(spec.url).origin;
    } catch {
      home = undefined;
    }
    if (credentials && home && endpoint.origin !== home) {
      throw new AgentError(
        name,
        `its card sends requests to ${safeUrl(endpoint)}, a different origin from ${home} — credentials are not forwarded there ` +
          `on a card's say-so. If that address is right, set endpoint: "${safeUrl(endpoint)}" on the agent`,
      );
    }
  }
  return { endpoint, binding, dialect, ...(face.tenant ? { tenant: face.tenant } : {}) };
}

/* ───────────────────────────── reading replies ───────────────────────────── */

const TERMINAL = new Set(["completed", "failed", "canceled", "rejected"]);
const INTERRUPTED = new Set(["input-required", "auth-required"]);

/** `TASK_STATE_INPUT_REQUIRED` and `input-required` are the same state. */
export const taskState = (value: unknown): string =>
  str(value).replace(/^TASK_STATE_/, "").toLowerCase().replace(/_/g, "-") || "unknown";

function readParts(parts: unknown): { text: string; data: unknown[]; files: NonNullable<AgentArtifact["files"]> } {
  const text: string[] = [];
  const data: unknown[] = [];
  const files: NonNullable<AgentArtifact["files"]> = [];
  for (const entry of arr(parts)) {
    const part = obj(entry);
    if (typeof part["text"] === "string") text.push(part["text"]);
    else if ("data" in part) data.push(part["data"]);
    else if ("url" in part || "raw" in part || "file" in part) {
      const file = obj(part["file"]);
      const url = str(part["url"]) || str(file["uri"]) || str(file["fileWithUri"]);
      const filename = str(part["filename"]) || str(file["name"]);
      const mediaType = str(part["mediaType"]) || str(file["mimeType"]);
      // Bytes are not carried into a run record; the name and type are.
      files.push({ ...(url ? { url } : {}), ...(filename ? { filename } : {}), ...(mediaType ? { mediaType } : {}) });
    }
  }
  return { text: text.join(""), data, files };
}

interface Progress {
  taskId?: string;
  contextId?: string;
  state: string;
  statusText: string;
  message?: string;
  artifacts: Map<string, AgentArtifact>;
}

function absorbTask(progress: Progress, task: Json): void {
  if (str(task["id"])) progress.taskId = str(task["id"]);
  if (str(task["contextId"])) progress.contextId = str(task["contextId"]);
  absorbStatus(progress, obj(task["status"]));
  if (Array.isArray(task["artifacts"])) {
    progress.artifacts.clear();
    for (const artifact of task["artifacts"]) absorbArtifact(progress, obj(artifact), false);
  }
}

function absorbStatus(progress: Progress, status: Json): void {
  if (status["state"] !== undefined) progress.state = taskState(status["state"]);
  const said = readParts(obj(status["message"])["parts"]).text;
  if (said) progress.statusText = said;
}

function absorbArtifact(progress: Progress, artifact: Json, append: boolean): void {
  const id = str(artifact["artifactId"]) || `artifact-${progress.artifacts.size}`;
  const { text, data, files } = readParts(artifact["parts"]);
  const existing = append ? progress.artifacts.get(id) : undefined;
  if (existing) {
    existing.text += text;
    if (data.length) existing.data = [...(existing.data ?? []), ...data];
    if (files.length) existing.files = [...(existing.files ?? []), ...files];
    return;
  }
  progress.artifacts.set(id, {
    id,
    ...(str(artifact["name"]) ? { name: str(artifact["name"]) } : {}),
    text,
    ...(data.length ? { data } : {}),
    ...(files.length ? { files } : {}),
  });
}

/** One response payload or stream event, in either dialect. */
function absorb(progress: Progress, payload: Json): void {
  const kind = str(payload["kind"]);
  if (payload["task"]) return absorbTask(progress, obj(payload["task"]));
  if (payload["message"] && !payload["status"]) {
    progress.message = readParts(obj(payload["message"])["parts"]).text;
    return;
  }
  const status = payload["statusUpdate"] ?? (kind === "status-update" ? payload : undefined);
  if (status) {
    const event = obj(status);
    if (str(event["taskId"])) progress.taskId = str(event["taskId"]);
    if (str(event["contextId"])) progress.contextId = str(event["contextId"]);
    return absorbStatus(progress, obj(event["status"]));
  }
  const update = payload["artifactUpdate"] ?? (kind === "artifact-update" ? payload : undefined);
  if (update) {
    const event = obj(update);
    if (str(event["taskId"])) progress.taskId = str(event["taskId"]);
    return absorbArtifact(progress, obj(event["artifact"]), event["append"] === true);
  }
  if (kind === "message" || (Array.isArray(payload["parts"]) && payload["role"] !== undefined)) {
    progress.message = readParts(payload["parts"]).text;
    return;
  }
  if (kind === "task" || payload["status"] !== undefined) absorbTask(progress, payload);
}

/* ────────────────────────────────── the call ─────────────────────────────── */

const METHODS = {
  "1.0": { send: "SendMessage", stream: "SendStreamingMessage", get: "GetTask", cancel: "CancelTask" },
  "0.3": { send: "message/send", stream: "message/stream", get: "tasks/get", cancel: "tasks/cancel" },
} as const;

type Operation = keyof (typeof METHODS)["1.0"];

/** The agent said no in the protocol's own terms. `code` lets a caller tell "cannot stream" from "broken". */
class A2aRefusal extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });

/** Delegate one message to an A2A agent and wait for the task to end. */
export async function sendA2a(name: string, spec: A2aAgentSpec, request: AgentRequest): Promise<AgentReply> {
  const limit = spec.timeoutMs ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limit);
  const relay = (): void => controller.abort();
  if (request.signal.aborted) relay();
  else request.signal.addEventListener("abort", relay, { once: true });

  const progress: Progress = { state: "unknown", statusText: "", artifacts: new Map() };
  let auth: Authorizer | undefined;
  let route: Route | undefined;
  let card: AgentCard | undefined;
  let streamed = false;
  let nextId = 1;

  const call = async (operation: Operation, params: Json, signal: AbortSignal, stream = false): Promise<HttpResponse> => {
    const { endpoint, binding, dialect, tenant } = route!;
    const version: Record<string, string> = dialect === "1.0" ? { "a2a-version": A2A_VERSION } : {};
    const accept = stream ? "text/event-stream, application/json" : "application/json";
    if (binding === "JSONRPC") {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: METHODS[dialect][operation],
        params: tenant ? { tenant, ...params } : params,
      });
      return authed(auth!, (headers) =>
        httpRequest(auth!.url(endpoint), {
          method: "POST",
          headers: { ...headers, ...version, "content-type": "application/json", accept },
          body,
          tls: auth!.tls,
          signal,
        }),
      );
    }
    const base = `${endpoint.href.replace(/\/+$/, "")}${tenant ? `/${encodeURIComponent(tenant)}` : ""}`;
    const id = encodeURIComponent(str(params["id"]));
    const [method, path] =
      operation === "send" ? ["POST", "/message:send"]
      : operation === "stream" ? ["POST", "/message:stream"]
      : operation === "get" ? ["GET", `/tasks/${id}`]
      : ["POST", `/tasks/${id}:cancel`];
    const sends = method === "POST";
    return authed(auth!, (headers) =>
      httpRequest(auth!.url(new URL(`${base}${path}`)), {
        method: method!,
        headers: { ...headers, ...version, accept, ...(sends ? { "content-type": "application/a2a+json" } : {}) },
        ...(sends ? { body: JSON.stringify(operation === "cancel" ? {} : params) } : {}),
        tls: auth!.tls,
        signal,
      }),
    );
  };

  /** A JSON-RPC envelope or a bare REST body, down to the payload. */
  const payloadOf = (value: unknown): Json => {
    const body = obj(value);
    if (body["error"] !== undefined && (body["jsonrpc"] !== undefined || body["result"] === undefined)) {
      const error = obj(body["error"]);
      const code = typeof error["code"] === "number" ? error["code"] : undefined;
      throw new A2aRefusal(str(error["message"]) || "the request was refused", code);
    }
    return body["jsonrpc"] !== undefined ? obj(body["result"]) : body;
  };

  const settled = async (operation: Operation, params: Json): Promise<void> => {
    // A send may legitimately block until the task ends, so only the call's own
    // deadline bounds it; asking after a task is quick or it is broken.
    const signal = operation === "send" ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]);
    const response = await call(operation, params, signal);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new A2aRefusal(`HTTP ${response.status}${text.trim() ? `: ${text.trim().slice(0, 200)}` : ""}`);
    }
    if (response.status >= 400 && obj(parsed)["error"] === undefined) {
      throw new A2aRefusal(`HTTP ${response.status}: ${str(obj(parsed)["message"]) || text.trim().slice(0, 200)}`);
    }
    absorb(progress, payloadOf(parsed));
  };

  const ended = (): boolean => progress.message !== undefined || TERMINAL.has(progress.state) || INTERRUPTED.has(progress.state);

  const cancelTask = async (): Promise<boolean> => {
    if (!route || !auth || !progress.taskId || TERMINAL.has(progress.state)) return false;
    try {
      const response = await call("cancel", { id: progress.taskId }, AbortSignal.timeout(3_000));
      response.body.resume();
      return response.status < 400;
    } catch {
      return false;
    }
  };

  const partial = (): Partial<AgentReply> => ({
    status: progress.state,
    artifacts: [...progress.artifacts.values()],
    meta: meta(),
  });
  const meta = (): Record<string, unknown> => ({
    ...(card?.name ? { name: card.name } : {}),
    ...(card?.version ? { version: card.version } : {}),
    ...(route ? { a2a: route.dialect, binding: route.binding } : {}),
    ...(progress.taskId ? { taskId: progress.taskId } : {}),
    ...(progress.contextId ? { contextId: progress.contextId } : {}),
    streamed,
  });
  const redact = (text: string): string => (auth ? auth.redact(text) : text);

  try {
    auth = await authFor(name, spec, { ...request, signal: controller.signal });
    card = await agentCard(name, spec, { auth, signal: controller.signal });
    route = chooseInterface(name, spec, card);

    const legacy = route.dialect === "0.3";
    const message: Json = legacy
      ? { kind: "message", messageId: randomUUID(), role: "user", parts: [{ kind: "text", text: request.prompt }] }
      : { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: request.prompt }] };

    let sent = false;
    if (card.streaming && spec.streaming !== false) {
      try {
        const response = await call("stream", { message }, controller.signal, true);
        const type = String(response.headers["content-type"] ?? "");
        if (response.status < 400 && type.includes("text/event-stream")) {
          streamed = true;
          sent = true;
          for await (const event of events(response.body)) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(event.data);
            } catch {
              continue;
            }
            absorb(progress, payloadOf(parsed));
            if (progress.message !== undefined || TERMINAL.has(progress.state) || INTERRUPTED.has(progress.state)) break;
          }
          response.body.destroy();
        } else {
          // Offered streaming, answered plainly. Read what it said.
          const text = await response.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new A2aRefusal(`HTTP ${response.status}${text.trim() ? `: ${text.trim().slice(0, 200)}` : ""}`);
          }
          absorb(progress, payloadOf(parsed));
          sent = true;
        }
      } catch (error) {
        // "I do not stream after all" is an answer; anything else is a failure.
        const cannot = error instanceof A2aRefusal && (error.code === -32004 || error.code === -32601);
        if (!cannot || sent) throw error;
      }
    }
    if (!sent) await settled("send", { message, ...(legacy ? { configuration: { blocking: true } } : {}) });

    // The stream closed early, or the server answered before the task ended: ask until it has.
    let pause = Math.max(50, spec.pollMs ?? 1_000);
    while (!ended()) {
      if (!progress.taskId) {
        throw new A2aRefusal(`answered without a task id while the task was "${progress.state}", so there is nothing to wait on`);
      }
      await wait(pause, controller.signal);
      pause = Math.min(Math.round(pause * 1.5), Math.max(5_000, spec.pollMs ?? 0));
      await settled("get", { id: progress.taskId });
    }

    const artifacts = [...progress.artifacts.values()];
    if (progress.message === undefined && progress.state !== "completed") {
      const said = progress.statusText ? `: ${progress.statusText.slice(0, 300)}` : "";
      if (progress.state === "input-required") {
        const cancelled = await cancelTask();
        throw new AgentError(
          name,
          redact(
            `the task stopped at input-required${said} — the agent is asking a question, and nothing inside a run can answer it` +
              `${cancelled ? " (the task was cancelled)" : ""}. Put what it needs in the node's prompt or reads, ` +
              `or ask a person first with a by: "human" node and pass their answer in`,
          ),
          { partial: partial() },
        );
      }
      if (progress.state === "auth-required") {
        const cancelled = await cancelTask();
        throw new AgentError(
          name,
          redact(
            `the task stopped at auth-required${said} — the agent needs a credential it was not given` +
              `${cancelled ? " (the task was cancelled)" : ""}. Authorise it out of band, or add auth to agents.${name}`,
          ),
          { partial: partial() },
        );
      }
      throw new AgentError(name, redact(`the task ended ${progress.state}${said}`), { partial: partial() });
    }

    const data = artifacts.flatMap((artifact) => artifact.data ?? []);
    const text =
      progress.message !== undefined && !artifacts.some((artifact) => artifact.text)
        ? progress.message
        : artifacts.map((artifact) => artifact.text).filter(Boolean).join("\n\n") || progress.statusText || progress.message || "";
    return {
      text,
      status: "completed",
      artifacts,
      toolCalls: [],
      permissions: [],
      ...(data.length ? { data: data.length === 1 ? data[0] : data } : {}),
      // A2A defines no field for what a task cost, so none is reported and none is invented.
      meta: meta(),
    };
  } catch (error) {
    if (error instanceof AgentError) throw error;
    if (controller.signal.aborted) {
      const cancelled = await cancelTask();
      throw new AgentError(
        name,
        (timedOut ? `did not finish within ${limit}ms — raise timeoutMs on the agent if it needs longer` : "was aborted") +
          (progress.taskId ? ` (task ${progress.taskId}${cancelled ? " cancelled" : ", cancel not confirmed"})` : ""),
        { cause: error, partial: partial() },
      );
    }
    const where = route ? safeUrl(route.endpoint) : safeUrl(spec.url);
    throw new AgentError(
      name,
      redact(error instanceof A2aRefusal ? `${where} refused: ${error.message}` : `could not reach ${where}: ${unprefixed(error)}`),
      { cause: error, partial: partial() },
    );
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", relay);
  }
}
