// The agent node itself: what validate proves about it, the MCP option, the
// seam a test swaps, what the reporter prints, and discovery. The two wire
// protocols have suites of their own (a2a, acp).
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  noul,
  preflight,
  promptFromReads,
  runner,
  RunFailed,
  searchAgents,
  summarise,
  toAgentSpec,
  validate,
  warnings,
  type Answer,
  type Decider,
  type Delegate,
  type Question,
  type RunnerSpec,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MCP_FIXTURE = { command: process.execPath, args: [join(here, "fixtures", "mcp-server.mjs")] };

const base = (agents: RunnerSpec["agents"], node: Record<string, unknown> = {}): RunnerSpec => ({
  name: "t",
  inputs: ["goal"],
  ...(agents ? { agents } : {}),
  nodes: { ask: { agent: "helper", reads: ["goal"], writes: ["reply"], ...node } as never },
  entry: "ask",
});
const stub = (text = "fine", extra: Record<string, unknown> = {}): Delegate => async () => ({
  text,
  status: "completed",
  artifacts: [],
  toolCalls: [],
  permissions: [],
  meta: {},
  ...extra,
});

// ── 1 · validate: the node and its declaration ──────────────────────────────
{
  assert.deepEqual(validate(base({ helper: { protocol: "a2a", url: "https://agent.example.com" } })), []);
  assert.deepEqual(validate(base({ helper: { protocol: "acp", command: "opencode", args: ["acp"] } })), []);

  assert.deepEqual(validate(base(undefined)), [
    'node "ask" delegates to agent "helper", which the runner does not declare. Declare it: agents: { helper: { protocol: "a2a", url: "https://…" } }',
  ]);
  assert.match(
    validate(base({ other: { protocol: "a2a", url: "https://a.example" } }))[0]!,
    /node "ask" delegates to agent "helper", which the runner does not declare\. Declared: "other"/,
  );
  assert.match(
    validate(base({ helper: { url: "https://a.example" } as never }))[0]!,
    /agent "helper" has protocol undefined — say how it is reached: protocol: "a2a" \(a hosted agent, by url\), "acp" \(a local agent, launched as a command\) or "mcp" \(an agent offered as a tool\)\. This one looks like protocol: "a2a"/,
  );
  assert.match(validate(base({ helper: { protocol: "a2a" } as never }))[0]!, /agent "helper" needs url — where the agent lives/);
  assert.match(validate(base({ helper: { protocol: "a2a", url: "agent.example.com" } }))[0]!, /which is not a url — e\.g\. https:\/\/agent\.example\.com/);
  assert.match(validate(base({ helper: { protocol: "a2a", url: "ws://agent.example.com" } }))[0]!, /an A2A agent is reached over http\(s\):\/\//);
  assert.match(
    validate(base({ helper: { protocol: "a2a", url: "https://a.example", binding: "GRPC" as never } }))[0]!,
    /binding "GRPC" — use "JSONRPC" or "HTTP\+JSON", or leave it out \(gRPC is not spoken\)/,
  );
  assert.match(validate(base({ helper: { protocol: "a2a", url: "https://a.example", version: "2.0" as never } }))[0]!, /version "2\.0" — use "1\.0" or "0\.3"/);
  assert.match(
    validate(base({ helper: { protocol: "a2a", url: "https://a.example", auth: { type: "bearer", token: "" } } }))[0]!,
    /agent "helper" auth \(bearer\) needs token: "\$\{NAME\}"/,
    "auth is checked with the same rules as a remote MCP server",
  );

  assert.match(validate(base({ helper: { protocol: "acp" } as never }))[0]!, /agent "helper" needs command — the program that speaks ACP on stdio, e\.g\. command: "opencode", args: \["acp"\]/);
  assert.match(
    validate(base({ helper: { protocol: "acp", command: "x", permissions: "ask" as never } }))[0]!,
    /permissions "ask" — use "reject" \(the default\), "allow", or \{ allow: \["read", "search"\] \}/,
  );
  assert.match(
    validate(base({ helper: { protocol: "acp", command: "x", permissions: { allow: ["read", "write"] } } }))[0]!,
    /allows "write", which is not an ACP tool kind\. Kinds: read, edit, delete, move, search, execute, think, fetch, switch_mode, other/,
  );
  assert.match(validate(base({ helper: { protocol: "acp", command: "x", terminal: true } as never }))[0]!, /asks for a terminal — this client never offers one/);

  assert.match(
    validate(base({ helper: { protocol: "mcp", server: "tools", tool: "ask" } }))[0]!,
    /agent "helper" uses MCP server "tools", which the runner does not declare\. No mcpServers are declared/,
  );
  assert.match(validate({ ...base({ helper: { protocol: "mcp", server: "tools" } as never }), mcpServers: { tools: MCP_FIXTURE } })[0]!, /needs tool — the name of the tool that IS the agent/);

  assert.match(validate(base({ helper: { protocol: "a2a", url: "https://a.example" } }, { writes: ["a", "b", "c"] }))[0]!, /an agent node writes at most two keys, positionally: \[text\] or \[text, detail\]/);
  assert.match(validate(base({ helper: { protocol: "a2a", url: "https://a.example" } }, { prompt: "" }))[0]!, /has an empty prompt/);
  assert.match(validate(base({ helper: { protocol: "a2a", url: "https://a.example" } }, { reads: ["missing"] }))[0]!, /node "ask" reads "missing" but nothing writes it/);
  assert.match(
    validate(base({ helper: { protocol: "a2a", url: "https://a.example" } }, { work: "x" }))[0]!,
    /node "ask" is both work and agent — a node must be exactly one/,
  );
  assert.match(validate({ name: "t", nodes: { a: {} as never }, entry: "a" })[0]!, /is none of decide \/ work \/ code \/ model \/ mcp \/ agent/);
}
console.log("ok · 1 validate proves the agent is declared, its protocol is one of three, and each has what it needs");

// ── 2 · warnings: secrets belong in the environment ─────────────────────────
{
  const spec = base({
    helper: { protocol: "a2a", url: "http://agent.example.com", auth: { type: "bearer", token: "sk-literal" } },
    local: { protocol: "acp", command: "x", env: { API_KEY: "sk-literal", MODE: "fast", OTHER_KEY: "${OTHER_KEY}" } },
  });
  assert.deepEqual(warnings(spec), [
    'agent "helper" has a literal secret in auth (bearer).token — write it as "${NAME}" and set NAME in the environment',
    "agent \"helper\" sends credentials to http://agent.example.com without TLS — use https://",
    'agent "local" has a literal secret in env["API_KEY"] — write it as "${NAME}" and set NAME in the environment',
  ]);
  assert.deepEqual(warnings(base({ helper: { protocol: "a2a", url: "https://a.example", auth: { type: "bearer", token: "${T}" } } })), []);
}
console.log("ok · 2 a literal secret or credentials without TLS is a warning that names the fix");

// ── 3 · the message: a prompt, a function, or the reads as they are ─────────
{
  assert.equal(promptFromReads({ goal: "hi", extra: 1 }, ["goal"]), "hi", "one key is sent bare");
  assert.equal(promptFromReads({ goal: "hi", facts: { n: 2 } }, ["goal", "facts"]), 'goal:\nhi\n\nfacts:\n{\n  "n": 2\n}');
  assert.equal(promptFromReads({ goal: "only" }, []), "only", "no reads: the goal");

  const prompts: string[] = [];
  const record: Delegate = async (request) => {
    prompts.push(request.prompt);
    return { text: "ok", status: "completed", artifacts: [], toolCalls: [], permissions: [], meta: {} };
  };
  const agents = { helper: { protocol: "a2a" as const, url: "https://a.example" } };
  await runner(base(agents))({ goal: "from reads" }, { delegate: record });
  await runner(base(agents, { prompt: "fixed text" }))({ goal: "g" }, { delegate: record });
  await runner(base(agents, { prompt: (s: Record<string, unknown>) => `about ${String(s["goal"])}` }))({ goal: "g" }, { delegate: record });
  assert.deepEqual(prompts, ["from reads", "fixed text", "about g"]);

  const graph = (node: Record<string, unknown>) => runner(base(agents, node)).graph().nodes[0]!.agent!.prompt;
  assert.deepEqual(graph({}), { reads: ["goal"] });
  assert.deepEqual(graph({ prompt: "fixed text" }), { text: "fixed text" });
  assert.match((graph({ prompt: (s: Record<string, unknown>) => `about ${String(s["goal"])}` }) as { source: string }).source, /about/);
}
console.log("ok · 3 the message is the prompt, or the node's reads — and graph.json says which");

// ── 4 · protocol "mcp": an agent that is one tool of a declared server ──────
{
  const flow = runner({
    name: "mcp-agent",
    inputs: ["goal"],
    mcpServers: { fixture: MCP_FIXTURE },
    agents: {
      echoer: { protocol: "mcp", server: "fixture", tool: "echo", input: "text" },
      adder: { protocol: "mcp", server: "fixture", tool: "add", input: "note", args: { a: 2, b: 40 } },
      broken: { protocol: "mcp", server: "fixture", tool: "explode" },
    },
    nodes: {
      ask: { agent: "echoer", reads: ["goal"], writes: ["reply"] },
      sum: { agent: "adder", prompt: "add them", writes: ["sum_text", "sum_detail"] },
    },
    edges: [{ from: "ask", to: "sum" }],
    entry: "ask",
  });
  assert.deepEqual(flow.validate(), []);
  assert.deepEqual(flow.graph().nodes[0]!.agent, { name: "echoer", protocol: "mcp", server: "fixture", tool: "echo", prompt: { reads: ["goal"] } });

  const outcome = await flow({ goal: "say it back" });
  assert.equal(outcome.state["reply"], "say it back", "the prompt went in the declared argument");
  assert.equal(outcome.state["sum_text"], "sum is 42");
  assert.deepEqual((outcome.state["sum_detail"] as { data: unknown }).data, { sum: 42, inputs: [2, 40] }, "structuredContent is the detail's data");
  const step = outcome.run.steps[0]!;
  assert.equal(step.kind, "agent");
  assert.deepEqual(step.meta, {
    agent: "echoer",
    protocol: "mcp",
    at: "fixture/echo",
    prompt: "say it back",
    cost: "unknown",
    status: "completed",
    served: { server: "fixture", tool: "echo" },
  });

  const failing = runner({
    name: "mcp-agent-fail",
    inputs: ["goal"],
    mcpServers: { fixture: MCP_FIXTURE },
    agents: { broken: { protocol: "mcp", server: "fixture", tool: "explode" } },
    nodes: { ask: { agent: "broken", writes: ["reply"] } },
    entry: "ask",
  });
  await assert.rejects(() => failing({ goal: "x" }), /agent "broken": the tool fixture\/explode failed: the tool refused/);
}
console.log("ok · 4 an agent offered as an MCP tool: one tools/call, the prompt in a named argument");

// ── 5 · run.json: cost reported or unknown, the budget, and a failure ───────
{
  const agents = { helper: { protocol: "a2a" as const, url: "https://a.example" } };
  const spec: RunnerSpec = {
    ...base(agents),
    nodes: { ask: { agent: "helper", reads: ["goal"], writes: ["reply"] }, after: { code: () => 1, writes: ["n"] } },
    edges: [{ from: "ask", to: "after" }],
  };
  const free = await runner(spec)({ goal: "g" }, { delegate: stub() });
  assert.equal(free.run.steps[0]!.cost, 0);
  assert.equal(free.run.steps[0]!.meta!["cost"], "unknown");
  assert.equal(free.run.version, 1);

  const paid = await runner(spec)(
    { goal: "g" },
    { delegate: stub("priced", { cost: 0.25, usage: { used: 10 }, toolCalls: [{ id: "c1", title: "Search", kind: "search", status: "completed" }] }), budget: 0.1 },
  );
  assert.equal(paid.run.run.status, "budget", "a reported cost counts toward the budget, and the budget stops the run");
  assert.equal(paid.run.run.cost.total, 0.25);
  assert.equal(paid.run.steps[0]!.meta!["cost"], "reported");
  assert.deepEqual(paid.run.steps[0]!.meta!["toolCalls"], [{ id: "c1", title: "Search", kind: "search", status: "completed" }]);
  assert.equal(paid.run.steps.length, 1);

  assert.match(summarise(free.run.steps[0]!), /^☎ ask .* cost \? {2}helper · a2a · completed · wrote reply$/, "an unknown cost is not printed as free");
  assert.match(summarise(paid.run.steps[0]!), /\$0\.2500 {2}helper · a2a · completed · 1 tool call · wrote reply$/);

  const events: string[] = [];
  await runner(spec)({ goal: "g" }, { delegate: stub(), onEvent: (event) => event.type === "node:start" && events.push(`${event.kind}: ${event.waiting}`) });
  assert.equal(events[0], 'agent: delegating to "helper" over a2a');

  const throwing: Delegate = async () => {
    throw new Error("the line dropped");
  };
  await assert.rejects(() => runner(spec)({ goal: "g" }, { delegate: throwing }), (error: RunFailed) => {
    assert.equal(error.run.steps[0]!.error, "the line dropped");
    assert.equal(error.run.steps[0]!.meta!["prompt"], "g", "a failed step still says who was asked what");
    return true;
  });
}
console.log("ok · 5 cost is reported or marked unknown, the budget stops on it, and the reporter does not call unknown free");

// ── 6 · it composes: in a fork lane, judged by a decide node ────────────────
{
  const decider: Decider = async (_s: unknown, questions: Record<string, Question>) => {
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(questions)) answers[key] = { type: "noul", noul: 0.9 };
    return { model: "stub", answers, usage: { input_tokens: 1, output_tokens: 0 }, cost: 0 };
  };
  const flow = runner({
    name: "lanes",
    inputs: ["goal"],
    agents: { a: { protocol: "a2a", url: "https://a.example" }, b: { protocol: "acp", command: "x" } },
    nodes: {
      start: { code: () => 1, writes: ["n"] },
      one: { agent: "a", reads: ["goal"], writes: ["first"] },
      two: { agent: "b", reads: ["goal"], writes: ["second"] },
      judge: { decide: { good: noul("Do the two replies agree?") }, reads: ["first", "second"], join: "all" },
    },
    edges: [
      { from: "start", to: "one", fork: true },
      { from: "start", to: "two", fork: true },
      { from: "one", to: "judge" },
      { from: "two", to: "judge" },
    ],
    entry: "start",
  });
  assert.deepEqual(flow.validate(), []);
  const outcome = await flow({ goal: "g" }, { decider, delegate: async (request) => ({ text: `from ${request.name}`, status: "completed", artifacts: [], toolCalls: [], permissions: [], meta: {} }) });
  assert.equal(outcome.state["first"], "from a");
  assert.equal(outcome.state["second"], "from b");
  assert.equal(outcome.run.steps.at(-1)!.node, "judge");

  const colliding = { ...flow.spec, nodes: { ...flow.spec.nodes, two: { agent: "b", reads: ["goal"], writes: ["first"] } } };
  assert.match(validate(colliding as RunnerSpec).join("\n"), /the lanes both touch "first"/, "an agent node's writes are in the lane proof");
}
console.log("ok · 6 two agents on two lanes, joined and judged — and the lane proof covers their writes");

// ── 7 · preflight for acp and mcp agents; the ACP registry ──────────────────
{
  const spec = {
    name: "p",
    nodes: { a: { agent: "coder" }, b: { agent: "tool" } },
    mcpServers: { fixture: MCP_FIXTURE },
    agents: {
      coder: { protocol: "acp" as const, command: "definitely-not-installed-acp", env: { KEY: "${CODER_KEY}" } },
      tool: { protocol: "mcp" as const, server: "fixture", tool: "echo" },
    },
  };
  const flight = await preflight(spec, { env: {} });
  assert.ok(flight.problems.includes('agent "coder" runs "definitely-not-installed-acp", which is not on PATH here — install it, or give the full path as command'));
  assert.ok(flight.problems.includes('CODER_KEY is not set — needed by agent "coder"'));
  assert.ok(flight.notes.some((note) => note.includes('launches agent "coder" as a local process over ACP') && note.includes('answered "reject"')));
  assert.ok(flight.notes.includes('node "b" reaches agent "tool" as the MCP tool fixture/echo'));
  const ok = await preflight(spec, { env: { CODER_KEY: "k" }, which: () => true });
  assert.deepEqual(ok.problems, []);

  const registry = {
    version: "1.0.0",
    agents: [
      { id: "node-agent", name: "Node Agent", version: "1.2.0", description: "A coding agent", distribution: { npx: { package: "node-agent@1.2.0", args: ["--acp"] } } },
      { id: "py-agent", name: "Py Agent", version: "0.3.0", description: "Research", distribution: { uvx: { package: "py-agent@latest", args: ["acp"] } } },
      { id: "bin-agent", name: "Bin Agent", version: "2.0.0", description: "Native coding", distribution: { binary: { "darwin-aarch64": { archive: "https://x/y.tgz", cmd: "./bin-agent" } } } },
    ],
  };
  const fetched: string[] = [];
  const fetch = (async (url: string) => {
    fetched.push(String(url));
    return new Response(JSON.stringify(registry), { status: 200 });
  }) as typeof globalThis.fetch;
  const all = await searchAgents(undefined, { fetch });
  assert.deepEqual(fetched, ["https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"]);
  assert.deepEqual(all.map((entry) => entry.id), ["node-agent", "py-agent", "bin-agent"]);
  assert.deepEqual(toAgentSpec(all[0]!), { protocol: "acp", command: "npx", args: ["-y", "node-agent@1.2.0", "--acp"] });
  assert.deepEqual(toAgentSpec(all[1]!), { protocol: "acp", command: "uvx", args: ["py-agent@latest", "acp"] });
  assert.equal(toAgentSpec(all[2]!), undefined, "a binary has to be installed first");
  assert.deepEqual((await searchAgents("coding", { fetch })).map((entry) => entry.id), ["node-agent", "bin-agent"]);
  await assert.rejects(() => searchAgents("x", { fetch: (async () => new Response("no", { status: 503 })) as typeof globalThis.fetch }), /the ACP registry returned HTTP 503/);
}
console.log("ok · 7 preflight checks the command and the secret by name; the ACP registry yields launchable declarations");

console.log("7 cases");
