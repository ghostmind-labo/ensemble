// Runners served as MCP tools (src/mcp-serve.ts), against the library's own MCP
// client (which opens with `initialize`) and against the wire in the current
// revision (2026-07-28: no handshake, metadata on every request): discovery,
// header validation, progress, a pause answered through a form and through the
// `answer` tool, cancel on both transports, a budget, a clean shutdown, and
// the tools that watch and steer a run.
// No decider is called: the only decide node asks a person.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { mcpTools, LEGACY_VERSIONS, MODERN_VERSIONS, type ToolsOptions } from "../src/mcp-serve.ts";
import { connect, runner } from "../src/index.ts";
import refunds, { seen } from "./fixtures/refunds.mts";

type Json = Record<string, any>;

/** The adapter is a handler, not a server: this is the few lines of server a host supplies. */
async function serve(options: ToolsOptions = {}) {
  const tools = mcpTools([refunds], { secret: "test", ...options });
  const server = createServer((req, res) => (new URL(req.url ?? "/", "http://local").pathname === "/mcp" ? tools.handler(req, res) : void res.writeHead(404).end()));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const stop = (): Promise<void> =>
    new Promise((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    tools,
    drain: async (graceMs?: number) => (await tools.drain(graceMs), await new Promise((done) => setTimeout(done, 50)), await stop()),
    close: async () => (tools.close(), await stop()),
  };
}
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" } };
const meta = (capabilities: Json = {}, extra: Json = {}): Json => ({ ...META, "io.modelcontextprotocol/clientCapabilities": capabilities, ...extra });

let nextId = 0;
/** One request in the current revision, with the headers it must mirror. */
async function modern(url: string, method: string, params: Json = {}, options: { capabilities?: Json; headers?: Record<string, string>; meta?: Json } = {}): Promise<{ status: number; body: Json }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(params["name"] ? { "mcp-name": String(params["name"]) } : {}),
      ...options.headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params: { ...params, _meta: options.meta ?? meta(options.capabilities) } }),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? (JSON.parse(raw) as Json) : {} };
}
const call = (url: string, name: string, args: Json, extra: Json = {}, capabilities?: Json) =>
  modern(url, "tools/call", { name, arguments: args, ...extra }, capabilities ? { capabilities } : {});

// ── 1 · the library's own client, over stdio: a child process, the old handshake ─
{
  const session = await connect("refunds", { command: process.execPath, args: ["src/cli.ts", "serve", "mcp", "test/fixtures/refunds.mts"] });
  const tools = await session.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["refunds", "start_run", "get_run", "list_runs", "cancel_run", "answer"], "one tool per runner, the tools that watch and steer, and `answer` because it can pause");
  assert.match(tools[0]!.description, /Drafts a refund and settles it\./);
  assert.deepEqual(Object.keys((tools[0]!.inputSchema as Json).properties), ["goal", "amount"], "the runner's inputs are the arguments");
  const result = await session.call("refunds", { goal: "order A-104", amount: 40 });
  assert.equal(result.text, "paid: refund for order A-104 (40)");
  assert.equal(result.isError, false);
  const data = result.data as Json;
  assert.equal(data.status, "completed");
  assert.deepEqual(data.run.steps.map((step: Json) => step.node), ["write", "pay_it"], "the path taken comes back with the result");
  assert.deepEqual(data.run.cost, { total: 0, currency: "USD" });
  session.close();
}
console.log("ok · 1 the library's stdio client lists the runner as a tool and calls it");

// ── 2 · the library's own client, over Streamable HTTP ─────────────────────
{
  const served = await serve();
  const session = await connect("refunds", { url: served.url });
  assert.equal((await session.call("refunds", { goal: "order A-105" })).text, "paid: refund for order A-105");
  const failed = await session.call("refunds", { goal: "spend it" });
  assert.equal(failed.isError, false, "no budget set: two paid steps complete");
  session.close();
  await served.close();
}
console.log("ok · 2 and over HTTP, with the handshake-based revision");

// ── 3 · the current revision: no handshake, discovery, and every refusal it specifies ─
{
  const served = await serve();
  const discovered = await modern(served.url, "server/discover");
  assert.equal(discovered.status, 200);
  assert.deepEqual(discovered.body.result.supportedVersions, [...MODERN_VERSIONS, ...LEGACY_VERSIONS]);
  assert.equal(discovered.body.result.resultType, "complete");
  assert.deepEqual(discovered.body.result.capabilities, { tools: {} });
  assert.equal(discovered.body.result._meta["io.modelcontextprotocol/serverInfo"].name, "ensemble");

  const listed = await modern(served.url, "tools/list");
  assert.deepEqual(listed.body.result.tools.map((tool: Json) => tool.name), ["refunds", "answer"]);
  const done = await call(served.url, "refunds", { goal: "order A-1" });
  assert.equal(done.body.result.resultType, "complete");
  assert.equal(done.body.result.content[0].text, "paid: refund for order A-1");

  const noCapabilities = await modern(served.url, "tools/list", {}, { meta: META });
  assert.deepEqual([noCapabilities.status, noCapabilities.body.error.code], [400, -32602], "metadata is required on every request");
  const future = await modern(served.url, "tools/list", {}, { meta: { ...meta(), "io.modelcontextprotocol/protocolVersion": "2099-01-01" }, headers: { "mcp-protocol-version": "2099-01-01" } });
  assert.deepEqual([future.status, future.body.error.code, future.body.error.data.requested], [400, -32022, "2099-01-01"]);
  assert.ok(future.body.error.data.supported.includes("2026-07-28"));
  const mismatch = await modern(served.url, "tools/call", { name: "refunds", arguments: { goal: "x" } }, { headers: { "mcp-name": "other" } });
  assert.deepEqual([mismatch.status, mismatch.body.error.code], [400, -32020], "a header that disagrees with the body is refused");
  const encoded = await modern(served.url, "tools/call", { name: "refunds", arguments: { goal: "x" } }, { headers: { "mcp-name": `=?base64?${Buffer.from("refunds").toString("base64")}?=` } });
  assert.equal(encoded.status, 200, "an encoded name is decoded before it is compared");
  const unknownMethod = await modern(served.url, "resources/list");
  assert.deepEqual([unknownMethod.status, unknownMethod.body.error.code], [404, -32601]);
  const unknownTool = await call(served.url, "nope", {});
  assert.deepEqual([unknownTool.status, unknownTool.body.error.code], [400, -32602]);

  assert.equal((await fetch(served.url)).status, 405, "there is no GET stream in this revision");
  assert.equal((await fetch(served.url, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status, 403);
  assert.equal((await fetch(served.url.replace("/mcp", "/elsewhere"), { method: "POST", body: "{}" })).status, 404);
  await served.close();
}
console.log("ok · 3 the current revision: discover, list, call, and the specified refusals");

// ── 4 · progress: one notification as each node starts and ends, then the result ─
{
  const served = await serve();
  const response = await fetch(served.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "refunds" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "refunds", arguments: { goal: "order A-104" }, _meta: meta({}, { progressToken: "p1" }) } }),
  });
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = (await response.text()).split("\n\n").filter((block) => block.startsWith("data: ")).map((block) => JSON.parse(block.slice(6)) as Json);
  const notes = events.filter((event) => event.method === "notifications/progress");
  assert.deepEqual(notes.map((note) => note.params.progress), [1, 2, 3, 4], "progress only ever increases");
  assert.ok(notes.every((note) => note.params.progressToken === "p1"));
  assert.match(notes[1]!.params.message, /^write took e\d+$/, "a finished node names the edge it took");
  const last = events[events.length - 1]!;
  assert.equal(last.id, 40, "the response ends the stream");
  assert.equal(last.result.content[0].text, "paid: refund for order A-104");

  const plain = await call(served.url, "refunds", { goal: "order A-104" });
  assert.equal(plain.body.result.content[0].text, "paid: refund for order A-104", "without a progress token the answer is one JSON object");
  await served.close();
}
console.log("ok · 4 progress notifications stream on the request, and only when asked for");

// ── 5 · a pause, for a caller that can show a form: input_required, then the same call again ─
{
  const served = await serve();
  const form = { elicitation: { form: {} } };
  const asked = await call(served.url, "refunds", { goal: "ask about A-104" }, {}, form);
  const first = asked.body.result as Json;
  assert.equal(first.resultType, "input_required");
  const request = first.inputRequests.approve as Json;
  assert.equal(request.method, "elicitation/create");
  assert.equal(request.params.mode, "form");
  assert.deepEqual(request.params.requestedSchema.properties.ok.type, "boolean", "a noul is a boolean");
  assert.deepEqual(request.params.requestedSchema.properties.tier.enum, ["standard", "senior"], "a choice is an enum of its options");
  assert.equal(request.params.requestedSchema.properties.reason.type, "string", "the node's comment is an optional text field");
  assert.deepEqual(request.params.requestedSchema.required, ["ok", "tier"]);
  assert.ok(!Buffer.from(first.requestState, "base64url").toString("utf8").includes("refund"), "the paused run is encrypted: the caller cannot read the state");

  const retry = (responses: Json, state = first.requestState) => call(served.url, "refunds", { goal: "ask about A-104" }, { inputResponses: responses, requestState: state }, form);

  const wrong = (await retry({ approve: { action: "accept", content: { ok: true, tier: "platinum" } } })).body.result as Json;
  assert.equal(wrong.resultType, "input_required", "an answer that does not fit asks again");
  assert.match(wrong.inputRequests.approve.params.message, /platinum/);

  const answered = (await retry({ approve: { action: "accept", content: { ok: false, tier: "senior", reason: "too large" } } })).body.result as Json;
  assert.equal(answered.resultType, "complete");
  assert.equal(answered.content[0].text, "declined: refund for ask about A-104 — too large");
  assert.deepEqual(answered.structuredContent.run.steps.map((step: Json) => step.node), ["write", "approve", "say_no"], "one continuous record");
  assert.equal(answered.structuredContent.run.steps[1].answers.tier.value, "senior");

  const declined = (await retry({ approve: { action: "decline" } })).body.result as Json;
  assert.equal(declined.isError, true);
  assert.match(declined.content[0].text, /was not answered \(decline\)/);
  assert.equal((await retry({})).body.result.resultType, "input_required", "a retry without the answer is asked again");

  const tampered = await retry({ approve: { action: "accept", content: { ok: true, tier: "senior" } } }, `${first.requestState.slice(0, -4)}AAAA`);
  assert.deepEqual([tampered.status, tampered.body.error.code], [400, -32602]);
  assert.match(tampered.body.error.message, /cannot be resumed/);

  // Sealed by one instance, resumed by another holding the same secret; refused by one that does not.
  const other = await serve();
  const elsewhere = await call(other.url, "refunds", { goal: "ask about A-104" }, { inputResponses: { approve: { action: "accept", content: { ok: true, tier: "standard" } } }, requestState: first.requestState }, form);
  assert.equal(elsewhere.body.result.content[0].text, "paid: refund for ask about A-104", "nothing is remembered between requests");
  await other.close();
  const stranger = await serve({ secret: "another" });
  assert.equal((await call(stranger.url, "refunds", { goal: "x" }, { inputResponses: {}, requestState: first.requestState }, form)).body.error.code, -32602);
  await stranger.close();
  await served.close();
}
console.log("ok · 5 a by: \"human\" pause is an elicitation form, resumed statelessly from a sealed token");

// ── 6 · a pause, for a caller that cannot: words, a token, and the `answer` tool ─
{
  const served = await serve();
  const session = await connect("refunds", { url: served.url });
  const paused = await session.call("refunds", { goal: "ask about A-200" });
  assert.equal(paused.isError, false, "a pause is not a failure");
  assert.match(paused.text, /"approve" is waiting[\s\S]*ok \(true or false\)[\s\S]*tier \(one of: standard, senior\)[\s\S]*"answer" tool/);
  const data = paused.data as Json;
  assert.equal(data.status, "paused");
  assert.deepEqual(data.pending.questions.map((question: Json) => question.key), ["ok", "tier"]);

  const wrong = await session.call("answer", { resume: data.resume, answers: { ok: true } });
  assert.equal((wrong.data as Json).status, "paused", "an incomplete answer waits again");
  assert.match(wrong.text, /tier/);
  const right = await session.call("answer", { resume: data.resume, answers: { ok: true, tier: "standard" }, comment: "fine" });
  assert.equal(right.text, "paid: refund for ask about A-200");
  assert.equal((right.data as Json).run.steps.length, 3);
  await assert.rejects(() => session.call("answer", { resume: "garbage", answers: {} }), /cannot be resumed/);

  // The current revision without the elicitation capability gets the same fallback, never a form.
  const modernPause = (await call(served.url, "refunds", { goal: "ask about A-201" })).body.result as Json;
  assert.equal(modernPause.resultType, "complete");
  assert.equal(modernPause.structuredContent.status, "paused");
  session.close();
  await served.close();

  assert.deepEqual((await mcpTools([runner({ name: "plain", work: { a: () => 1 }, nodes: { a: { work: "a" } }, edges: [], entry: "a" })]).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { signal: new AbortController().signal })).body!["result"], {
    tools: [{ name: "plain", description: 'The ensemble runner "plain". Returns its result, and the path it took with each decision\'s answer and confidence.', inputSchema: { type: "object", properties: { goal: { type: "string", description: "What to do, in plain words." } }, required: ["goal"] } }],
  }, "no `answer` tool when nothing can pause");
}
console.log("ok · 6 a caller without forms answers through the `answer` tool");

// ── 7 · cancel: hanging up on HTTP, notifications/cancelled on stdio ────────
{
  const served = await serve();
  const before = seen.aborted;
  const controller = new AbortController();
  const hanging = call(served.url, "refunds", { goal: "hang on" }).catch(() => "aborted");
  void fetch(served.url, {
    method: "POST",
    signal: controller.signal,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "refunds" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 70, method: "tools/call", params: { name: "refunds", arguments: { goal: "hang too" }, _meta: meta() } }),
  }).catch(() => {});
  await new Promise((done) => setTimeout(done, 150));
  controller.abort();
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(seen.aborted, before + 1, "the caller hanging up stops that run, and only that one");
  await served.close();
  await hanging;
  assert.equal(seen.aborted, before + 2, "closing the server stops the rest");

  // stdio: one shared channel, so cancel is a notification, and nothing more is said about the request.
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Json[] = [];
  output.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json)));
  const tools = mcpTools([refunds]);
  const finished = tools.stdio(input, output);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "refunds", arguments: { goal: "hang three" }, _meta: meta({}, { progressToken: 9 }) } })}\n`);
  await new Promise((done) => setTimeout(done, 100));
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: meta() } })}\n`);
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(seen.aborted, before + 3);
  assert.ok(lines.some((line) => line.method === "notifications/progress" && line.params.progressToken === 9), "progress was sent while it ran");
  assert.deepEqual(lines.filter((line) => line.id !== undefined).map((line) => line.id), [2], "the cancelled request gets no response; the next one does");
  input.write("not json\n");
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(lines[lines.length - 1]!.error.code, -32700);
  input.end();
  await finished;
}
console.log("ok · 7 a run is cancelled by hanging up (HTTP) or by notifications/cancelled (stdio)");

// ── 8 · a budget, and what cannot be served ────────────────────────────────
{
  const served = await serve({ budget: 0.5 });
  const auth = {};
  const capped = (await modern(served.url, "tools/call", { name: "refunds", arguments: { goal: "spend it" } }, auth)).body.result as Json;
  assert.equal(capped.isError, true);
  assert.match(capped.content[0].text, /stopped at its budget/);
  assert.equal(capped.structuredContent.status, "budget");
  await served.close();

  const named = (name: string) => runner({ name, work: { a: () => 1 }, nodes: { a: { work: "a" } }, edges: [], entry: "a" });
  assert.throws(() => mcpTools([named("answer")]), /that name is the tool that answers a paused run/);
  assert.throws(() => mcpTools([named("has space")]), /cannot be a tool/);
  assert.throws(() => mcpTools([named("twin"), named("twin")]), /two runners are named "twin"/);
  assert.throws(() => mcpTools([runner({ name: "broken", work: {}, nodes: { a: { work: "missing" } }, edges: [], entry: "a" })]), /does not validate, so it is not served/);
  assert.deepEqual(Object.keys(mcpTools({ one: named("one"), two: named("two") })), ["handle", "handler", "stdio", "drain", "close"], "a record of runners works too");
}
console.log("ok · 8 the budget caps a call, and unservable runners are refused by name");

// ── 9 · a clean shutdown: no new calls, calls in flight return, and SIGTERM does the same ──
{
  const served = await serve();
  const slow = call(served.url, "refunds", { goal: "slow one" });
  await new Promise((done) => setTimeout(done, 60));
  const draining = served.drain(5_000);
  const refused = await fetch(served.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "refunds" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "refunds", arguments: { goal: "another" }, _meta: meta() } }),
  });
  assert.equal(refused.status, 503, "a new call is refused, so a load balancer sends it elsewhere");
  assert.equal(refused.headers.get("retry-after"), "1");
  assert.equal((await slow).body.result.content[0].text, "paid: refund for slow one", "the call in flight returned its result");
  await draining;

  // Past the grace period the call is stopped, and its result says so.
  const before = seen.aborted;
  const again = await serve();
  const stuck = call(again.url, "refunds", { goal: "hang forever" });
  await new Promise((done) => setTimeout(done, 60));
  await again.drain(80);
  assert.equal(seen.aborted, before + 1);
  const stopped = (await stuck).body.result as Json;
  assert.equal(stopped.isError, true);
  assert.equal(stopped.structuredContent.status, "cancelled");

  // The serve command (stdio) drains on SIGTERM and exits 0: the call in flight still gets its answer.
  const child = spawn(process.execPath, ["src/cli.ts", "serve", "mcp", "test/fixtures/refunds.mts", "--grace", "5"], { stdio: ["pipe", "pipe", "pipe"], cwd: process.cwd(), env: { ...process.env, MCP_SECRET: "test" } });
  let log = "";
  let out = "";
  child.stderr.on("data", (chunk) => (log += String(chunk)));
  child.stdout.on("data", (chunk) => (out += String(chunk)));
  for (let waited = 0; !log.includes("MCP tools on stdio") && waited < 5_000; waited += 50) await new Promise((done) => setTimeout(done, 50));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "refunds", arguments: { goal: "slow under sigterm" }, _meta: meta() } })}\n`);
  await new Promise((done) => setTimeout(done, 100));
  child.kill("SIGTERM");
  const code = await new Promise((done) => child.on("close", done));
  assert.equal(code, 0);
  assert.equal(JSON.parse(out.trim().split("\n").pop()!).result.content[0].text, "paid: refund for slow under sigterm");
  assert.match(log, /SIGTERM: finishing the runs in flight/);
}
console.log("ok · 9 drain refuses new calls and lets the ones in flight return; SIGTERM drains and exits 0");

// ── 10 · watching and steering: start without waiting, read the state mid-run, stop it, find it again later ─
{
  const runsDir = mkdtempSync(join(tmpdir(), "ensemble-mcp-runs-"));
  const served = await serve({ control: true, runsDir });
  const tool = async (name: string, args: Json): Promise<Json> => (await call(served.url, name, args)).body.result as Json;
  assert.deepEqual((await modern(served.url, "tools/list")).body.result.tools.map((entry: Json) => entry.name), ["refunds", "start_run", "get_run", "list_runs", "cancel_run", "answer"]);

  // Started, not waited for: the id comes back at once, and the run can be read while it goes.
  const before = seen.aborted;
  const started = (await tool("start_run", { runner: "refunds", inputs: { goal: "hang on", amount: 7 } })).structuredContent as Json;
  assert.equal(started.status, "running");
  await new Promise((done) => setTimeout(done, 60));
  const midway = (await tool("get_run", { run: started.run })).structuredContent as Json;
  assert.equal(midway.status, "running");
  assert.deepEqual(midway.running, ["wait"], "the node in progress");
  assert.deepEqual(midway.steps.map((step: Json) => [step.node, step.took]), [["write", "e0"]], "the steps that finished, with the edge each took");
  assert.deepEqual(midway.state, { goal: "hang on", amount: 7, draft: "refund for hang on (7)" }, "the state so far: the inputs and what each step wrote");

  // Stopped from outside: the handler is told, and the run says how it ended.
  const stopped = (await tool("cancel_run", { run: started.run })).structuredContent as Json;
  assert.equal(seen.aborted, before + 1);
  assert.notEqual(stopped.status, "running");
  assert.equal((await tool("cancel_run", { run: started.run })).isError, true, "a run that is over cannot be stopped again");

  // One that finishes: its result, and its record on disk where `ensemble run` would have put it.
  const quick = (await tool("start_run", { runner: "refunds", inputs: { goal: "order A-7" } })).structuredContent as Json;
  let done: Json = {};
  for (let waited = 0; waited < 2_000 && done.status !== "completed"; waited += 20) {
    done = (await tool("get_run", { run: quick.run })).structuredContent as Json;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(done.result, "paid: refund for order A-7");
  assert.ok(existsSync(join(runsDir, done.record, "run.json")) && existsSync(join(runsDir, done.record, "graph.json")), "recorded as run.json and graph.json");

  // A run that pauses is read the same way, and answered with the token it shows.
  const asking = (await tool("start_run", { runner: "refunds", inputs: { goal: "ask about A-8" } })).structuredContent as Json;
  let waiting: Json = {};
  for (let waited = 0; waited < 2_000 && waiting.status !== "paused"; waited += 20) {
    waiting = (await tool("get_run", { run: asking.run })).structuredContent as Json;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(waiting.pending.questions.map((question: Json) => question.key), ["ok", "tier"]);
  assert.equal((await tool("answer", { resume: waiting.resume, answers: { ok: true, tier: "standard" } })).content[0].text, "paid: refund for ask about A-8");

  // A plain, waited-for call is tracked too, and the list has them all, newest first.
  await tool("refunds", { goal: "order A-9" });
  const listed = (await tool("list_runs", {})).structuredContent as Json;
  assert.ok(listed.runs.length >= 4);
  assert.ok(listed.runs.every((row: Json, index: number) => index === 0 || listed.runs[index - 1].started >= row.started));
  assert.equal((await tool("list_runs", { runner: "nobody" })).structuredContent.runs.length, 0);
  assert.equal((await tool("get_run", { run: "nope" })).isError, true);
  assert.equal((await tool("start_run", { runner: "nope", inputs: {} })).isError, true);
  await served.close();

  // Another process, later: it never ran these, and still finds them on disk.
  const later = await serve({ control: true, runsDir });
  const found = (await call(later.url, "get_run", { run: done.record })).body.result.structuredContent as Json;
  assert.equal(found.result, "paid: refund for order A-7");
  assert.equal(found.status, "completed");
  assert.ok(((await call(later.url, "list_runs", {})).body.result.structuredContent as Json).runs.some((row: Json) => row.record === done.record));
  await later.close();

  // Without `control`, none of this is offered.
  const plain = await serve();
  assert.equal((await call(plain.url, "get_run", { run: "x" })).body.error.code, -32602);
  await plain.close();
  assert.throws(() => mcpTools([runner({ name: "get_run", work: { a: () => 1 }, nodes: { a: { work: "a" } }, edges: [], entry: "a" })]), /one of the connector's own tools/);
  rmSync(runsDir, { recursive: true, force: true });
}
console.log("ok · 10 start_run, get_run, list_runs and cancel_run watch and steer a run, and find it again on disk");

console.log("10 cases");
