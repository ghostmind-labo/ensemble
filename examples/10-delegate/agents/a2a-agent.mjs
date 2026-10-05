#!/usr/bin/env node
/**
 * A minimal A2A agent — the least a server must do to be an `a2a` agent in an
 * ensemble graph. No dependencies: node:http, the A2A 1.0 JSON-RPC binding.
 *
 *   PORT=4310 node examples/10-delegate/agents/a2a-agent.mjs
 *   agents: { toy: { protocol: "a2a", url: "http://localhost:4310" } }
 *
 * It answers the task with ONE model call through OpenRouter and returns a
 * completed task holding one artifact. A real agent would loop here, and a
 * long-running one would return the task as TASK_STATE_WORKING and let the
 * client ask again with GetTask.
 *
 * Environment: OPENROUTER_API_KEY, AGENT_MODEL (an OpenRouter model id), and
 * optionally OPENROUTER_BASE_URL (a proxy), PORT, PUBLIC_URL (the address
 * clients reach this server at, for the card), AGENT_TOKEN (require a bearer token).
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const tasks = new Map(); // taskId → { task, abort }

async function askModel(text, signal) {
  const base = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.AGENT_MODEL,
      messages: [
        { role: "system", content: "You are a helpful agent. Do the task and answer briefly." },
        { role: "user", content: text },
      ],
    }),
    signal,
  });
  if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);
  const body = await response.json();
  return body.choices?.[0]?.message?.content ?? "";
}

// 1. The Agent Card: who this is, where to talk to it, and how to authenticate.
const card = (base) => ({
  name: "Toy A2A agent",
  description: "Answers a task with one model call.",
  version: "1.0.0",
  supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "task", name: "Do a task", description: "Answers one request in plain text.", tags: ["general"] }],
  ...(process.env.AGENT_TOKEN
    ? {
        securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
        securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      }
    : {}),
});

const status = (state, text) => ({
  state,
  timestamp: new Date().toISOString(),
  ...(text ? { message: { messageId: randomUUID(), role: "ROLE_AGENT", parts: [{ text }] } } : {}),
});

// 2. SendMessage: do the work, answer with the task in a terminal state.
async function sendMessage(params) {
  const text = (params?.message?.parts ?? []).map((part) => part.text ?? "").join("\n");
  const task = { id: randomUUID(), contextId: params?.message?.contextId ?? randomUUID(), status: status("TASK_STATE_WORKING") };
  const entry = { task, abort: new AbortController() };
  tasks.set(task.id, entry);
  try {
    const reply = await askModel(text, entry.abort.signal);
    // The result is an artifact: one or more parts. Text goes in `text`, JSON in `data`.
    task.artifacts = [{ artifactId: randomUUID(), name: "answer", parts: [{ text: reply }] }];
    task.status = status("TASK_STATE_COMPLETED");
  } catch (error) {
    task.status = entry.abort.signal.aborted ? status("TASK_STATE_CANCELED") : status("TASK_STATE_FAILED", error.message);
  }
  return { task };
}

const methods = {
  SendMessage: sendMessage,
  // 3. GetTask: the task as it is now. A client polls this while a task is working.
  GetTask: async (params) => {
    const entry = tasks.get(params?.id);
    if (!entry) throw Object.assign(new Error("Task not found"), { code: -32001 });
    return entry.task;
  },
  // 4. CancelTask: stop the work.
  CancelTask: async (params) => {
    const entry = tasks.get(params?.id);
    if (!entry) throw Object.assign(new Error("Task not found"), { code: -32001 });
    if (entry.task.status.state !== "TASK_STATE_WORKING") throw Object.assign(new Error("Task cannot be canceled"), { code: -32002 });
    entry.abort.abort();
    entry.task.status = status("TASK_STATE_CANCELED");
    return entry.task;
  },
};

const server = createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const base = process.env.PUBLIC_URL ?? `http://${req.headers.host}`;
  const path = new URL(req.url, base).pathname;

  if (req.method === "GET" && path === "/.well-known/agent-card.json") return json(200, card(base));
  if (req.method !== "POST" || path !== "/a2a") return json(404, { error: "not found" });
  if (process.env.AGENT_TOKEN && req.headers.authorization !== `Bearer ${process.env.AGENT_TOKEN}`) {
    res.writeHead(401, { "www-authenticate": 'Bearer realm="toy-a2a-agent"' });
    return res.end();
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return json(200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON payload" } });
    }
    const reply = (body) => json(200, { jsonrpc: "2.0", id: message.id ?? null, ...body });
    // Clients name the protocol version on every request; refuse one you do not speak.
    const version = req.headers["a2a-version"];
    if (version && version !== "1.0") return reply({ error: { code: -32009, message: `A2A version ${version} is not supported` } });
    const method = methods[message.method];
    if (!method) return reply({ error: { code: -32601, message: "Method not found" } });
    try {
      reply({ result: await method(message.params) });
    } catch (error) {
      reply({ error: { code: error.code ?? -32603, message: error.message } });
    }
  });
});

server.listen(Number(process.env.PORT ?? 4310), "127.0.0.1", () => {
  process.stderr.write(`toy A2A agent listening on http://127.0.0.1:${server.address().port}\n`);
});
