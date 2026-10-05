#!/usr/bin/env node
/**
 * A minimal agent offered as ONE MCP tool — the least a program must do to be
 * a `mcp` agent in an ensemble graph. No dependencies: newline-delimited
 * JSON-RPC 2.0 on stdio, which is the whole of what stdio MCP is.
 *
 *   mcpServers: { toy: { command: "node", args: ["examples/10-delegate/agents/mcp-agent.mjs"] } },
 *   agents: { toy: { protocol: "mcp", server: "toy", tool: "run_task", input: "task" } }
 *
 * It answers the task with ONE model call through OpenRouter. A real agent
 * would loop inside `runTask`. The caller sees one tool call either way.
 *
 * Environment: OPENROUTER_API_KEY, AGENT_MODEL (an OpenRouter model id), and
 * optionally OPENROUTER_BASE_URL (a proxy; default https://openrouter.ai/api/v1).
 *
 * stdout belongs to the protocol. Log to stderr.
 */
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

// 1. One tool. Its input schema is how a caller learns the argument's name.
const TOOLS = [
  {
    name: "run_task",
    description: "Hand a task to the agent and get its answer back as text.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "What to do, in plain language." } },
      required: ["task"],
    },
  },
];

async function runTask(task) {
  const base = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.AGENT_MODEL,
      messages: [
        { role: "system", content: "You are a helpful agent. Do the task and answer briefly." },
        { role: "user", content: task },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);
  const body = await response.json();
  return body.choices?.[0]?.message?.content ?? "";
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "toy-mcp-agent", version: "1.0.0" },
      });
    case "notifications/initialized":
      return; // a notification: no reply
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      if (params?.name !== "run_task") return fail(id, -32602, `no such tool: ${params?.name}`);
      const task = params.arguments?.task;
      // 2. A bad call or a failed run is a TOOL error (isError), not a protocol error.
      if (typeof task !== "string" || !task) return ok(id, { content: [{ type: "text", text: "task is required" }], isError: true });
      try {
        // 3. The answer is text content. Add `structuredContent` for a JSON result.
        return ok(id, { content: [{ type: "text", text: await runTask(task) }] });
      } catch (error) {
        return ok(id, { content: [{ type: "text", text: error.message }], isError: true });
      }
    }
    default:
      if (id !== undefined && method) fail(id, -32601, `method not found: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`bad message: ${error.message}\n`);
    }
  }
});
