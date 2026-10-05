// The three minimal agents under examples/10-delegate/agents are what the
// "build your own agent" guide tells people to copy, so they are run here for
// real — as processes, against ensemble's own clients — with the one thing
// they call out to, the model, replaced by a local stand-in for OpenRouter.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { agentCard, connect, noul, promptAcp, runner, sendA2a, type AcpAgentSpec, type Answer, type Decider, type Question } from "../src/index.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENTS = join(repo, "examples", "10-delegate", "agents");

// ── a stand-in for OpenRouter: one chat completion, a usage block with a cost ─
const calls: Array<{ authorization: string | undefined; model: string; task: string }> = [];
let slow = false;
const model = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (req.url !== "/chat/completions") {
      res.writeHead(404);
      return res.end();
    }
    const body = JSON.parse(raw) as { model: string; messages: Array<{ role: string; content: string }> };
    const task = body.messages.at(-1)!.content;
    calls.push({ authorization: req.headers["authorization"], model: body.model, task });
    if (slow) return; // never answers: the turn has to be cancelled
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: `model says: ${task}` } }], usage: { total_tokens: 42, cost: 0.0021 } }));
  });
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const env = {
  OPENROUTER_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}`,
  OPENROUTER_API_KEY: "test-key-not-real",
  AGENT_MODEL: "stub/model",
};

const yes: Decider = async (_s: unknown, questions: Record<string, Question>) => {
  const answers: Record<string, Answer> = {};
  for (const key of Object.keys(questions)) answers[key] = { type: "noul", noul: 0.95 };
  return { model: "stub", answers, usage: { input_tokens: 1, output_tokens: 0 }, cost: 0 };
};
const judged = (agents: Record<string, never>, extra: Record<string, unknown> = {}) =>
  runner({
    name: "judge-the-toy",
    inputs: ["goal"],
    agents,
    ...extra,
    nodes: {
      ask: { agent: "toy", reads: ["goal"], writes: ["reply"] },
      review: { decide: { answered: noul("Does the reply answer the request?") }, reads: ["goal", "reply"] },
      deliver: { code: (s) => String(s["reply"]), reads: ["reply"], writes: ["final"] },
      escalate: { code: () => "to a person", writes: ["final"] },
    },
    edges: [
      { from: "ask", to: "review" },
      { from: "review", to: "deliver", on: "answered" },
      { from: "review", to: "escalate", on: "!answered" },
    ],
    entry: "ask",
    result: "final",
  });

// ── 1 · the ACP agent: a prompt turn, a reported cost, and a cancel ─────────
{
  const toy: AcpAgentSpec = { protocol: "acp", command: process.execPath, args: [join(AGENTS, "acp-agent.mjs")], env };
  const reply = await promptAcp("toy", toy, { name: "toy", agent: toy, prompt: "name a colour", signal: new AbortController().signal });
  assert.equal(reply.text, "model says: name a colour");
  assert.equal(reply.status, "end_turn");
  assert.equal(reply.cost, 0.0021, "the agent passed OpenRouter's cost on, so the run's budget can see it");
  assert.equal(reply.meta["name"], "toy-acp-agent");
  assert.deepEqual(calls.at(-1), { authorization: "Bearer test-key-not-real", model: "stub/model", task: "name a colour" });

  const outcome = await judged({ toy } as never)({ goal: "name a colour" }, { decider: yes });
  assert.equal(outcome.result, "model says: name a colour");
  assert.equal(outcome.run.steps[0]!.meta!["cost"], "reported");
  assert.equal(outcome.run.run.cost.total, 0.0021);

  slow = true;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(
    () => promptAcp("toy", toy, { name: "toy", agent: toy, prompt: "never mind", signal: controller.signal }),
    (error: Error & { partial?: { status?: string } }) => {
      assert.match(error.message, /was aborted — the turn was cancelled/);
      assert.equal(error.partial?.status, "cancelled", "it answered session/cancel with the cancelled stop reason");
      return true;
    },
  );
  slow = false;
}
console.log("ok · 1 examples/10-delegate/agents/acp-agent.mjs passes ensemble's ACP client: turn, cost, cancel");

// ── 2 · the A2A agent: its card, a task, and a bearer token ─────────────────
{
  const start = (extra: Record<string, string> = {}): Promise<{ child: ChildProcess; url: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(AGENTS, "a2a-agent.mjs")], { env: { ...process.env, ...env, PORT: "0", ...extra }, stdio: ["ignore", "ignore", "pipe"] });
      let seen = "";
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        seen += chunk;
        const match = /listening on (http:\/\/[\d.:]+)/.exec(seen);
        if (match) resolve({ child, url: match[1]! });
      });
      child.on("exit", (code) => reject(new Error(`the A2A example exited (${code}): ${seen}`)));
    });

  const open = await start();
  try {
    const spec = { protocol: "a2a" as const, url: open.url };
    const card = await agentCard("toy", spec);
    assert.equal(card.name, "Toy A2A agent");
    assert.deepEqual(card.interfaces, [{ url: `${open.url}/a2a`, binding: "JSONRPC", version: "1.0" }]);
    assert.equal(card.streaming, false);

    const reply = await sendA2a("toy", spec, { name: "toy", agent: spec, prompt: "name a planet", signal: new AbortController().signal });
    assert.equal(reply.text, "model says: name a planet");
    assert.equal(reply.status, "completed");
    assert.equal(reply.artifacts[0]!.name, "answer");
    assert.equal(reply.cost, undefined, "A2A has nowhere to report a cost");

    const outcome = await judged({ toy: spec } as never)({ goal: "name a planet" }, { decider: yes });
    assert.equal(outcome.result, "model says: name a planet");
    assert.equal(outcome.run.steps[0]!.meta!["cost"], "unknown");
  } finally {
    open.child.kill();
  }

  const locked = await start({ AGENT_TOKEN: "toy-agent-token-123" });
  try {
    const spec = { protocol: "a2a" as const, url: locked.url, auth: { type: "bearer" as const, token: "${TOY_AGENT_TOKEN}" } };
    const card = await agentCard("toy", spec, { secretResolver: () => "toy-agent-token-123" });
    assert.deepEqual(card.security, [{ name: "bearer", type: "httpAuth" }], "the card declares how to authenticate");
    const request = { name: "toy", agent: spec, prompt: "with a token", signal: new AbortController().signal };
    assert.equal((await sendA2a("toy", spec, { ...request, secretResolver: () => "toy-agent-token-123" })).text, "model says: with a token");
    await assert.rejects(() => sendA2a("toy", spec, { ...request, secretResolver: () => "the-wrong-token-999" }), /the server rejected the bearer token \(HTTP 401\)/);
  } finally {
    locked.child.kill();
  }
}
console.log("ok · 2 examples/10-delegate/agents/a2a-agent.mjs passes ensemble's A2A client: card, task, artifact, bearer auth");

// ── 3 · the MCP agent: one tool, with a schema, called once ─────────────────
{
  const server = { command: process.execPath, args: [join(AGENTS, "mcp-agent.mjs")], env };
  const session = await connect("toy", server);
  const tools = await session.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["run_task"]);
  assert.deepEqual((tools[0]!.inputSchema as { required: string[] }).required, ["task"], "the schema names the argument the prompt goes in");
  assert.equal((await session.call("run_task", {})).isError, true, "a bad call is a tool error, not a crash");
  session.close();

  const outcome = await judged({ toy: { protocol: "mcp", server: "toy", tool: "run_task", input: "task" } } as never, { mcpServers: { toy: server } })(
    { goal: "name a river" },
    { decider: yes },
  );
  assert.equal(outcome.result, "model says: name a river");
  assert.deepEqual(outcome.run.steps.map((step) => step.node), ["ask", "review", "deliver"]);
  assert.equal(outcome.run.steps[0]!.meta!["protocol"], "mcp");
}
console.log("ok · 3 examples/10-delegate/agents/mcp-agent.mjs passes ensemble's MCP client: one tool, one call");

model.closeAllConnections();
model.close();
console.log("3 cases");
