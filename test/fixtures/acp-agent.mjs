#!/usr/bin/env node
// A minimal ACP agent, for testing the client against a real process rather
// than a mock of our own assumptions. Newline-delimited JSON-RPC 2.0 on stdio,
// protocol version 1.
//
// The prompt's first word picks the behaviour, so one fixture covers a plain
// turn, tool calls, a permission request, a file read, cancellation, and every
// stop reason. Like a real agent it prints a banner before the handshake and
// splits one message across two writes.
//
// Flags: --v2 answers with protocol version 2, --needs-login refuses
// session/new until someone logs in, --mcp-http advertises the HTTP MCP capability.

const flags = new Set(process.argv.slice(2));
let buffer = "";
let nextId = 1000;
let capabilities = {};
let servers = [];
let cancelled = false;
let finishPrompt;
const waiting = new Map();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const update = (change) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_fixture", update: change } });
const say = (text, messageId = "msg_1") => update({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

process.stdout.write("acp-fixture ready\n");

async function prompt(id, text) {
  const word = text.trim().split(/\s+/)[0];
  const end = (stopReason) => ok(id, { stopReason });

  switch (word) {
    case "plain": {
      // One update split across two writes, to prove the client reassembles.
      const frame = `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_fixture", update: { sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "Hello, " } } } })}\n`;
      process.stdout.write(frame.slice(0, 40));
      await new Promise((r) => setTimeout(r, 10));
      process.stdout.write(frame.slice(40));
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking, which is not the reply" } });
      say("world.");
      say("Second message.", "msg_2");
      update({ sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.0123, currency: "USD" } });
      return end("end_turn");
    }
    case "euros":
      say("priced in euros");
      update({ sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.5, currency: "EUR" } });
      return end("end_turn");
    case "servers":
      say(JSON.stringify(servers));
      return end("end_turn");
    case "caps":
      say(JSON.stringify(capabilities));
      return end("end_turn");
    case "tools": {
      update({ sessionUpdate: "tool_call", toolCallId: "call_1", title: "Reading notes.md", kind: "read", status: "pending" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" });
      update({ sessionUpdate: "tool_call", toolCallId: "call_2", title: "Editing notes.md", kind: "edit", status: "pending" });
      const answer = await ask("session/request_permission", {
        sessionId: "sess_fixture",
        toolCall: { toolCallId: "call_2" },
        options: [
          { optionId: "yes", name: "Allow once", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      const allowed = answer.result?.outcome?.outcome === "selected" && answer.result.outcome.optionId === "yes";
      update({ sessionUpdate: "tool_call_update", toolCallId: "call_2", status: allowed ? "completed" : "failed" });
      say(allowed ? "I edited the file." : "I was not allowed to edit the file.");
      return end("end_turn");
    }
    case "readfile": {
      const path = text.trim().split(/\s+/)[1];
      const answer = await ask("fs/read_text_file", { sessionId: "sess_fixture", path });
      say(answer.error ? `refused: ${answer.error.message}` : `read: ${answer.result.content}`);
      return end("end_turn");
    }
    case "terminal": {
      const answer = await ask("terminal/create", { sessionId: "sess_fixture", command: "ls" });
      say(answer.error ? `refused: ${answer.error.message}` : "got a terminal");
      return end("end_turn");
    }
    case "hang":
      update({ sessionUpdate: "tool_call", toolCallId: "call_slow", title: "Something slow", kind: "execute", status: "in_progress" });
      say("working");
      finishPrompt = () => end("cancelled");
      if (cancelled) finishPrompt();
      return;
    case "stubborn":
      say("ignoring you");
      return; // never answers, even when cancelled
    case "refuse":
      return end("refusal");
    case "maxtokens":
      say("half an ans");
      return end("max_tokens");
    case "weird":
      return end("banana");
    case "crash":
      process.stderr.write(`fatal: key ${process.env.AGENT_KEY ?? "(none)"} was rejected\n`);
      process.exit(3);
      return;
    case "env":
      say(`key:${process.env.AGENT_KEY ?? "unset"} arg:${process.argv.slice(2).join(",")}`);
      return end("end_turn");
    default:
      say(`echo: ${text}`);
      return end("end_turn");
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = message;

    if (method === undefined && waiting.has(id)) {
      waiting.get(id)(message);
      waiting.delete(id);
    } else if (method === "initialize") {
      capabilities = params?.clientCapabilities ?? {};
      ok(id, {
        protocolVersion: flags.has("--v2") ? 2 : 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {}, ...(flags.has("--mcp-http") ? { mcpCapabilities: { http: true } } : {}) },
        agentInfo: { name: "fixture-agent", title: "Fixture Agent", version: "0.9.0" },
        authMethods: flags.has("--needs-login") ? [{ id: "login", name: "Fixture login" }] : [],
      });
    } else if (method === "session/new") {
      if (flags.has("--needs-login")) err(id, -32000, "Authentication required");
      else if (!params?.cwd || !Array.isArray(params?.mcpServers)) err(id, -32602, "cwd and mcpServers are required");
      else {
        servers = params.mcpServers;
        ok(id, { sessionId: "sess_fixture" });
      }
    } else if (method === "session/prompt") {
      const text = (params?.prompt ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
      prompt(id, text);
    } else if (method === "session/cancel") {
      cancelled = true;
      finishPrompt?.();
    } else if (id !== undefined) {
      err(id, -32601, `method not found: ${method}`);
    }
  }
});
