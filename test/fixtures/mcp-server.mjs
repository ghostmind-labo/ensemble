#!/usr/bin/env node
// A minimal MCP server, for testing the client against something real rather
// than a mock of our own assumptions. Newline-delimited JSON-RPC 2.0 on stdio,
// which is the whole of what stdio MCP is.
//
// It deliberately does two awkward things a real server does: it logs a
// non-JSON line to stdout before the handshake, and it splits one response
// across two writes. Both broke naive clients while this was being written.

let buffer = "";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

const TOOLS = [
  {
    name: "echo",
    description: "Repeat the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "add",
    description: "Add two numbers and return the sum as structured data.",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  },
  { name: "explode", description: "Always fails, as a tool error." },
  { name: "hang", description: "Never answers, to exercise the client timeout." },
];

// Servers really do print banners to stdout. A client that assumes every line
// is a message falls over here.
process.stdout.write("mcp-fixture ready\n");

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

    if (method === "initialize") {
      ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      });
    } else if (method === "notifications/initialized") {
      // no reply, by protocol
    } else if (method === "tools/list") {
      // Split across two writes, to prove the client reassembles.
      const payload = `${JSON.stringify({ jsonrpc: "2.0", id, result: { tools: TOOLS } })}\n`;
      process.stdout.write(payload.slice(0, 30));
      setTimeout(() => process.stdout.write(payload.slice(30)), 5);
    } else if (method === "tools/call") {
      const { name, arguments: args = {} } = params ?? {};
      if (name === "echo") {
        ok(id, { content: [{ type: "text", text: String(args.text ?? "") }] });
      } else if (name === "add") {
        const sum = Number(args.a ?? 0) + Number(args.b ?? 0);
        ok(id, {
          content: [{ type: "text", text: `sum is ${sum}` }],
          structuredContent: { sum, inputs: [args.a, args.b] },
        });
      } else if (name === "hang") {
        // deliberately no reply
      } else if (name === "explode") {
        ok(id, { content: [{ type: "text", text: "the tool refused" }], isError: true });
      } else {
        err(id, `no such tool: ${name}`);
      }
    } else if (method === "slow") {
      // never answers — used to exercise the client's timeout
    } else if (id !== undefined) {
      err(id, `unknown method: ${method}`);
    }
  }
});
