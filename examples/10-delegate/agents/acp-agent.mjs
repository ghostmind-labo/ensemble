#!/usr/bin/env node
/**
 * A minimal ACP agent — the least a program must do to be an `acp` agent in an
 * ensemble graph. No dependencies: newline-delimited JSON-RPC 2.0 on stdio.
 *
 *   agents: { toy: { protocol: "acp", command: "node", args: ["examples/10-delegate/agents/acp-agent.mjs"] } }
 *
 * It answers the task with ONE model call through OpenRouter. A real agent
 * would loop here — call tools, read results, call again — and report each
 * tool with `tool_call` / `tool_call_update`. The protocol around it is the same.
 *
 * Environment: OPENROUTER_API_KEY, AGENT_MODEL (an OpenRouter model id), and
 * optionally OPENROUTER_BASE_URL (a proxy; default https://openrouter.ai/api/v1).
 *
 * stdout belongs to the protocol. Log to stderr.
 */
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const sessions = new Map(); // sessionId → { abort?: AbortController }

async function askModel(task, signal) {
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
    signal,
  });
  if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);
  const body = await response.json();
  return { text: body.choices?.[0]?.message?.content ?? "", usage: body.usage ?? {} };
}

async function prompt(id, params) {
  const session = sessions.get(params.sessionId);
  if (!session) return fail(id, -32602, `unknown session ${params.sessionId}`);
  // 1. The task is the text blocks of the prompt.
  const task = (params.prompt ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const update = (change) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: change } });

  session.abort = new AbortController();
  try {
    const { text, usage } = await askModel(task, session.abort.signal);
    // 2. The reply goes out as message chunks. One is enough; a streaming agent sends many.
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    // 3. Optional, and what lets the caller's budget see this turn: tokens and cost.
    if (typeof usage.total_tokens === "number") {
      update({
        sessionUpdate: "usage_update",
        used: usage.total_tokens,
        size: Number(process.env.AGENT_CONTEXT_SIZE) || usage.total_tokens,
        ...(typeof usage.cost === "number" ? { cost: { amount: usage.cost, currency: "USD" } } : {}),
      });
    }
    // 4. The turn ends with a stop reason, as the RESPONSE to session/prompt.
    ok(id, { stopReason: "end_turn" });
  } catch (error) {
    // A cancelled turn is not an error: answer with the `cancelled` stop reason.
    if (session.abort.signal.aborted) ok(id, { stopReason: "cancelled" });
    else fail(id, -32603, error.message);
  } finally {
    session.abort = undefined;
  }
}

function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      // Answer with the protocol version you speak (1) and what you support.
      // The client's capabilities are in params.clientCapabilities: an absent
      // `fs` or `terminal` means you must not call those methods.
      return ok(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {}, mcpCapabilities: {} },
        agentInfo: { name: "toy-acp-agent", title: "Toy ACP agent", version: "1.0.0" },
        authMethods: [],
      });
    case "session/new": {
      // params.cwd is the working directory; params.mcpServers are servers the
      // client wants you to connect to. This toy uses neither.
      const sessionId = `sess_${sessions.size + 1}`;
      sessions.set(sessionId, {});
      return ok(id, { sessionId });
    }
    case "session/prompt":
      return void prompt(id, params ?? {});
    case "session/cancel": // a notification: no id, no reply
      return sessions.get(params?.sessionId)?.abort?.abort();
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
      handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`bad message: ${error.message}\n`);
    }
  }
});
