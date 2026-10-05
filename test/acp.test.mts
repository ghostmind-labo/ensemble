// ACP, against a real agent process rather than a mock of our own assumptions.
// The fixture prints a banner before the handshake and splits a message across
// two writes, because real agents do both.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AgentError,
  clientCapabilities,
  decidePermission,
  promptAcp,
  runner,
  RunFailed,
  type AcpAgentSpec,
  type AgentRequest,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "acp-agent.mjs");
const agent = (extra: Partial<AcpAgentSpec> = {}, ...flags: string[]): AcpAgentSpec => ({
  protocol: "acp",
  command: process.execPath,
  args: [FIXTURE, ...flags],
  ...extra,
});
const ask = (prompt: string, spec: AcpAgentSpec = agent(), extra: Partial<AgentRequest> = {}) =>
  promptAcp("coder", spec, { name: "coder", agent: spec, prompt, signal: new AbortController().signal, ...extra });

// ── 1 · one prompt turn: handshake, chunks, usage, stop reason ──────────────
{
  const reply = await ask("plain please");
  assert.equal(reply.text, "Hello, world.\n\nSecond message.", "chunks join; a new message id starts a new paragraph; thoughts are not the reply");
  assert.equal(reply.status, "end_turn");
  assert.equal(reply.cost, 0.0123, "a USD cost the agent reported is the step's cost");
  assert.deepEqual(reply.usage, { used: 1200, size: 200000, cost: { amount: 0.0123, currency: "USD" } });
  assert.deepEqual(reply.meta, { name: "fixture-agent", version: "0.9.0", acp: 1, sessionId: "sess_fixture" });
  assert.deepEqual(reply.toolCalls, []);
}
console.log("ok · 1 initialize, session/new, session/prompt — banner line and split frame and all");

// ── 2 · a cost in another currency is recorded, never converted ─────────────
{
  const reply = await ask("euros");
  assert.equal(reply.cost, undefined, "not USD, so it does not join the run's total");
  assert.deepEqual((reply.usage as { cost: unknown }).cost, { amount: 0.5, currency: "EUR" });
  const silent = await ask("anything else");
  assert.equal(silent.cost, undefined, "no usage_update, no cost: unknown rather than zero");
  assert.equal(silent.text, "echo: anything else");
}
console.log("ok · 2 cost is taken only when reported in USD, and left unknown otherwise");

// ── 3 · the client lends nothing unless the runner says so ──────────────────
{
  assert.deepEqual(clientCapabilities(agent()), {}, "no fs and no terminal: omitted means unsupported");
  assert.deepEqual(clientCapabilities(agent({ fs: { read: true } })), { fs: { readTextFile: true, writeTextFile: false } });
  assert.equal((await ask("caps")).text, "{}", "and that is what the agent is told");
  assert.equal((await ask("caps", agent({ fs: { read: true, write: true } }))).text, '{"fs":{"readTextFile":true,"writeTextFile":true}}');

  const dir = mkdtempSync(join(tmpdir(), "ensemble-acp-"));
  writeFileSync(join(dir, "notes.md"), "line one\nline two\n");
  const refused = await ask(`readfile ${join(dir, "notes.md")}`, agent({ cwd: dir }));
  assert.match(refused.text, /refused: fs\/read_text_file is not offered/);
  const read = await ask(`readfile ${join(dir, "notes.md")}`, agent({ cwd: dir, fs: { read: true } }));
  assert.equal(read.text, "read: line one\nline two\n");
  const outside = await ask(`readfile ${FIXTURE}`, agent({ cwd: dir, fs: { read: true } }));
  assert.match(outside.text, /refused: path is outside the session directory/, "file access is confined to cwd");
  const terminal = await ask("terminal");
  assert.match(terminal.text, /refused: method not supported: terminal\/create/, "a terminal is never offered");
}
console.log("ok · 3 no file system and no terminal by default; fs is opt-in and confined to cwd");

// ── 4 · tool calls are recorded; a permission is answered by policy ─────────
{
  const reply = await ask("tools");
  assert.equal(reply.text, "I was not allowed to edit the file.", "the default policy rejects");
  assert.deepEqual(reply.toolCalls, [
    { id: "call_1", title: "Reading notes.md", kind: "read", status: "completed" },
    { id: "call_2", title: "Editing notes.md", kind: "edit", status: "failed" },
  ]);
  assert.deepEqual(reply.permissions, [{ toolCall: "call_2", title: "Editing notes.md", kind: "edit", outcome: "rejected" }]);

  const allowed = await ask("tools", agent({ permissions: "allow" }));
  assert.equal(allowed.text, "I edited the file.");
  assert.equal(allowed.permissions[0]!.outcome, "allowed");

  const byKind = await ask("tools", agent({ permissions: { allow: ["read", "search"] } }));
  assert.equal(byKind.permissions[0]!.outcome, "rejected", "edit is not in the allowed kinds");
  const edits = await ask("tools", agent({ permissions: { allow: ["edit"] } }));
  assert.equal(edits.permissions[0]!.outcome, "allowed");

  const options = [{ optionId: "a", kind: "allow_always" }, { optionId: "r", kind: "reject_always" }];
  assert.deepEqual(decidePermission("reject", "edit", options), { outcome: "rejected", optionId: "r" });
  assert.deepEqual(decidePermission("allow", "edit", options), { outcome: "allowed", optionId: "a" });
  assert.deepEqual(decidePermission("reject", "edit", [{ optionId: "a", kind: "allow_once" }]), { outcome: "cancelled" }, "no way to say no: decline to choose");
  assert.deepEqual(decidePermission("allow", "edit", [{ optionId: "r", kind: "reject_once" }]), { outcome: "rejected", optionId: "r" });
}
console.log("ok · 4 tool calls are data; permission requests are refused by default and allowed only by a declared policy");

// ── 5 · abort sends session/cancel, and a deaf agent is ended anyway ────────
{
  const controller = new AbortController();
  const spec = agent();
  setTimeout(() => controller.abort(), 150);
  const began = Date.now();
  await assert.rejects(
    () => promptAcp("coder", spec, { name: "coder", agent: spec, prompt: "hang", signal: controller.signal }),
    (error: AgentError) => {
      assert.ok(error instanceof AgentError);
      assert.match(error.message, /agent "coder": was aborted — the turn was cancelled/);
      assert.equal(error.partial?.status, "cancelled", "the agent answered the cancel with the cancelled stop reason");
      assert.equal(error.partial?.text, "working");
      assert.deepEqual(error.partial?.toolCalls, [{ id: "call_slow", title: "Something slow", kind: "execute", status: "in_progress" }]);
      return true;
    },
  );
  assert.ok(Date.now() - began < 1500, "a cooperative agent stops at once");

  const slow = agent({ timeoutMs: 120 });
  const started = Date.now();
  await assert.rejects(() => ask("stubborn", slow), /did not finish within 120ms — the turn was cancelled\. Raise timeoutMs/);
  assert.ok(Date.now() - started < 4000, "an agent that ignores session/cancel is ended after a short grace");
}
console.log("ok · 5 signal and timeout cancel the turn (session/cancel), then end the process");

// ── 6 · every stop reason that is not end_turn fails, and says what to do ───
{
  await assert.rejects(() => ask("refuse"), /the agent refused to continue \(stop reason: refusal\)/);
  await assert.rejects(() => ask("maxtokens"), (error: AgentError) => {
    assert.match(error.message, /stopped at max_tokens before it finished, so its reply is incomplete/);
    assert.equal(error.partial?.text, "half an ans", "what it had said is kept for the record");
    return true;
  });
  await assert.rejects(() => ask("weird"), /stop reason "banana", which ACP v1 does not define \(end_turn, max_tokens, max_turn_requests, refusal, cancelled\)/);
}
console.log("ok · 6 refusal, max_tokens and an unknown stop reason each fail by name");

// ── 7 · a wrong version, a login wall, a missing program, a crash ───────────
{
  await assert.rejects(() => ask("plain", agent({}, "--v2")), /speaks ACP protocol version 2, and this client speaks 1/);
  await assert.rejects(
    () => ask("plain", agent({}, "--needs-login")),
    /wants a login before it opens a session \(Authentication required\) — it offers: Fixture login\. A run cannot log in for it/,
  );
  const missing: AcpAgentSpec = { protocol: "acp", command: "ensemble-no-such-agent-binary" };
  await assert.rejects(() => ask("plain", missing), /could not start "ensemble-no-such-agent-binary" — it is not installed or not on PATH/);
  const notAcp: AcpAgentSpec = { protocol: "acp", command: process.execPath, args: ["-e", "process.exit(7)"] };
  await assert.rejects(() => ask("plain", notAcp), /the agent exited \(7\) before answering/);
}
console.log("ok · 7 protocol version, login, a missing command and an early exit are each named");

// ── 8 · ${NAME} is resolved at launch and never printed ─────────────────────
{
  const spec = agent({ env: { AGENT_KEY: "${ACP_TEST_KEY}" }, args: [FIXTURE, "--tag=${ACP_TEST_TAG}"] });
  const secrets: Record<string, string> = { ACP_TEST_KEY: "sk-super-secret-value", ACP_TEST_TAG: "blue" };
  const reply = await ask("env", spec, { secretResolver: (name) => secrets[name] });
  assert.equal(reply.text, "key:sk-super-secret-value arg:--tag=blue", "the agent got the real values");

  await assert.rejects(() => ask("env", spec, { secretResolver: () => undefined }), /agent "coder": needs ACP_TEST_TAG, ACP_TEST_KEY, which are not set/);
  await assert.rejects(
    () => ask("crash", spec, { secretResolver: (name) => secrets[name] }),
    (error: Error) => {
      assert.match(error.message, /the agent exited \(3\) before answering: fatal: key \*\*\* was rejected/);
      assert.ok(!error.message.includes("sk-super-secret-value"), "a secret echoed on stderr is redacted");
      return true;
    },
  );
}
console.log("ok · 8 secrets are named in the runner, resolved at launch, redacted in errors");

// ── 9 · as a node: graph.json, run.json, and the budget ─────────────────────
{
  const flow = runner({
    name: "acp-node",
    inputs: ["goal"],
    agents: { coder: agent({ env: { AGENT_KEY: "${ACP_TEST_KEY}" } }) },
    nodes: {
      ask: { agent: "coder", prompt: (s) => `tools for ${String(s["goal"])}`, reads: ["goal"], writes: ["reply", "detail"] },
      after: { code: () => "ran", writes: ["after"] },
    },
    edges: [{ from: "ask", to: "after" }],
    entry: "ask",
  });
  assert.deepEqual(flow.validate(), []);
  const node = flow.graph().nodes.find((n) => n.id === "ask")!;
  assert.equal(node.kind, "agent");
  assert.equal(node.cost, "metered");
  assert.equal(node.agent!.protocol, "acp");
  assert.equal(node.agent!.command, process.execPath);
  assert.deepEqual(node.agent!.env, ["AGENT_KEY"], "an environment variable appears by name only");
  assert.equal(node.agent!.permissions, "reject", "the policy is in the graph even when it is the default");
  assert.ok("source" in node.agent!.prompt);

  const outcome = await flow({ goal: "the repo" }, { secretResolver: () => "sk-node-secret-value" });
  const step = outcome.run.steps[0]!;
  assert.equal(step.kind, "agent");
  assert.equal(step.handler, "coder");
  assert.equal(step.cost, 0);
  assert.equal(step.meta!["cost"], "unknown", "no cost reported: the record says unknown, not free");
  assert.equal(step.meta!["protocol"], "acp");
  assert.equal(step.meta!["prompt"], "tools for the repo");
  assert.equal(step.meta!["status"], "end_turn");
  assert.equal((step.meta!["toolCalls"] as unknown[]).length, 2);
  assert.deepEqual(step.meta!["permissions"], [{ toolCall: "call_2", title: "Editing notes.md", kind: "edit", outcome: "rejected" }]);
  assert.equal(outcome.state["reply"], "I was not allowed to edit the file.");
  assert.equal((outcome.state["detail"] as { status: string }).status, "end_turn");
  assert.ok(!JSON.stringify(outcome.run).includes("sk-node-secret-value"), "no secret in run.json");
  assert.ok(!JSON.stringify(flow.graph()).includes("sk-node-secret-value"));

  // A reported cost joins the total, and the budget rule stops the run on it.
  const priced = runner({
    name: "acp-budget",
    inputs: ["goal"],
    agents: { coder: agent() },
    nodes: { ask: { agent: "coder", prompt: "plain", writes: ["reply"] }, after: { code: () => "ran", writes: ["after"] } },
    edges: [{ from: "ask", to: "after" }],
    entry: "ask",
  });
  const capped = await priced({ goal: "x" }, { budget: 0.01 });
  assert.equal(capped.run.run.status, "budget");
  assert.equal(capped.run.run.cost.total, 0.0123);
  assert.equal(capped.run.steps[0]!.meta!["cost"], "reported");
  assert.equal(capped.run.steps.length, 1, "the node after the agent never ran");

  // stepTimeout cancels the turn; the failed step still says what the agent had done.
  const hung = runner({
    name: "acp-timeout",
    inputs: ["goal"],
    agents: { coder: agent() },
    nodes: { ask: { agent: "coder", prompt: "hang", writes: ["reply"] } },
    entry: "ask",
  });
  await assert.rejects(() => hung({ goal: "x" }, { stepTimeout: 200 }), (error: RunFailed) => {
    assert.ok(error instanceof RunFailed);
    assert.match(error.message, /did not finish within 200ms/);
    return true;
  });
}
console.log("ok · 9 an acp agent node: declared in graph.json, recorded in run.json, bounded by budget and stepTimeout");

// ── 10 · the graph's MCP servers, handed to the agent in session/new ────────
{
  const mcpServers = {
    fs: { command: "/usr/local/bin/fs-server", args: ["--root", "/srv"], env: { FS_TOKEN: "${ACP_FS_TOKEN}" } },
    api: { url: "https://mcp.example.com/mcp", auth: { type: "bearer" as const, token: "${ACP_API_TOKEN}" }, headers: { "x-team": "support" } },
    sso: { url: "https://sso.example.com/mcp", auth: { type: "oauth" as const } },
  };
  const secrets: Record<string, string> = { ACP_FS_TOKEN: "fs-secret-value-1", ACP_API_TOKEN: "api-secret-value-2" };
  const extra = { mcpServers, secretResolver: (name: string) => secrets[name] };

  assert.equal((await ask("servers")).text, "[]", "nothing is handed over unless the agent declaration names it");

  const local = await ask("servers", agent({ mcpServers: ["fs"] }), extra);
  assert.deepEqual(JSON.parse(local.text), [
    { name: "fs", command: "/usr/local/bin/fs-server", args: ["--root", "/srv"], env: [{ name: "FS_TOKEN", value: "fs-secret-value-1" }] },
  ]);

  const both = await ask("servers", agent({ mcpServers: ["fs", "api"] }, "--mcp-http"), extra);
  assert.deepEqual(JSON.parse(both.text)[1], {
    type: "http",
    name: "api",
    url: "https://mcp.example.com/mcp",
    headers: [{ name: "x-team", value: "support" }, { name: "Authorization", value: "Bearer api-secret-value-2" }],
  });

  await assert.rejects(
    () => ask("servers", agent({ mcpServers: ["api"] }), extra),
    /cannot be handed MCP server "api": the agent does not advertise mcpCapabilities\.http, so it cannot connect to a url server/,
  );
  await assert.rejects(() => ask("servers", agent({ mcpServers: ["fs"] }), { mcpServers }), /needs ACP_FS_TOKEN, which is not set/);

  const spec = (names: string[]) => ({
    name: "t",
    inputs: ["goal"],
    mcpServers,
    agents: { coder: agent({ mcpServers: names }) },
    nodes: { ask: { agent: "coder", prompt: "servers", writes: ["reply"] } },
    entry: "ask",
  });
  assert.deepEqual(runner(spec(["fs", "api"])).validate(), []);
  assert.match(runner(spec(["nope"])).validate()[0]!, /agent "coder" is handed MCP server "nope", which the runner does not declare\. Declared: "fs", "api", "sso"/);
  assert.match(
    runner(spec(["sso"])).validate()[0]!,
    /agent "coder" cannot be handed MCP server "sso": its auth \(oauth\) cannot be handed to another program — use bearer, basic, an api_key header or headers/,
  );
  const flow = runner(spec(["fs"]));
  assert.deepEqual(flow.graph().nodes[0]!.agent!.mcpServers, ["fs"], "the graph says which servers the agent is given");
  const outcome = await flow({ goal: "x" }, { secretResolver: (name) => secrets[name] });
  assert.equal(JSON.parse(String(outcome.state["reply"]))[0].name, "fs", "and the executor passes the runner's declarations through");
}
console.log("ok · 10 mcpServers on an acp agent are forwarded in session/new: stdio always, http when advertised, header auth only");

console.log("10 cases");
