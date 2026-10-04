// A2A, against a real HTTP server in this process rather than a mocked fetch:
// the card, the JSON-RPC and HTTP+JSON bindings, an SSE stream, polling,
// cancellation, auth, and both protocol generations (1.0 and 0.3).
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AgentError,
  agentCard,
  preflight,
  runner,
  RunFailed,
  sendA2a,
  taskState,
  type A2aAgentSpec,
  type AgentRequest,
} from "../src/index.ts";

type Json = Record<string, unknown>;

interface Fake {
  url: string;
  close(): Promise<void>;
  /** Every request seen: method (JSON-RPC or REST path) and headers. */
  seen: Array<{ method: string; headers: IncomingMessage["headers"]; params?: Json }>;
  cancelled: string[];
}

/** A small A2A agent. The prompt's first word picks what the task does. */
async function fake(options: {
  dialect?: "1.0" | "0.3";
  streaming?: boolean;
  binding?: "JSONRPC" | "HTTP+JSON" | "GRPC";
  token?: string;
  cardPath?: string;
  endpointHost?: string;
  security?: boolean;
} = {}): Promise<Fake> {
  const v1 = (options.dialect ?? "1.0") === "1.0";
  const seen: Fake["seen"] = [];
  const cancelled: string[] = [];
  const polls = new Map<string, number>();
  const tasks = new Map<string, string>();
  let counter = 0;

  const state = (name: string): string => (v1 ? `TASK_STATE_${name.toUpperCase().replace(/-/g, "_")}` : name);
  const part = (text: string): Json => (v1 ? { text } : { kind: "text", text });
  const task = (id: string, name: string, extra: Json = {}): Json => ({
    ...(v1 ? {} : { kind: "task" }),
    id,
    contextId: "ctx-1",
    status: { state: state(name), ...(extra["say"] ? { message: { role: v1 ? "ROLE_AGENT" : "agent", parts: [part(String(extra["say"]))] } } : {}) },
    ...(extra["artifacts"] ? { artifacts: extra["artifacts"] } : {}),
  });
  const report = (text: string): Json[] => [
    { artifactId: "a1", name: "report", parts: [part(text), v1 ? { data: { score: 7 }, mediaType: "application/json" } : { kind: "data", data: { score: 7 } }] },
  ];
  const wrapTask = (body: Json): Json => (v1 ? { task: body } : body);

  const textOf = (message: Json): string =>
    ((message["parts"] as Json[]) ?? []).map((p) => String(p["text"] ?? "")).join("");

  const start = (prompt: string): Json => {
    const id = `task-${++counter}`;
    const word = prompt.trim().split(/\s+/)[0]!;
    tasks.set(id, word);
    switch (word) {
      case "message":
        return v1
          ? { message: { messageId: "m1", role: "ROLE_AGENT", parts: [part("just a message")] } }
          : { kind: "message", messageId: "m1", role: "agent", parts: [part("just a message")] };
      case "slow":
      case "hang":
        return wrapTask(task(id, "working"));
      case "ask":
        return wrapTask(task(id, "input-required", { say: "Which city?" }));
      case "authreq":
        return wrapTask(task(id, "auth-required", { say: "Sign in to the calendar" }));
      case "fail":
        return wrapTask(task(id, "failed", { say: "the upstream search is down" }));
      default:
        return wrapTask(task(id, "completed", { artifacts: report(`done: ${prompt}`) }));
    }
  };
  const lookup = (id: string): Json => {
    const word = tasks.get(id);
    const n = (polls.get(id) ?? 0) + 1;
    polls.set(id, n);
    if (word === "hang") return task(id, cancelled.includes(id) ? "canceled" : "working");
    if (n < 2) return task(id, "working");
    return task(id, "completed", { artifacts: report(`finally: ${word}`) });
  };

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => void handle(req, res, raw));
  });

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const stream = async (res: ServerResponse, prompt: string, envelope: (payload: Json) => Json): Promise<void> => {
    const id = `task-${++counter}`;
    const word = prompt.trim().split(/\s+/)[0]!;
    tasks.set(id, word);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (payload: Json): void => void res.write(`data: ${JSON.stringify(envelope(payload))}\n\n`);
    const status = (name: string): Json =>
      v1
        ? { statusUpdate: { taskId: id, contextId: "ctx-1", status: { state: state(name) } } }
        : { kind: "status-update", taskId: id, contextId: "ctx-1", status: { state: state(name) }, final: name === "completed" };
    const chunk = (text: string, append: boolean): Json => {
      const event = { taskId: id, contextId: "ctx-1", artifact: { artifactId: "a1", name: "report", parts: [part(text)] }, append };
      return v1 ? { artifactUpdate: event } : { kind: "artifact-update", ...event };
    };
    emit(wrapTask(task(id, "working")));
    if (word === "hang") return; // stays open until the client hangs up
    if (word === "drop") return void res.end(); // the stream closes before the task ends
    emit(chunk("streamed ", false));
    await new Promise((r) => setTimeout(r, 10));
    emit(chunk("in two parts", true));
    emit(status("completed"));
    res.end();
  };

  async function handle(req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const base = `http://${options.endpointHost ?? "127.0.0.1"}:${(server.address() as AddressInfo).port}`;
    if (req.method === "GET" && path === (options.cardPath ?? "/.well-known/agent-card.json")) {
      const binding = options.binding ?? "JSONRPC";
      const common = {
        name: "Fake Researcher",
        description: "Answers anything, for tests.",
        version: "2.1.0",
        capabilities: { streaming: options.streaming === true },
        skills: [{ id: "research", name: "Research", description: "Looks things up", tags: ["search"] }],
        ...(options.security
          ? { securitySchemes: v1 ? { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } } : { bearer: { type: "http", scheme: "bearer" } } }
          : {}),
      };
      return json(
        res,
        200,
        v1
          ? { ...common, supportedInterfaces: [{ url: `${base}${binding === "JSONRPC" ? "/rpc" : "/rest"}`, protocolBinding: binding, protocolVersion: "1.0" }] }
          : { ...common, protocolVersion: "0.3.0", url: `${base}/rpc`, preferredTransport: "JSONRPC" },
      );
    }
    if (options.token && req.headers["authorization"] !== `Bearer ${options.token}`) {
      res.writeHead(401, { "www-authenticate": "Basic" });
      return void res.end(`bad credentials: ${String(req.headers["authorization"] ?? "")}`);
    }

    if (path === "/rpc" && req.method === "POST") {
      const message = JSON.parse(raw) as { id: number; method: string; params: Json };
      seen.push({ method: message.method, headers: req.headers, params: message.params });
      const ok = (result: unknown): void => json(res, 200, { jsonrpc: "2.0", id: message.id, result });
      const names = v1
        ? { send: "SendMessage", stream: "SendStreamingMessage", get: "GetTask", cancel: "CancelTask" }
        : { send: "message/send", stream: "message/stream", get: "tasks/get", cancel: "tasks/cancel" };
      const prompt = message.params?.["message"] ? textOf(message.params["message"] as Json) : "";
      if (message.method === names.send) return ok(start(prompt));
      if (message.method === names.stream) {
        if (prompt.startsWith("nostream")) return json(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32004, message: "Streaming is not supported" } });
        return stream(res, prompt, (payload) => ({ jsonrpc: "2.0", id: message.id, result: payload }));
      }
      if (message.method === names.get) return ok(lookup(String(message.params["id"])));
      if (message.method === names.cancel) {
        cancelled.push(String(message.params["id"]));
        return ok(task(String(message.params["id"]), "canceled"));
      }
      return json(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }

    if (path.startsWith("/rest")) {
      const rest = path.slice("/rest".length);
      seen.push({ method: `${req.method} ${rest}`, headers: req.headers, ...(raw ? { params: JSON.parse(raw) as Json } : {}) });
      if (rest === "/message:send") return json(res, 200, start(textOf((JSON.parse(raw) as { message: Json }).message)));
      if (rest === "/message:stream") return stream(res, textOf((JSON.parse(raw) as { message: Json }).message), (payload) => payload);
      const cancel = /^\/tasks\/([^/:]+):cancel$/.exec(rest);
      if (cancel) {
        cancelled.push(cancel[1]!);
        return json(res, 200, task(cancel[1]!, "canceled"));
      }
      const get = /^\/tasks\/([^/:]+)$/.exec(rest);
      if (get && req.method === "GET") return json(res, 200, lookup(get[1]!));
    }
    res.writeHead(404);
    res.end("not found");
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    cancelled,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const spec = (url: string, extra: Partial<A2aAgentSpec> = {}): A2aAgentSpec => ({ protocol: "a2a", url, pollMs: 50, ...extra });
const send = (agent: A2aAgentSpec, prompt: string, extra: Partial<AgentRequest> = {}) =>
  sendA2a("research", agent, { name: "research", agent, prompt, signal: new AbortController().signal, ...extra });

// ── 1 · the card: discovery, both generations, and when it is not there ─────
{
  const v1 = await fake({ streaming: true, security: true });
  const card = await agentCard("research", spec(v1.url));
  assert.equal(card.name, "Fake Researcher");
  assert.equal(card.version, "2.1.0");
  assert.equal(card.streaming, true);
  assert.deepEqual(card.interfaces, [{ url: `${v1.url}/rpc`, binding: "JSONRPC", version: "1.0" }]);
  assert.deepEqual(card.skills, [{ id: "research", name: "Research", description: "Looks things up", tags: ["search"] }]);
  assert.deepEqual(card.security, [{ name: "bearer", type: "httpAuth" }]);
  await v1.close();

  const old = await fake({ dialect: "0.3", security: true });
  const legacy = await agentCard("research", spec(old.url));
  assert.deepEqual(legacy.interfaces, [{ url: `${old.url}/rpc`, binding: "JSONRPC", version: "0.3.0" }], "a 0.3 card's url and preferredTransport read as one interface");
  assert.deepEqual(legacy.security, [{ name: "bearer", type: "http" }]);
  await old.close();

  const elsewhere = await fake({ cardPath: "/.well-known/agent.json" });
  assert.equal((await agentCard("research", spec(elsewhere.url))).name, "Fake Researcher", "the legacy well-known name is tried too");
  await assert.rejects(
    () => agentCard("research", spec(`${elsewhere.url}/nothing-here.json`)),
    /agent "research": no Agent Card found — tried http:\/\/127\.0\.0\.1:\d+\/nothing-here\.json \(HTTP 404\)\. An A2A agent publishes one at \/\.well-known\/agent-card\.json; set card: "<url>"/,
  );
  await elsewhere.close();

  assert.equal(taskState("TASK_STATE_INPUT_REQUIRED"), "input-required");
  assert.equal(taskState("input-required"), "input-required");
}
console.log("ok · 1 agent card discovery: v1.0 and 0.3 shapes, the legacy path, and a clear miss");

// ── 2 · send, and a task that is already done ───────────────────────────────
{
  const agent = await fake();
  const reply = await send(spec(agent.url), "summarise the launch");
  assert.equal(reply.text, "done: summarise the launch");
  assert.equal(reply.status, "completed");
  assert.deepEqual(reply.data, { score: 7 }, "a data part is the structured output");
  assert.deepEqual(reply.artifacts, [{ id: "a1", name: "report", text: "done: summarise the launch", data: [{ score: 7 }] }]);
  assert.equal(reply.cost, undefined, "A2A reports no cost, so none is invented");
  assert.deepEqual(reply.meta, { name: "Fake Researcher", version: "2.1.0", a2a: "1.0", binding: "JSONRPC", taskId: "task-1", contextId: "ctx-1", streamed: false });

  const sent = agent.seen[0]!;
  assert.equal(sent.method, "SendMessage");
  assert.equal(sent.headers["a2a-version"], "1.0", "every request names the protocol version");
  const message = sent.params!["message"] as Json;
  assert.equal(message["role"], "ROLE_USER");
  assert.deepEqual(message["parts"], [{ text: "summarise the launch" }]);
  assert.match(String(message["messageId"]), /^[0-9a-f-]{36}$/);

  const direct = await send(spec(agent.url), "message please");
  assert.equal(direct.text, "just a message", "an agent may answer with a message and no task");
  assert.equal(direct.status, "completed");
  await agent.close();
}
console.log("ok · 2 SendMessage: a completed task's artifacts, a bare message, and the v1.0 wire shape");

// ── 3 · polling, when the card offers no streaming ──────────────────────────
{
  const agent = await fake();
  const reply = await send(spec(agent.url), "slow report");
  assert.equal(reply.text, "finally: slow");
  assert.deepEqual(agent.seen.map((r) => r.method), ["SendMessage", "GetTask", "GetTask"], "asked again until the task ended");
  assert.equal(agent.seen[1]!.params!["id"], "task-1");
  assert.equal(reply.meta["streamed"], false);
  await agent.close();
}
console.log("ok · 3 a working task is polled with GetTask until it reaches a terminal state");

// ── 4 · streaming, when the card offers it ──────────────────────────────────
{
  const agent = await fake({ streaming: true });
  const reply = await send(spec(agent.url), "write it");
  assert.equal(reply.text, "streamed in two parts", "artifact chunks append");
  assert.equal(reply.meta["streamed"], true);
  assert.deepEqual(agent.seen.map((r) => r.method), ["SendStreamingMessage"]);
  assert.match(String(agent.seen[0]!.headers["accept"]), /text\/event-stream/);

  const dropped = await send(spec(agent.url), "drop the line");
  assert.equal(dropped.text, "finally: drop", "a stream that closes early falls back to polling");
  assert.deepEqual(agent.seen.slice(1).map((r) => r.method), ["SendStreamingMessage", "GetTask", "GetTask"]);

  agent.seen.length = 0;
  const refused = await send(spec(agent.url), "nostream after all");
  assert.equal(refused.text, "done: nostream after all", "a card that promised streaming and refused it is sent to plainly");
  assert.deepEqual(agent.seen.map((r) => r.method), ["SendStreamingMessage", "SendMessage"]);

  agent.seen.length = 0;
  await send(spec(agent.url, { streaming: false }), "plain");
  assert.deepEqual(agent.seen.map((r) => r.method), ["SendMessage"], "streaming: false never streams");
  await agent.close();
}
console.log("ok · 4 SendStreamingMessage over SSE: chunks, an early close, a refusal, and the opt-out");

// ── 5 · the 0.3 dialect, chosen from the card ───────────────────────────────
{
  const agent = await fake({ dialect: "0.3", streaming: true });
  const reply = await send(spec(agent.url), "legacy");
  assert.equal(reply.text, "streamed in two parts");
  assert.equal(reply.meta["a2a"], "0.3");
  assert.equal(agent.seen[0]!.method, "message/stream");
  assert.equal(agent.seen[0]!.headers["a2a-version"], undefined, "0.3 is assumed for an empty header");
  assert.deepEqual((agent.seen[0]!.params!["message"] as Json)["parts"], [{ kind: "text", text: "legacy" }]);
  assert.equal((agent.seen[0]!.params!["message"] as Json)["role"], "user");

  const polled = await send(spec(agent.url, { streaming: false }), "slow");
  assert.equal(polled.text, "finally: slow");
  assert.deepEqual(agent.seen.slice(1).map((r) => r.method), ["message/send", "tasks/get", "tasks/get"]);
  await agent.close();
}
console.log("ok · 5 a 0.3 card is spoken to in 0.3: message/send, tasks/get, kind-tagged parts, lowercase states");

// ── 6 · the HTTP+JSON binding; gRPC is refused by name ──────────────────────
{
  const agent = await fake({ binding: "HTTP+JSON", streaming: true });
  const reply = await send(spec(agent.url), "over rest");
  assert.equal(reply.text, "streamed in two parts");
  assert.equal(reply.meta["binding"], "HTTP+JSON");
  assert.deepEqual(agent.seen.map((r) => r.method), ["POST /message:stream"]);
  assert.equal(agent.seen[0]!.headers["content-type"], "application/a2a+json");
  const polled = await send(spec(agent.url, { streaming: false }), "slow");
  assert.equal(polled.text, "finally: slow");
  assert.deepEqual(agent.seen.slice(1).map((r) => r.method), ["POST /message:send", "GET /tasks/task-2", "GET /tasks/task-2"]);
  await agent.close();

  const grpc = await fake({ binding: "GRPC" });
  await assert.rejects(() => send(spec(grpc.url), "x"), /its card offers GRPC, and this client speaks JSONRPC and HTTP\+JSON — ask the agent's owner to enable the JSON-RPC binding/);
  await grpc.close();
}
console.log("ok · 6 HTTP+JSON works end to end; a gRPC-only card fails with the fix");

// ── 7 · input-required and auth-required end the step, by name ──────────────
{
  const agent = await fake();
  await assert.rejects(() => send(spec(agent.url), "ask me"), (error: AgentError) => {
    assert.ok(error instanceof AgentError);
    assert.match(error.message, /agent "research": the task stopped at input-required: Which city\? — the agent is asking a question, and nothing inside a run can answer it \(the task was cancelled\)\. Put what it needs in the node's prompt or reads, or ask a person first with a by: "human" node/);
    assert.equal(error.partial?.status, "input-required");
    return true;
  });
  assert.deepEqual(agent.cancelled, ["task-1"], "a task left waiting is cancelled rather than abandoned");
  await assert.rejects(() => send(spec(agent.url), "authreq"), /stopped at auth-required: Sign in to the calendar — the agent needs a credential it was not given \(the task was cancelled\)\. Authorise it out of band, or add auth to agents\.research/);
  await assert.rejects(() => send(spec(agent.url), "fail"), /agent "research": the task ended failed: the upstream search is down/);
  await agent.close();
}
console.log("ok · 7 input-required, auth-required and failed each fail the step and say what to change");

// ── 8 · abort and timeout cancel the task ───────────────────────────────────
{
  const agent = await fake();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 120);
  const one = spec(agent.url);
  await assert.rejects(
    () => sendA2a("research", one, { name: "research", agent: one, prompt: "hang", signal: controller.signal }),
    /agent "research": was aborted \(task task-1 cancelled\)/,
  );
  assert.deepEqual(agent.cancelled, ["task-1"], "CancelTask was sent");
  assert.equal(agent.seen.at(-1)!.method, "CancelTask");

  await assert.rejects(() => send(spec(agent.url, { timeoutMs: 150 }), "hang"), /did not finish within 150ms — raise timeoutMs on the agent if it needs longer \(task task-2 cancelled\)/);
  await agent.close();

  const streaming = await fake({ streaming: true });
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 120);
  const two = spec(streaming.url);
  await assert.rejects(() => sendA2a("research", two, { name: "research", agent: two, prompt: "hang", signal: abort.signal }), /was aborted \(task task-1 cancelled\)/);
  assert.deepEqual(streaming.cancelled, ["task-1"], "an open stream is hung up on, then the task is cancelled");
  await streaming.close();
}
console.log("ok · 8 signal and timeoutMs abort the call and send CancelTask, streaming or polling");

// ── 9 · auth: the same modes and ${NAME} secrets as remote MCP ──────────────
{
  const agent = await fake({ token: "tok-very-secret-123" });
  const secrets: Record<string, string> = { RESEARCH_TOKEN: "tok-very-secret-123" };
  const withAuth = spec(agent.url, { auth: { type: "bearer", token: "${RESEARCH_TOKEN}" } });
  const reply = await send(withAuth, "authorised", { secretResolver: (name) => secrets[name] });
  assert.equal(reply.text, "done: authorised");
  assert.equal(agent.seen[0]!.headers["authorization"], "Bearer tok-very-secret-123");

  await assert.rejects(() => send(withAuth, "x", { secretResolver: () => undefined }), /agent "research": needs RESEARCH_TOKEN, which is not set/);
  await assert.rejects(
    () => send(withAuth, "x", { secretResolver: () => "tok-wrong-secret-999" }),
    (error: Error) => {
      assert.match(error.message, /agent "research": .*the server rejected the bearer token \(HTTP 401\)/);
      assert.ok(!error.message.includes("tok-wrong-secret-999"), "a secret never reaches an error");
      return true;
    },
  );
  await assert.rejects(() => send(spec(agent.url), "x"), /the server wants credentials \(HTTP 401, Basic\) — add auth to its spec/);

  const headers = spec(agent.url, { headers: { authorization: "Bearer ${RESEARCH_TOKEN}" } });
  assert.equal((await send(headers, "via header", { secretResolver: (name) => secrets[name] })).text, "done: via header");
  await agent.close();

  // A card that points at another origin does not get the credentials on its say-so.
  const elsewhere = await fake({ endpointHost: "localhost" });
  const guarded = spec(elsewhere.url, { auth: { type: "bearer", token: "${RESEARCH_TOKEN}" } });
  await assert.rejects(
    () => send(guarded, "x", { secretResolver: (name) => secrets[name] }),
    /its card sends requests to http:\/\/localhost:\d+\/rpc, a different origin from http:\/\/127\.0\.0\.1:\d+ — credentials are not forwarded there on a card's say-so\. If that address is right, set endpoint:/,
  );
  assert.equal((await send(spec(elsewhere.url), "no credentials, so fine")).status, "completed");
  assert.equal((await send({ ...guarded, endpoint: `${elsewhere.url}/rpc` }, "explicit", { secretResolver: (name) => secrets[name] })).text, "done: explicit");
  await elsewhere.close();
}
console.log("ok · 9 bearer and header auth from ${NAME}; a missing or wrong secret is named and never printed; no cross-origin forwarding");

// ── 10 · as a node: validate, graph.json, run.json ──────────────────────────
{
  const agent = await fake({ streaming: true });
  const flow = runner({
    name: "a2a-node",
    inputs: ["goal", "brief"],
    agents: { research: spec(`${agent.url}/?key=should-not-appear`, { auth: { type: "bearer", token: "${RESEARCH_TOKEN}" } }) },
    nodes: {
      ask: { agent: "research", reads: ["goal", "brief"], writes: ["findings", "detail"], label: "Ask the researcher" },
    },
    entry: "ask",
    result: "findings",
  });
  assert.deepEqual(flow.validate(), []);
  const graph = flow.graph();
  assert.equal(graph.version, 1);
  assert.deepEqual(graph.nodes[0], {
    id: "ask",
    kind: "agent",
    label: "Ask the researcher",
    cost: "metered",
    reads: ["goal", "brief"],
    writes: ["findings", "detail"],
    agent: {
      name: "research",
      protocol: "a2a",
      url: agent.url,
      auth: "bearer",
      prompt: { reads: ["goal", "brief"] },
    },
  });
  assert.ok(!JSON.stringify(graph).includes("should-not-appear"), "a query string never reaches graph.json");

  const outcome = await flow({ goal: "find the date", brief: "launch notes" }, { secretResolver: () => "tok-node-secret-456" });
  assert.equal(outcome.result, "streamed in two parts");
  const step = outcome.run.steps[0]!;
  assert.equal(step.kind, "agent");
  assert.equal(step.handler, "research");
  assert.deepEqual(step.asked, { goal: "find the date", brief: "launch notes" });
  assert.equal(step.cost, 0);
  assert.deepEqual(step.meta, {
    agent: "research",
    protocol: "a2a",
    at: agent.url,
    prompt: "goal:\nfind the date\n\nbrief:\nlaunch notes",
    cost: "unknown",
    status: "completed",
    served: { name: "Fake Researcher", version: "2.1.0", a2a: "1.0", binding: "JSONRPC", taskId: "task-1", contextId: "ctx-1", streamed: true },
    artifacts: [{ id: "a1", name: "report" }],
  });
  assert.deepEqual(step.writes, {
    findings: "streamed in two parts",
    detail: { status: "completed", artifacts: [{ id: "a1", name: "report", text: "streamed in two parts" }], toolCalls: [], permissions: [] },
  });
  assert.ok(!JSON.stringify(outcome.run).includes("tok-node-secret-456"), "no secret in run.json");
  assert.ok(!JSON.stringify(outcome.run).includes("should-not-appear"));

  // A failing agent fails the run, and the step keeps who was asked what.
  const failing = runner({
    name: "a2a-fail",
    inputs: ["goal"],
    agents: { research: spec(agent.url, { streaming: false }) },
    nodes: { ask: { agent: "research", prompt: "ask me something", writes: ["findings"] } },
    entry: "ask",
  });
  await assert.rejects(() => failing({ goal: "x" }), (error: RunFailed) => {
    assert.ok(error instanceof RunFailed);
    const failed = error.run.steps[0]!;
    assert.match(failed.error!, /stopped at input-required/);
    assert.equal(failed.meta!["status"], "input-required");
    assert.equal(failed.meta!["prompt"], "ask me something");
    assert.equal(error.run.run.status, "failed");
    return true;
  });

  // preflight reads the card and names the secret.
  const flight = await preflight(flow.spec, { env: {} });
  assert.deepEqual(flight.env, [{ name: "RESEARCH_TOKEN", why: 'agent "research"', set: false }]);
  assert.ok(flight.problems.includes('RESEARCH_TOKEN is not set — needed by agent "research"'));
  const ready = await preflight(flow.spec, { env: { RESEARCH_TOKEN: "tok-node-secret-456" } });
  assert.deepEqual(ready.problems, []);
  assert.ok(
    ready.notes.some((note) => note.includes('delegates to agent "research" — "Fake Researcher" 2.1.0') && note.includes("(A2A 1.0, JSONRPC, streaming, auth: bearer)")),
    ready.notes.join("\n"),
  );
  assert.ok(ready.notes.includes('agent "research" offers: Research'));
  await agent.close();

  const gone = await preflight(flow.spec, { env: { RESEARCH_TOKEN: "t-0000" } });
  assert.ok(gone.problems.some((problem) => /agent "research": could not reach/.test(problem)), gone.problems.join("\n"));
}
console.log("ok · 10 an a2a agent node: exact graph.json and run.json shapes, no secret in either, and preflight reads the card");

console.log("10 cases");
