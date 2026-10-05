// A runner served as an A2A agent (src/a2a-serve.ts), against the library's own
// A2A client and against the wire: the card, a streamed run with one update per
// node, a pause the caller answers, an answer that does not fit, cancel, a
// token, a budget, and the handler mounted the way a framework would mount it.
// No decider is called: the only decide node asks a person, and the caller is that person.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { a2aAgent, serveRunner, type ServeOptions } from "../src/a2a-serve.ts";
import { AgentError, agentCard, choice, noul, runner, sendA2a, type A2aAgentSpec } from "../src/index.ts";

type Json = Record<string, any>;

const seen = { aborted: 0 };

/** Draft, then (when asked to) wait for approval, then pay or decline. `slow` hangs until cancelled. */
const refunds = runner({
  name: "refunds",
  description: "Drafts a refund and settles it.",
  inputs: ["goal", "amount"],
  work: {
    draft: ({ goal, state }) => `refund for ${goal}${state["amount"] !== undefined ? ` (${state["amount"]})` : ""}`,
    pay: ({ state }) => `paid: ${state["draft"]}`,
    decline: ({ state }) => `declined: ${state["draft"]}`,
    slow: ({ signal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => (seen.aborted++, reject(new Error("stopped"))), { once: true })),
    spend: ({ report }) => (report({ cost: 0.4 }), "spent"),
  },
  nodes: {
    write: { work: "draft", reads: ["amount"], writes: ["draft"] },
    wait: { work: "slow", writes: ["waited"] },
    burn: { work: "spend", writes: ["burnt"] },
    burn_again: { work: "spend", writes: ["burnt"] },
    approve: {
      decide: { ok: noul("Should this refund be issued as drafted?"), tier: choice("Which approval tier applies?", { standard: null, senior: null }) },
      reads: ["goal", "draft"],
      by: "human",
    },
    pay_it: { work: "pay", writes: ["outcome"] },
    say_no: { work: "decline", writes: ["outcome"] },
  },
  edges: [
    { from: "write", to: "wait", when: ({ goal }) => String(goal).startsWith("hang") },
    { from: "write", to: "burn", when: ({ goal }) => String(goal).startsWith("spend") },
    { from: "write", to: "approve", when: ({ goal }) => String(goal).startsWith("ask") },
    { from: "write", to: "pay_it" },
    { from: "burn", to: "burn_again" },
    { from: "burn_again", to: "pay_it" },
    { from: "wait", to: "pay_it" },
    { from: "approve", to: "pay_it", on: "ok" },
    { from: "approve", to: "say_no" },
  ],
  entry: "write",
  result: "outcome",
});
assert.deepEqual(refunds.validate(), [], "the fixture is a sound runner");

const serve = (options: ServeOptions = {}) => serveRunner(refunds, { port: 0, ...options });
const spec = (url: string, extra: Partial<A2aAgentSpec> = {}): A2aAgentSpec => ({ protocol: "a2a", url, ...extra });
const ask = (agent: A2aAgentSpec, prompt: string, signal = new AbortController().signal) => sendA2a("refunds", agent, { name: "refunds", agent, prompt, signal });

let rpcId = 0;
async function rpc(url: string, method: string, params: Json, headers: Record<string, string> = {}): Promise<Json> {
  const response = await fetch(`${url}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return (await response.json()) as Json;
}
const text = (goal: string, extra: Json = {}): Json => ({ message: { messageId: `m${++rpcId}`, role: "ROLE_USER", parts: [{ text: goal }], ...extra } });
const said = (task: Json): string => task.status.message?.parts?.[0]?.text ?? "";

// ── 1 · the card is the graph, read by the library's own client ────────────
{
  const served = await serve();
  const card = await agentCard("refunds", spec(served.url));
  assert.equal(card.name, "refunds");
  assert.equal(card.description, "Drafts a refund and settles it.");
  assert.equal(card.version, refunds.graph().runner.hash, "the version is the graph hash: a changed graph is a changed agent");
  assert.equal(card.streaming, true);
  assert.deepEqual(card.interfaces.map((face) => [face.binding, face.version]), [["JSONRPC", "1.0"]]);
  assert.match(card.skills[0]!.description, /inputs as a data part: amount/, "the card says what the runner takes");
  assert.match(card.skills[0]!.description, /input-required/, "and that it may ask");
  assert.deepEqual(card.security, []);
  await served.close();
}
console.log("ok · 1 the agent card is derived from graph.json");

// ── 2 · the library's client delegates to it, streaming, and gets the result ─
{
  const served = await serve();
  const reply = await ask(spec(served.url), "order A-104");
  assert.equal(reply.text, "paid: refund for order A-104");
  assert.equal(reply.status, "completed");
  assert.equal(reply.meta?.["streamed"], true);
  const plain = await ask(spec(served.url, { streaming: false }), "order A-105");
  assert.equal(plain.text, "paid: refund for order A-105", "and without streaming");
  await served.close();
}
console.log("ok · 2 sendA2a runs the runner and reads its result, streamed or not");

// ── 3 · the stream says where the run is: one update as each node starts and ends ─
{
  const served = await serve();
  const response = await fetch(`${served.url}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "SendStreamingMessage", params: text("order A-104") }),
  });
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = (await response.text())
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice(6)).result as Json);
  assert.ok(events[0]!.task.id, "the task comes first, so the caller can cancel it");
  const updates = events.filter((event) => event.statusUpdate).map((event) => event.statusUpdate as Json);
  const trail = updates.filter((update) => update.metadata?.ensemble?.event).map((update) => `${update.metadata.ensemble.event} ${update.metadata.ensemble.node}`);
  assert.deepEqual(trail, ["node:start write", "node:end write", "node:start pay_it", "node:end pay_it"]);
  const ended = updates.find((update) => update.metadata?.ensemble?.event === "node:end")!;
  assert.equal(typeof ended.metadata.ensemble.took, "string", "a finished node names the edge it took");
  const artifact = events.findIndex((event) => event.artifactUpdate);
  const last = events.length - 1;
  assert.ok(artifact !== -1 && artifact < last, "the artifact arrives before the terminal status");
  assert.equal(events[artifact]!.artifactUpdate.artifact.parts[0].text, "paid: refund for order A-104");
  const final = events[last]!.statusUpdate as Json;
  assert.equal(final.status.state, "TASK_STATE_COMPLETED");
  assert.deepEqual(final.metadata.ensemble.cost, { total: 0, currency: "USD" }, "the run's cost travels in metadata: A2A has no field for it");
  assert.equal(final.metadata.ensemble.steps, 2);
  await served.close();
}
console.log("ok · 3 a stream carries node:start / node:end as status updates, then the artifact, then the end");

// ── 4 · a pause is input-required; the caller answers and the same task finishes ─
{
  const served = await serve();
  const { result } = await rpc(served.url, "SendMessage", text("ask about A-104"));
  const task = result.task as Json;
  assert.equal(task.status.state, "TASK_STATE_INPUT_REQUIRED");
  assert.match(said(task), /"approve" is waiting[\s\S]*ok \(yes or no\)[\s\S]*tier \(one of: standard, senior\)/);
  assert.deepEqual(task.metadata.ensemble.pending.questions.map((q: Json) => q.key), ["ok", "tier"], "the closed questions, as data");
  assert.equal(task.metadata.ensemble.pending.asked.draft, "refund for ask about A-104", "and what the node read");

  // An answer outside the questions runs nothing: the task waits again and says why.
  const wrong = (await rpc(served.url, "SendMessage", text("ok=yes\ntier=platinum", { taskId: task.id }))).result.task as Json;
  assert.equal(wrong.status.state, "TASK_STATE_INPUT_REQUIRED");
  assert.match(said(wrong), /platinum/);
  assert.match(said(wrong), /tier \(one of: standard, senior\)/, "the questions are asked again");

  const right = (await rpc(served.url, "SendMessage", text("ok=no\ntier=senior", { taskId: task.id }))).result.task as Json;
  assert.equal(right.id, task.id, "one task, across the pause");
  assert.equal(right.status.state, "TASK_STATE_COMPLETED");
  assert.equal(right.artifacts[0].parts[0].text, "declined: refund for ask about A-104");
  assert.equal(right.metadata.ensemble.steps, 3, "one continuous run record");
  assert.deepEqual(right.history.filter((message: Json) => message.role === "ROLE_USER").map((message: Json) => message.parts[0].text), ["ask about A-104", "ok=yes\ntier=platinum", "ok=no\ntier=senior"], "the history keeps what the caller said, in order");
  assert.equal(right.history[right.history.length - 1].parts[1].data.node, "say_no");

  // As data, and for a task that is not waiting.
  const second = (await rpc(served.url, "SendMessage", text("ask about A-200"))).result.task as Json;
  const viaData = (await rpc(served.url, "SendMessage", { message: { role: "ROLE_USER", taskId: second.id, parts: [{ data: { answers: { ok: true, tier: "standard" } } }] } })).result.task as Json;
  assert.equal(viaData.artifacts[0].parts[0].text, "paid: refund for ask about A-200");
  const again = await rpc(served.url, "SendMessage", text("ok=yes", { taskId: second.id }));
  assert.equal(again.error.code, -32602);
  assert.match(again.error.message, /is not waiting for an answer/);
  await served.close();
}
console.log("ok · 4 a by: \"human\" pause is input-required, answered by the caller, refused when it does not fit");

// ── 5 · the library's own client cannot answer a question, and says so ──────
{
  const served = await serve();
  await assert.rejects(
    () => ask(spec(served.url), "ask about A-104"),
    (error: unknown) => error instanceof AgentError && /input-required/.test(error.message) && /the task was cancelled/.test(error.message),
  );
  await served.close();
}
console.log("ok · 5 a runner calling a pausing runner fails with the fix, and the task is cancelled");

// ── 6 · cancel reaches the handler's signal ────────────────────────────────
{
  const served = await serve();
  const started = (await rpc(served.url, "SendMessage", { ...text("hang on"), configuration: { returnImmediately: true } })).result.task as Json;
  assert.equal(started.status.state, "TASK_STATE_WORKING", "returnImmediately answers before the run ends");
  const polled = (await rpc(served.url, "GetTask", { id: started.id })).result as Json;
  assert.equal(polled.status.state, "TASK_STATE_WORKING");
  assert.deepEqual(polled.history.map((message: Json) => [message.role, message.parts[0].text]), [["ROLE_USER", "hang on"], ["ROLE_AGENT", "write took e0"]], "a caller that polls sees the steps so far");
  assert.equal(polled.history[1].parts[1].data.node, "write");
  assert.equal((await rpc(served.url, "GetTask", { id: started.id, historyLength: 1 })).result.history.length, 1);
  assert.equal((await rpc(served.url, "GetTask", { id: started.id, historyLength: 0 })).result.history.length, 0);
  const cancelled = (await rpc(served.url, "CancelTask", { id: started.id })).result as Json;
  assert.equal(cancelled.status.state, "TASK_STATE_CANCELED");
  assert.equal(seen.aborted, 1, "the handler was told to stop");
  assert.equal((await rpc(served.url, "CancelTask", { id: started.id })).error.code, -32002, "a finished task cannot be cancelled");
  assert.equal((await rpc(served.url, "GetTask", { id: "nope" })).error.code, -32001);

  // The library's client cancels the same way when its own run is aborted.
  const controller = new AbortController();
  const call = ask(spec(served.url), "hang again", controller.signal);
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(() => call, /was aborted \(task .* cancelled\)/);
  assert.equal(seen.aborted, 2);

  // A paused task holds nothing running: cancelling drops its snapshot.
  const waiting = (await rpc(served.url, "SendMessage", text("ask about A-300"))).result.task as Json;
  assert.equal((await rpc(served.url, "CancelTask", { id: waiting.id })).result.status.state, "TASK_STATE_CANCELED");
  assert.match((await rpc(served.url, "SendMessage", text("ok=yes\ntier=senior", { taskId: waiting.id }))).error.message, /not waiting/);
  await served.close();
}
console.log("ok · 6 CancelTask aborts the run, from the wire and from the library's client");

// ── 7 · inputs, a token, and a budget the caller can lower but not raise ────
{
  const served = await serve({ token: "s3cret", budget: 0.5 });
  const card = (await (await fetch(`${served.url}/.well-known/agent-card.json`)).json()) as Json;
  assert.ok(card.securitySchemes.bearer, "the card declares the token");
  const refused = await fetch(`${served.url}/a2a`, { method: "POST", body: "{}" });
  assert.equal(refused.status, 401);
  const auth = { authorization: "Bearer s3cret" };

  const withInputs = (await rpc(served.url, "SendMessage", { message: { role: "ROLE_USER", parts: [{ text: "order A-9" }, { data: { amount: 40 } }] } }, auth)).result.task as Json;
  assert.equal(withInputs.artifacts[0].parts[0].text, "paid: refund for order A-9 (40)", "a data part lands as inputs");

  // Two steps of $0.40 against a $0.50 cap: the run stops at its budget.
  const capped = (await rpc(served.url, "SendMessage", text("spend it"), auth)).result.task as Json;
  assert.equal(capped.status.state, "TASK_STATE_FAILED");
  assert.match(said(capped), /stopped at its budget/);
  assert.equal(capped.metadata.ensemble.status, "budget");
  const lower = (await rpc(served.url, "SendMessage", { ...text("spend it"), metadata: { budget: 0.1 } }, auth)).result.task as Json;
  assert.ok(lower.metadata.ensemble.cost.total < capped.metadata.ensemble.cost.total, "the caller's lower cap stops it sooner");
  const higher = (await rpc(served.url, "SendMessage", { ...text("spend it"), metadata: { budget: 50 } }, auth)).result.task as Json;
  assert.equal(higher.metadata.ensemble.status, "budget", "a higher cap than the server's is not honoured");

  const old = await rpc(served.url, "SendMessage", text("order"), { ...auth, "a2a-version": "0.3" });
  assert.equal(old.error.code, -32009);
  await served.close();

  const broken = runner({ name: "broken", work: {}, nodes: { a: { work: "missing" } }, edges: [], entry: "a" });
  assert.throws(() => a2aAgent(broken), /does not validate, so it is not served/);
}
console.log("ok · 7 a data part is inputs, a token is required, and the budget passes down");

// ── 8 · the handler mounts under a path, behind a body parser, like in Express ─
{
  const agent = a2aAgent(refunds);
  const server = createServer((req, res) => {
    if (!req.url?.startsWith("/agents/refunds")) return void res.writeHead(404).end();
    // What `app.use("/agents/refunds", express.json(), agent.handler)` hands a handler.
    Object.assign(req, { baseUrl: "/agents/refunds" });
    req.url = req.url.slice("/agents/refunds".length) || "/";
    if (req.method !== "POST") return agent.handler(req, res);
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => agent.handler(Object.assign(req, { body: JSON.parse(raw) }), res));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agents/refunds`;
  const card = await agentCard("refunds", spec(url));
  assert.equal(card.interfaces[0]!.url, `${url}/a2a`, "the card names the mounted address");
  assert.equal((await ask(spec(url), "order A-104")).text, "paid: refund for order A-104");
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}
console.log("ok · 8 the handler works mounted under a path with the body already parsed");

console.log("8 cases");
