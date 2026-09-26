// Remote MCP servers and a fake OAuth authorization server, for testing the
// client against real sockets rather than a mock of our own assumptions.
//
// Written independently of src/: the WebSocket framing, the SSE writer and the
// OAuth checks (PKCE, client authentication, rotation) are the server's side of
// each protocol, so the client is tested against the spec, not against itself.
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

const TOOLS = [
  { name: "echo", description: "Repeat the text back.", inputSchema: { type: "object" } },
  { name: "add", description: "Add two numbers." },
  { name: "admin", description: "Needs the admin scope." },
  { name: "hang", description: "Never answers." },
];

/** MCP semantics, shared by every transport. Returns a reply, or null for none. */
function answer(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) return null; // notification, or a reply to our ping
  if (method === undefined) return null;
  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "remote-fixture", version: "1" } } };
  }
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    const { name, arguments: args = {} } = params ?? {};
    if (name === "echo") return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(args.text ?? "") }] } };
    if (name === "add") return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `sum is ${args.a + args.b}` }], structuredContent: { sum: args.a + args.b } } };
    if (name === "admin") return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "admin ok" }] } };
    if (name === "hang") return "hang";
    return { jsonrpc: "2.0", id, error: { code: -32602, message: `no such tool: ${name}` } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } };
}

const readBody = async (req) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
};

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/**
 * Streamable HTTP. `mode`: "json" answers in the POST body; "sse" answers as an
 * event stream, preceded by a notification and a server-to-client ping.
 * `guard(req, message)` may return { status, headers } to refuse a request.
 */
export async function streamableServer({ mode = "json", guard, tls, path = "/mcp" } = {}) {
  const log = { posts: [], deleted: [], sessions: new Set(), pings: 0, headers: [] };
  const expired = new Set();
  const handler = async (req, res) => {
    const url = new URL(req.url, "http://x");
    log.headers.push(req.headers);
    if (url.pathname !== path) return res.writeHead(404).end();
    if (req.method === "GET") return res.writeHead(405).end();
    if (req.method === "DELETE") {
      log.deleted.push(req.headers["mcp-session-id"]);
      return res.writeHead(200).end();
    }
    const body = await readBody(req);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      return res.writeHead(400).end("bad json");
    }
    log.posts.push({ message, headers: req.headers, query: Object.fromEntries(url.searchParams) });
    const refused = guard?.(req, message, url);
    if (refused) return res.writeHead(refused.status, refused.headers ?? {}).end(refused.body ?? "");

    if (message.method === "initialize") {
      const id = randomBytes(6).toString("hex");
      log.sessions.add(id);
      res.setHeader("mcp-session-id", id);
    } else {
      const sid = req.headers["mcp-session-id"];
      if (!sid) return res.writeHead(400).end("missing session");
      if (expired.has(sid) || !log.sessions.has(sid)) return res.writeHead(404).end("unknown session");
      if (message.method !== "notifications/initialized" && req.headers["mcp-protocol-version"] === undefined) {
        return res.writeHead(400).end("missing MCP-Protocol-Version");
      }
    }
    if (message.id === undefined || message.method === undefined) {
      if (message.method === undefined && message.result !== undefined) log.pings++;
      return res.writeHead(202).end();
    }
    const reply = answer(message);
    if (reply === "hang") return; // never answer
    if (mode === "sse" && message.method !== "initialize") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`: comment\n\n`);
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "ping" })}\n\n`);
      // Split one event across two writes and use a multi-line data field.
      const text = JSON.stringify(reply);
      const half = Math.floor(text.length / 2);
      res.write(`id: 7\nevent: message\ndata: ${text.slice(0, half)}`);
      setTimeout(() => {
        res.write(`${text.slice(half)}\n\n`);
      }, 5);
      return; // leave the stream open: the client must stop on its own reply
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  };
  const server = tls ? createHttpsServer(tls, handler) : createServer(handler);
  const port = await listen(server);
  return {
    url: `${tls ? "https" : "http"}://127.0.0.1:${port}${path}`,
    log,
    expireAll: () => log.sessions.forEach((sid) => expired.add(sid)),
    close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}

/** The 2024-11-05 transport: GET an event stream, POST to the endpoint it names. POST to the stream url is 405. */
export async function legacyServer() {
  const streams = new Map();
  const log = { gets: 0, posts: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/sse" && req.method === "GET") {
      log.gets++;
      const sid = randomBytes(4).toString("hex");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: endpoint\ndata: /messages?sessionId=${sid}\n\n`);
      streams.set(sid, res);
      return;
    }
    if (url.pathname === "/sse") return res.writeHead(405).end();
    if (url.pathname === "/messages" && req.method === "POST") {
      log.posts++;
      const stream = streams.get(url.searchParams.get("sessionId"));
      if (!stream) return res.writeHead(404).end();
      const message = JSON.parse(await readBody(req));
      res.writeHead(202).end();
      const reply = answer(message);
      if (reply && reply !== "hang") stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/sse`,
    log,
    close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}

/** An SSE server whose endpoint event points at another origin — the client must refuse it. */
export async function hostileLegacyServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: endpoint\ndata: https://evil.example/messages\n\n`);
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/sse`, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) };
}

/* ── WebSocket, server side of RFC 6455 ── */

const serverFrame = (opcode, payload, fin = true) => {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, length]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 126, length >> 8, length & 0xff]);
  return Buffer.concat([head, payload]);
};

export async function websocketServer({ requireHeader } = {}) {
  const log = { upgrades: 0, refused: 0, pongs: 0, headers: [] };
  const server = createServer((req, res) => res.writeHead(426).end());
  server.on("upgrade", (req, socket) => {
    log.headers.push(req.headers);
    if (requireHeader && req.headers[requireHeader.name] !== requireHeader.value) {
      log.refused++;
      socket.end("HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Basic realm=\"ws\"\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    log.upgrades++;
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\nsec-websocket-protocol: mcp\r\n\r\n`);
    // A ping straight after the upgrade: the client must pong it.
    socket.write(serverFrame(0x9, Buffer.from("hi")));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        if ((buffer[1] & 0x80) === 0) return socket.destroy(); // clients MUST mask
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) (length = buffer.readUInt16BE(2)), (offset = 4);
        else if (length === 127) (length = Number(buffer.readBigUInt64BE(2))), (offset = 10);
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length).map((b, i) => b ^ mask[i % 4]));
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 0x8) return socket.end(serverFrame(0x8, Buffer.alloc(0)));
        if (opcode === 0xa) {
          log.pongs++;
          continue;
        }
        if (opcode !== 0x1) continue;
        const reply = answer(JSON.parse(payload.toString("utf8")));
        if (!reply || reply === "hang") continue;
        const bytes = Buffer.from(JSON.stringify(reply));
        if (reply.result?.tools) {
          // Fragmented: text frame without FIN, then a continuation.
          socket.write(serverFrame(0x1, bytes.subarray(0, 10), false));
          socket.write(serverFrame(0x0, bytes.subarray(10), true));
        } else socket.write(serverFrame(0x1, bytes));
      }
    });
    socket.on("error", () => {});
  });
  const port = await listen(server);
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    log,
    close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}

/* ── OAuth 2.1: a protected resource and its authorization server ── */

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

/**
 * An authorization server that checks what a real one checks: PKCE, the
 * registered redirect, client authentication by the method the client uses,
 * single-use rotating refresh tokens, and the resource indicator.
 */
export async function authServer({ issueSecret = false, expiresIn = 3600, dcr = true, clients = {} } = {}) {
  const log = { registrations: [], tokens: [], revoked: [], devicePolls: 0, authorizations: [] };
  const registered = new Map(Object.entries(clients)); // id -> { secret?, redirectUris, publicKey? }
  const codes = new Map();
  const devices = new Map();
  const access = new Map(); // token -> { scope, expires, client }
  const refresh = new Map(); // token -> { scope, client }
  let base = "";

  const issue = (client, scope, resource) => {
    const token = `at-${randomBytes(8).toString("hex")}`;
    const rt = `rt-${randomBytes(8).toString("hex")}`;
    access.set(token, { scope, expires: Date.now() + expiresIn * 1000, client, resource });
    refresh.set(rt, { scope, client, resource });
    return { access_token: token, token_type: "Bearer", expires_in: expiresIn, refresh_token: rt, scope };
  };

  /** Which client, authenticated how — or why not. */
  const authenticate = (req, form) => {
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
    if (basic) {
      const [id, secret] = Buffer.from(basic[1], "base64").toString().split(":").map(decodeURIComponent);
      const client = registered.get(id);
      if (!client || client.secret !== secret) return { error: "invalid_client" };
      return { id, method: "client_secret_basic" };
    }
    if (form.get("client_assertion")) {
      const id = form.get("client_id");
      const client = registered.get(id);
      const [head, claims, signature] = form.get("client_assertion").split(".");
      const header = JSON.parse(Buffer.from(head, "base64url"));
      const payload = JSON.parse(Buffer.from(claims, "base64url"));
      const key = createPublicKey(client?.publicKey ?? "");
      const digest = header.alg === "EdDSA" ? null : "sha256";
      const ok = verify(digest, Buffer.from(`${head}.${claims}`), header.alg.startsWith("ES") ? { key, dsaEncoding: "ieee-p1363" } : key, Buffer.from(signature, "base64url"));
      if (!ok || payload.iss !== id || payload.sub !== id || payload.aud !== `${base}/token` || payload.exp < Date.now() / 1000) return { error: "invalid_client" };
      return { id, method: "private_key_jwt", alg: header.alg };
    }
    const id = form.get("client_id");
    const client = registered.get(id);
    if (!client) return { error: "invalid_client" };
    if (form.get("client_secret")) {
      if (client.secret !== form.get("client_secret")) return { error: "invalid_client" };
      return { id, method: "client_secret_post" };
    }
    if (client.secret) return { error: "invalid_client" }; // confidential clients must authenticate
    return { id, method: "none" };
  };

  const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const form = new URLSearchParams(req.method === "POST" && !String(req.headers["content-type"]).includes("json") ? await readBody(req) : "");
    switch (url.pathname) {
      case "/.well-known/oauth-authorization-server":
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          device_authorization_endpoint: `${base}/device`,
          revocation_endpoint: `${base}/revoke`,
          ...(dcr ? { registration_endpoint: `${base}/register` } : {}),
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post", "private_key_jwt"],
          grant_types_supported: ["authorization_code", "refresh_token", "client_credentials", "urn:ietf:params:oauth:grant-type:device_code"],
        });
      case "/register": {
        const body = JSON.parse(await readBody(req));
        const id = `client-${registered.size + 1}`;
        const secret = issueSecret ? `secret-${randomBytes(6).toString("hex")}` : undefined;
        registered.set(id, { secret, redirectUris: body.redirect_uris ?? [] });
        log.registrations.push({ id, body });
        return json(res, 201, { client_id: id, ...(secret ? { client_secret: secret, token_endpoint_auth_method: "client_secret_post" } : { token_endpoint_auth_method: "none" }) });
      }
      case "/authorize": {
        const p = url.searchParams;
        const client = registered.get(p.get("client_id"));
        log.authorizations.push(Object.fromEntries(p));
        if (!client || !client.redirectUris.includes(p.get("redirect_uri"))) return json(res, 400, { error: "invalid_request" });
        if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) return json(res, 400, { error: "invalid_request", error_description: "PKCE required" });
        const code = `code-${randomBytes(6).toString("hex")}`;
        codes.set(code, { client: p.get("client_id"), challenge: p.get("code_challenge"), redirect: p.get("redirect_uri"), scope: p.get("scope") ?? "", resource: p.get("resource") });
        const to = new URL(p.get("redirect_uri"));
        to.searchParams.set("code", code);
        to.searchParams.set("state", p.get("state"));
        return res.writeHead(302, { location: to.href }).end();
      }
      case "/device": {
        const who = authenticate(req, form);
        if (who.error) return json(res, 401, { error: who.error });
        const code = `dev-${randomBytes(6).toString("hex")}`;
        devices.set(code, { client: who.id, scope: form.get("scope") ?? "", polls: 0, resource: form.get("resource") });
        return json(res, 200, { device_code: code, user_code: "WDJB-MJHT", verification_uri: `${base}/activate`, interval: 0, expires_in: 30 });
      }
      case "/token": {
        const who = authenticate(req, form);
        if (who.error) return json(res, 401, { error: who.error });
        const grant = form.get("grant_type");
        log.tokens.push({ grant, method: who.method, client: who.id, resource: form.get("resource"), scope: form.get("scope"), alg: who.alg });
        if (grant === "authorization_code") {
          const entry = codes.get(form.get("code"));
          codes.delete(form.get("code"));
          if (!entry || entry.client !== who.id || entry.redirect !== form.get("redirect_uri")) return json(res, 400, { error: "invalid_grant" });
          if (b64url(createHash("sha256").update(form.get("code_verifier") ?? "").digest()) !== entry.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
          return json(res, 200, issue(who.id, entry.scope, entry.resource));
        }
        if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
          log.devicePolls++;
          const entry = devices.get(form.get("device_code"));
          if (!entry) return json(res, 400, { error: "expired_token" });
          if (entry.polls++ < 2) return json(res, 400, { error: "authorization_pending" });
          devices.delete(form.get("device_code"));
          return json(res, 200, issue(who.id, entry.scope, entry.resource));
        }
        if (grant === "client_credentials") return json(res, 200, { ...issue(who.id, form.get("scope") ?? "", form.get("resource")), refresh_token: undefined });
        if (grant === "refresh_token") {
          const entry = refresh.get(form.get("refresh_token"));
          if (!entry) return json(res, 400, { error: "invalid_grant", error_description: "refresh token spent or unknown" });
          refresh.delete(form.get("refresh_token")); // single use: rotation
          return json(res, 200, issue(who.id, entry.scope, entry.resource));
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      case "/revoke": {
        const who = authenticate(req, form);
        if (who.error) return json(res, 401, { error: who.error });
        log.revoked.push(form.get("token"));
        access.delete(form.get("token"));
        refresh.delete(form.get("token"));
        return res.writeHead(200).end();
      }
      default:
        return res.writeHead(404).end();
    }
  });
  const port = await listen(server);
  base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    log,
    registered,
    /** The resource server's check: a live token with every scope the call needs. */
    check(authorization, needs = []) {
      const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
      const entry = token && access.get(token);
      if (!entry || entry.expires < Date.now()) return "invalid";
      const held = entry.scope.split(" ").filter(Boolean);
      return needs.every((s) => held.includes(s)) ? "ok" : "insufficient";
    },
    /** Expire every access token now, as if time passed. */
    expireAccess: () => access.forEach((entry) => (entry.expires = 0)),
    close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}

/** A Streamable HTTP server protected by `as`, advertising it the MCP way (RFC 9728). */
export async function protectedServer(as, { scope = "read" } = {}) {
  let base = "";
  const mcp = await streamableServer({
    guard(req, message) {
      const needs = message.method === "tools/call" && message.params?.name === "admin" ? ["admin"] : [];
      const verdict = as.check(req.headers.authorization, needs);
      if (verdict === "invalid") {
        return { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="${scope}"` } };
      }
      if (verdict === "insufficient") {
        return { status: 403, headers: { "www-authenticate": `Bearer error="insufficient_scope", scope="${scope} admin", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } };
      }
      return null;
    },
  });
  // The metadata document, on its own listener; the challenge names it absolutely.
  const metadata = createServer((req, res) => {
    if (req.url.startsWith("/.well-known/oauth-protected-resource")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ resource: mcp.url, authorization_servers: [as.url], scopes_supported: ["read", "admin"] }));
    }
    res.writeHead(404).end();
  });
  const port = await listen(metadata);
  base = `http://127.0.0.1:${port}`;
  return {
    url: mcp.url,
    log: mcp.log,
    close: async () => {
      await mcp.close();
      await new Promise((resolve) => (metadata.closeAllConnections?.(), metadata.close(resolve)));
    },
  };
}
