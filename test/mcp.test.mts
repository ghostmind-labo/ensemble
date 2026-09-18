// MCP, against a real server process rather than a mock of our own
// assumptions. The fixture logs a banner to stdout and splits a response across
// two writes, because real servers do both and both broke the client once.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connect, pool, runner, toolOptions, validate, type RunnerSpec } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = { command: process.execPath, args: [join(here, "fixtures", "mcp-server.mjs")] };

// ── 1 · handshake, listing, and a framing that is not naive ─────────────────
{
  const session = await connect("fixture", FIXTURE);
  const tools = await session.listTools();

  assert.deepEqual(tools.map((t) => t.name), ["echo", "add", "explode", "hang"]);
  assert.equal(tools[0]!.description, "Repeat the text back.");
  assert.equal((tools[0]!.inputSchema as { type: string }).type, "object", "the schema survives for a caller to read");
  session.close();
}
console.log("ok · 1 connect, handshake and tools/list — banner line and split frame and all");

// ── 2 · calling: text, structured data, and a tool that fails ───────────────
{
  const session = await connect("fixture", FIXTURE);

  const echoed = await session.call("echo", { text: "hello there" });
  assert.equal(echoed.text, "hello there");
  assert.equal(echoed.isError, false);
  assert.equal(echoed.data, undefined);

  const added = await session.call("add", { a: 2, b: 40 });
  assert.equal(added.text, "sum is 42");
  assert.deepEqual(added.data, { sum: 42, inputs: [2, 40] });

  const failed = await session.call("explode", {});
  assert.equal(failed.isError, true, "a tool error is reported, not thrown by the client");
  assert.equal(failed.text, "the tool refused");

  await assert.rejects(() => session.call("nope", {}), /no such tool/);
  session.close();
}
console.log("ok · 2 text, structuredContent, tool errors and unknown tools each behave");

// ── 3 · the pool starts a server once, and only when reached ───────────────
{
  const servers = pool({ fixture: FIXTURE });
  const [a, b] = await Promise.all([servers.get("fixture"), servers.get("fixture")]);
  assert.equal(a, b, "one process, reused");

  assert.throws(() => servers.get("missing"), /not configured/);
  assert.throws(() => servers.get("missing"), /Declared: "fixture"/, "and it names what IS declared");
  servers.closeAll();
}
console.log("ok · 3 one process per server, started lazily, named clearly when absent");

// ── 4 · a timeout does not hang the run ─────────────────────────────────────
{
  const session = await connect("slowly", { ...FIXTURE, timeoutMs: 120 });
  const began = Date.now();
  await assert.rejects(() => session.call("hang", {}), (error: Error) => {
    assert.match(error.message, /mcp "slowly": tools\/call timed out after 120ms/);
    return true;
  });
  assert.ok(Date.now() - began < 3000, "it gave up promptly rather than waiting on the process");
  session.close();
}
console.log("ok · 4 the client errors rather than hanging");

// ── 5 · an mcp node runs one tool, and writes [text] or [text, data] ────────
{
  const flow = runner({
    name: "mcp-node",
    // `a` is read by the args function, so it must be declared — validate proves it.
    inputs: ["goal", "a"],
    mcpServers: { fixture: FIXTURE },
    nodes: {
      sum: {
        mcp: { server: "fixture", tool: "add" },
        args: (state) => ({ a: Number(state["a"] ?? 0), b: 2 }),
        reads: ["a"],
        writes: ["said", "result"],
      },
    },
    entry: "sum",
    result: "result",
  });

  assert.deepEqual(flow.validate(), []);
  const { result, state, run } = await flow({ goal: "add it", a: 40 });

  assert.deepEqual(result, { sum: 42, inputs: [40, 2] });
  assert.equal(state["said"], "sum is 42");
  assert.equal(run.steps[0]!.kind, "mcp");
  assert.equal(run.steps[0]!.handler, "fixture/add");
  assert.equal(run.steps[0]!.cost, 0, "an MCP call costs this library nothing");
  assert.deepEqual(run.steps[0]!.meta, { server: "fixture", tool: "add", isError: false });
}
console.log("ok · 5 an mcp node calls one tool and writes its text and data");

// ── 6 · the tool can be chosen upstream, and a failure is a failure ─────────
{
  const routed = runner({
    name: "routed",
    mcpServers: { fixture: FIXTURE },
    nodes: {
      pick: { code: () => "echo", writes: ["tool"] },
      run: { mcp: { server: "fixture", tool: { from: "tool" } }, args: { text: "routed" }, writes: ["out"] },
    },
    edges: [{ from: "pick", to: "run" }],
    entry: "pick",
    result: "out",
  });
  assert.equal((await routed()).result, "routed");

  const declining = runner({
    name: "declining",
    mcpServers: { fixture: FIXTURE },
    nodes: {
      pick: { code: () => "none", writes: ["tool"] },
      run: { mcp: { server: "fixture", tool: { from: "tool" } }, writes: ["out"] },
    },
    edges: [{ from: "pick", to: "run" }],
    entry: "pick",
  });
  await assert.rejects(() => declining(), /wire that answer to a different branch/);

  const failing = runner({
    name: "failing",
    mcpServers: { fixture: FIXTURE },
    nodes: { boom: { mcp: { server: "fixture", tool: "explode" }, writes: ["out"] } },
    entry: "boom",
  });
  await assert.rejects(() => failing(), /the tool refused/);
}
console.log("ok · 6 { from } routes the tool; \"none\" and tool errors both fail loudly");

// ── 7 · validation, and what the graph says a workflow can reach ────────────
{
  const undeclared: RunnerSpec = {
    name: "u",
    nodes: { n: { mcp: { server: "ghost", tool: "x" } } },
    entry: "n",
  };
  assert.ok(validate(undeclared).some((p) => /does not declare/.test(p)));
  assert.ok(validate(undeclared).some((p) => /No mcpServers are declared/.test(p)));
  assert.ok(
    validate({ ...undeclared, nodes: { n: { mcp: { server: "ghost", tool: "" } } } }).some((p) =>
      /names no tool/.test(p),
    ),
  );
  assert.ok(
    validate({
      name: "w",
      mcpServers: { fixture: FIXTURE },
      nodes: { n: { mcp: { server: "fixture", tool: "echo" }, writes: ["a", "b", "c"] } },
      entry: "n",
    }).some((p) => /writes at most two keys/.test(p)),
  );

  // The point of a node rather than a loop: the graph names every reachable tool.
  const flow = runner({
    name: "g",
    mcpServers: { fixture: FIXTURE },
    nodes: {
      a: { mcp: { server: "fixture", tool: "echo" }, args: { text: "x" }, writes: ["out"] },
      b: { mcp: { server: "fixture", tool: { from: "out" } }, args: (s) => ({ text: s["out"] }), writes: ["two"] },
    },
    edges: [{ from: "a", to: "b" }],
    entry: "a",
  });
  const nodes = Object.fromEntries(flow.graph().nodes.map((n) => [n.id, n]));
  assert.equal(nodes["a"]!.kind, "mcp");
  assert.equal(nodes["a"]!.cost, "free", "the call costs this library nothing; the server may differ");
  assert.deepEqual(nodes["a"]!.mcp, { server: "fixture", tool: "echo", args: { literal: { text: "x" } } });
  assert.equal(nodes["b"]!.mcp!.toolFrom, "out");
  assert.match((nodes["b"]!.mcp!.args as { source: string }).source, /text: s\["out"\]/);
}
console.log("ok · 7 validation catches undeclared servers; the graph names every reachable tool");

console.log("7 cases");
