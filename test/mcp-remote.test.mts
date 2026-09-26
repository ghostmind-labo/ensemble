// Remote MCP: every transport, and every auth mode that is not OAuth, against
// real local sockets. OAuth has its own suite. Offline: every server is on
// 127.0.0.1, and the mTLS certificates are minted here with openssl.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, McpError, RunFailed, runner, validate, warnings, type RunnerSpec } from "../src/index.ts";
import { hostileLegacyServer, legacyServer, streamableServer, websocketServer } from "./fixtures/mcp-remote.mjs";

const roundTrip = async (session: Awaited<ReturnType<typeof connect>>): Promise<void> => {
  assert.deepEqual((await session.listTools()).map((t) => t.name), ["echo", "add", "admin", "hang"]);
  assert.equal((await session.call("echo", { text: "hi there" })).text, "hi there");
  const added = await session.call("add", { a: 2, b: 40 });
  assert.deepEqual(added.data, { sum: 42 });
  await assert.rejects(() => session.call("nope", {}), /no such tool/);
};

// ── 1 · Streamable HTTP, answered in JSON: session id, protocol header, DELETE ─
{
  const server = await streamableServer({ mode: "json" });
  const session = await connect("http", { url: server.url, transport: "streamable-http" });
  await roundTrip(session);

  const [first, ...later] = server.log.posts;
  assert.equal(first!.message.method, "initialize");
  assert.match(String(first!.headers["accept"]), /application\/json/);
  assert.match(String(first!.headers["accept"]), /text\/event-stream/);
  assert.equal(first!.headers["mcp-session-id"], undefined, "no session id before one is issued");
  const [sid] = [...server.log.sessions];
  for (const post of later) {
    assert.equal(post.headers["mcp-session-id"], sid, "the issued session id rides on every later request");
    assert.equal(post.headers["mcp-protocol-version"], "2025-06-18");
  }
  session.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(server.log.deleted, [sid], "closing DELETEs the session");
  await server.close();
}
console.log("ok · 1 Streamable HTTP with JSON replies: session id, protocol version, DELETE on close");

// ── 2 · Streamable HTTP, answered as an event stream with traffic in between ─
{
  const server = await streamableServer({ mode: "sse" });
  const session = await connect("http-sse", { url: server.url });
  await roundTrip(session);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(server.log.pings >= 1, "the server's ping, interleaved before the reply, was answered");
  session.close();
  await server.close();
}
console.log("ok · 2 Streamable HTTP with SSE replies: split events, notifications and a server ping");

// ── 3 · a stale session is re-initialized once, transparently ──────────────
{
  const server = await streamableServer();
  const session = await connect("stale", { url: server.url });
  await session.listTools();
  server.expireAll();
  assert.equal((await session.call("echo", { text: "again" })).text, "again");
  assert.equal(server.log.posts.filter((p) => p.message.method === "initialize").length, 2, "a 404 on the session means hello again");
  session.close();
  await server.close();
}
console.log("ok · 3 a 404 on a stale session re-initializes and retries");

// ── 4 · legacy HTTP+SSE, directly and by auto-detection ────────────────────
{
  const server = await legacyServer();
  const direct = await connect("legacy", { url: server.url, transport: "sse" });
  await roundTrip(direct);
  direct.close();

  const auto = await connect("legacy-auto", { url: server.url });
  await roundTrip(auto);
  auto.close();
  assert.equal(server.log.gets, 2, "auto POSTed, got 405, and fell back to GET");
  await server.close();

  const hostile = await hostileLegacyServer();
  await assert.rejects(() => connect("hostile", { url: hostile.url, transport: "sse", timeoutMs: 2000 }), /another origin/);
  await hostile.close();
}
console.log("ok · 4 legacy SSE works directly and by auto fallback; a cross-origin endpoint is refused");

// ── 5 · WebSocket: masked frames, a ping, a fragmented reply, headers ──────
{
  const server = await websocketServer({ requireHeader: { name: "x-team", value: "blue" } });
  const session = await connect("ws", { url: server.url, headers: { "x-team": "blue" } });
  await roundTrip(session);
  assert.ok(server.log.pongs >= 1, "the server's ping was ponged");
  assert.equal(server.log.headers[0]!["sec-websocket-protocol"], "mcp");
  session.close();

  await assert.rejects(() => connect("ws-refused", { url: server.url }), (error: Error) => {
    assert.ok(error instanceof McpError);
    assert.match(error.message, /401/);
    return true;
  });
  await server.close();
}
console.log("ok · 5 WebSocket over a hand-rolled handshake: headers, pong, fragments, and a refusal");

// ── 6 · static auth: headers, bearer, api_key (header and query), basic ────
{
  const expect = { authorization: "", key: "", query: "" };
  const server = await streamableServer({
    guard(req: { headers: Record<string, string> }, _message: unknown, url: URL) {
      if (expect.authorization && req.headers["authorization"] !== expect.authorization) return { status: 401, headers: { "www-authenticate": 'Basic realm="x"' } };
      if (expect.key && req.headers["x-api-key"] !== expect.key) return { status: 401 };
      if (expect.query && url.searchParams.get("api_key") !== expect.query) return { status: 401 };
      return null;
    },
  });
  const env = { TOKEN: "tok-123456", KEY: "key-abcdef", USER: "ann", PASS: "p4ss-word", TEAM: "blue" };
  const secretResolver = (name: string) => env[name as keyof typeof env];

  expect.authorization = "Bearer tok-123456";
  let s = await connect("bearer", { url: server.url, auth: { type: "bearer", token: "${TOKEN}" }, headers: { workspace: "${TEAM}" } }, { secretResolver });
  await s.listTools();
  s.close();
  assert.equal(server.log.posts.at(-1)!.headers["workspace"], "blue", "${NAME} in a header is resolved");

  expect.authorization = `Basic ${Buffer.from("ann:p4ss-word").toString("base64")}`;
  s = await connect("basic", { url: server.url, auth: { type: "basic", username: "${USER}", password: "${PASS}" } }, { secretResolver });
  await s.listTools();
  s.close();

  expect.authorization = "";
  expect.key = "key-abcdef";
  s = await connect("key-header", { url: server.url, auth: { type: "api_key", in: "header", name: "X-API-Key", value: "${KEY}" } }, { secretResolver });
  await s.listTools();
  s.close();

  expect.key = "";
  expect.query = "key-abcdef";
  s = await connect("key-query", { url: server.url, auth: [{ type: "headers" }, { type: "api_key", in: "query", name: "api_key", value: "${KEY}" }] }, { secretResolver });
  await s.listTools();
  s.close();

  // A wrong secret: the error says 401 and never the value.
  expect.query = "";
  expect.authorization = "Bearer right";
  await assert.rejects(
    () => connect("wrong", { url: server.url, auth: { type: "bearer", token: "${TOKEN}" } }, { secretResolver }),
    (error: Error) => {
      assert.match(error.message, /rejected the bearer token \(HTTP 401\)/);
      assert.ok(!error.message.includes("tok-123456"));
      return true;
    },
  );

  // A missing secret: named, before anything is sent.
  const before = server.log.posts.length;
  await assert.rejects(
    () => connect("unset", { url: server.url, auth: { type: "bearer", token: "${NOT_SET_ANYWHERE}" } }, { secretResolver }),
    /needs NOT_SET_ANYWHERE, which is not set/,
  );
  assert.equal(server.log.posts.length, before, "nothing was sent without the secret");
  await server.close();
}
console.log("ok · 6 headers, bearer, api_key in a header and in the query, basic — secrets resolved by name");

// ── 7 · custom: a provider mints headers, and is asked again after a 401 ───
{
  let accepted = "sig-1";
  const server = await streamableServer({
    guard: (req: { headers: Record<string, string> }) => (req.headers["x-signature"] === accepted ? null : { status: 401, headers: { "www-authenticate": 'Signed realm="x"' } }),
  });
  const calls: Array<string | undefined> = [];
  let n = 0;
  const provider = async (ctx: { url: string; server: string; challenge?: string; signal: AbortSignal }) => {
    calls.push(ctx.challenge);
    assert.equal(ctx.server, "signed");
    assert.ok(ctx.signal instanceof AbortSignal);
    return { "x-signature": `sig-${++n}` };
  };
  const session = await connect("signed", { url: server.url, auth: { type: "custom", provider } });
  await session.listTools();
  accepted = "sig-2"; // the server rotates what it accepts
  await session.listTools();
  assert.deepEqual(calls, [undefined, 'Signed realm="x"'], "asked once up front, then again with the challenge");
  session.close();
  await server.close();
}
console.log("ok · 7 a custom provider supplies headers and is re-asked with the 401 challenge");

// ── 8 · mTLS: a client certificate from a CA minted in this test ───────────
{
  const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" });
  if (openssl.status !== 0) {
    console.log("ok · 8 mTLS — SKIPPED: openssl is not installed here");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "ensemble-mtls-"));
    const run = (...args: string[]) => {
      const result = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=test-ca");
    for (const who of ["server", "client"]) {
      run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${who}.key`, "-out", `${who}.csr`, "-subj", `/CN=${who === "server" ? "127.0.0.1" : "ensemble-client"}`);
      writeFileSync(join(dir, `${who}.ext`), who === "server" ? "subjectAltName=IP:127.0.0.1\n" : "extendedKeyUsage=clientAuth\n");
      run("x509", "-req", "-in", `${who}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${who}.pem`, "-days", "1", "-extfile", `${who}.ext`);
    }
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    const server = await streamableServer({
      tls: { key: read("server.key"), cert: read("server.pem"), ca: read("ca.pem"), requestCert: true, rejectUnauthorized: true },
      guard: (req: { socket: { getPeerCertificate(): { subject?: { CN?: string } } } }) =>
        req.socket.getPeerCertificate().subject?.CN === "ensemble-client" ? null : { status: 403 },
    });

    const session = await connect("mtls", {
      url: server.url,
      auth: { type: "mtls", cert: join(dir, "client.pem"), key: join(dir, "client.key"), ca: join(dir, "ca.pem") },
    });
    await roundTrip(session);
    session.close();

    // Without the certificate the TLS handshake itself is refused.
    await assert.rejects(
      () => connect("no-cert", { url: server.url, auth: [{ type: "mtls", cert: join(dir, "ca.pem"), key: join(dir, "ca.key"), ca: join(dir, "ca.pem") }], timeoutMs: 3000 }),
      McpError,
    );
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    console.log("ok · 8 mTLS with a freshly minted CA: accepted with the client cert, refused without");
  }
}

// ── 9 · timeout and abort behave as stdio's do ─────────────────────────────
{
  const server = await streamableServer();
  const session = await connect("slow", { url: server.url, timeoutMs: 150 });
  const began = Date.now();
  await assert.rejects(() => session.call("hang", {}), /mcp "slow": tools\/call timed out after 150ms/);
  assert.ok(Date.now() - began < 3000);

  const controller = new AbortController();
  const patient = await connect("patient", { url: server.url, timeoutMs: 30_000 });
  const pending = patient.call("hang", {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(() => pending, /tools\/call was aborted/);
  session.close();
  patient.close();

  await assert.rejects(() => connect("nobody", { url: "http://127.0.0.1:1/mcp", timeoutMs: 2000 }), /could not reach http:\/\/127\.0\.0\.1:1\/mcp/);
  await server.close();
}
console.log("ok · 9 a hung call times out, an aborted one stops, an unreachable host says so");

// ── 10 · an mcp node over HTTP; secrets never reach run.json or events ─────
{
  const server = await streamableServer({
    guard: (req: { headers: Record<string, string> }) => (req.headers["authorization"] === "Bearer super-secret-token" ? null : { status: 401 }),
  });
  const spec: RunnerSpec = {
    name: "remote-node",
    inputs: ["goal"],
    mcpServers: { hosted: { url: server.url, auth: { type: "bearer", token: "${HOSTED_TOKEN}" } } },
    nodes: { say: { mcp: { server: "hosted", tool: "echo" }, args: (s) => ({ text: s["goal"] }), writes: ["said"] } },
    entry: "say",
  };
  const events: unknown[] = [];
  const flow = runner(spec);
  const { run, state } = await flow({ goal: "over the wire" }, { secretResolver: (n) => (n === "HOSTED_TOKEN" ? "super-secret-token" : undefined), onEvent: (e) => events.push(e) });
  assert.equal(run.run.status, "completed");
  assert.equal(state["said"], "over the wire");

  // Wrong secret: the run fails, and neither document nor event holds the value.
  const failed = (await flow({ goal: "x" }, { secretResolver: () => "wrong-secret-value", onEvent: (e) => events.push(e) }).catch((e: unknown) => e)) as RunFailed;
  assert.ok(failed instanceof RunFailed);
  assert.equal(failed.run.run.status, "failed");
  assert.ok(!failed.message.includes("wrong-secret-value"));
  const everything = JSON.stringify([run, failed.run, events, flow.graph()]);
  assert.ok(!everything.includes("super-secret-token"));
  assert.ok(!everything.includes("wrong-secret-value"));
  assert.match(JSON.stringify(failed.run), /rejected the bearer token/);
  await server.close();
}
console.log("ok · 10 an mcp node runs over HTTP; no secret appears in run.json, graph.json or events");

// ── 11 · validate: the Potion shape passes; bad specs name their fix ───────
{
  const base = {
    name: "v",
    inputs: ["goal"],
    nodes: { n: { mcp: { server: "potion", tool: "list_workspaces" }, writes: ["out"] } },
    entry: "n",
  };
  const potion: RunnerSpec = { ...base, mcpServers: { potion: { url: "https://mcp.potion.run", headers: { workspace: "home" }, auth: { type: "oauth" } } } };
  assert.deepEqual(validate(potion), []);
  assert.deepEqual(warnings(potion), []);
  assert.equal(runner(potion).graph().nodes.find((n) => n.id === "n")!.mcp!.server, "potion");

  const bad = (servers: RunnerSpec["mcpServers"]) => validate({ ...base, mcpServers: servers });
  assert.match(bad({ potion: {} as never }).join(), /needs a command \(a local process\) or a url/);
  assert.match(bad({ potion: { url: "nope" } }).join(), /not a url/);
  assert.match(bad({ potion: { url: "https://x", transport: "grpc" as never } }).join(), /use one of "auto"/);
  assert.match(bad({ potion: { url: "https://x", auth: { type: "oauth", grant: "client_credentials", clientId: "c" } } }).join(), /needs clientSecret/);
  assert.match(bad({ potion: { url: "http://x", auth: { type: "mtls", cert: "c", key: "k" } } }).join(), /needs an https:\/\/ or wss:\/\/ url/);
  assert.match(bad({ potion: { url: "https://x", auth: { type: "kerberos" } as never } }).join(), /auth type "kerberos"/);

  const literal: RunnerSpec = { ...base, mcpServers: { potion: { url: "http://remote.example/mcp", headers: { authorization: "Bearer abc" }, auth: { type: "basic", username: "u", password: "hunter22" } } } };
  assert.deepEqual(validate(literal), [], "a literal secret is a warning, not a problem");
  const found = warnings(literal).join("\n");
  assert.match(found, /literal secret in headers\["authorization"\]/);
  assert.match(found, /literal secret in auth \(basic\)\.password/);
  assert.match(found, /without TLS/);
  assert.ok(!found.includes("hunter22"), "the warning names the field, never the value");
}
console.log("ok · 11 validate accepts the Potion spec, refuses broken ones by name, warns on literal secrets");

console.log("11 cases");
