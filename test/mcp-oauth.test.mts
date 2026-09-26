// OAuth 2.1 for remote MCP, against a fake authorization server that checks
// what a real one checks: PKCE, the registered redirect, how the client
// authenticates, single-use refresh tokens, the resource indicator. Offline —
// every "browser" here is a fetch that follows the redirect to the loopback.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, fileTokenStore, login, loginStatus, logout, preflight, runner, RunFailed, type RemoteServerSpec } from "../src/index.ts";
import { authServer, protectedServer } from "./fixtures/mcp-remote.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "ensemble-oauth-"));
let stores = 0;
const freshStore = () => {
  const dir = join(scratch, `store-${++stores}`);
  return { dir, store: fileTokenStore(dir) };
};
/** The person: opens the page, the server redirects to the loopback. */
const browser = (opened: string[] = []) => async (url: string) => {
  opened.push(url);
  await fetch(url);
};
const quiet = () => {};

// ── 1 · discovery, dynamic registration, authorization code + PKCE ─────────
{
  const as = await authServer();
  const rs = await protectedServer(as);
  const { dir, store } = freshStore();
  const spec: RemoteServerSpec = { url: rs.url, auth: { type: "oauth" } };
  const opened: string[] = [];

  await login("potion", spec, { tokenStore: store, openBrowser: browser(opened), prompt: quiet });

  assert.equal(as.log.registrations.length, 1, "no client id given, so one was registered");
  assert.equal(as.log.registrations[0]!.body.token_endpoint_auth_method, "none", "a public client");
  assert.match(as.log.registrations[0]!.body.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const authorize = new URL(opened[0]!);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("resource"), rs.url, "RFC 8707: the token is for this server");
  assert.equal(authorize.searchParams.get("scope"), "read", "the scope the challenge asked for");
  assert.deepEqual(as.log.tokens.map((t: { grant: string; method: string }) => [t.grant, t.method]), [["authorization_code", "none"]]);

  // The login is a 0600 file in a 0700 directory, and connect uses it.
  const [file] = readdirSync(dir);
  assert.equal(file, "potion.json");
  assert.equal(statSync(join(dir, file!)).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);

  const session = await connect("potion", spec, { tokenStore: store });
  assert.equal((await session.call("echo", { text: "signed in" })).text, "signed in");
  session.close();

  // A second login reuses the registered client and its port.
  await login("potion", spec, { tokenStore: store, openBrowser: browser(), prompt: quiet });
  assert.equal(as.log.registrations.length, 1, "the registered client was kept and reused");
  await rs.close();
  await as.close();
}
console.log("ok · 1 401 → resource metadata → AS metadata → DCR → auth code with PKCE → 0600 store → connect");

// ── 2 · a registration that issues a secret keeps it, and uses it ─────────
{
  const as = await authServer({ issueSecret: true });
  const rs = await protectedServer(as);
  const { dir, store } = freshStore();
  const spec: RemoteServerSpec = { url: rs.url };

  // No auth written at all: the Bearer challenge is enough to mean OAuth.
  await login("implicit", spec, { tokenStore: store, openBrowser: browser(), prompt: quiet });
  const saved = JSON.parse(readFileSync(join(dir, "implicit.json"), "utf8"));
  assert.match(saved.client.secret, /^secret-/, "the issued secret is persisted with the client");
  assert.equal(as.log.tokens.at(-1).method, "client_secret_post", "and used the way registration said");
  const session = await connect("implicit", spec, { tokenStore: store });
  await session.listTools();
  session.close();
  await rs.close();
  await as.close();
}
console.log("ok · 2 DCR with an issued secret persists it and authenticates with it; no auth written means OAuth on a Bearer 401");

// ── 3 · the device grant, for a machine with no browser ────────────────────
{
  const as = await authServer();
  const rs = await protectedServer(as);
  const { store } = freshStore();
  const said: string[] = [];
  const spec: RemoteServerSpec = { url: rs.url, auth: { type: "oauth", grant: "device_code" } };
  await login("headless", spec, { tokenStore: store, prompt: (m) => said.push(m), openBrowser: () => assert.fail("no browser on a device login") });
  assert.match(said.join("\n"), /open http:\/\/127\.0\.0\.1:\d+\/activate\n\s+and enter the code: WDJB-MJHT/);
  assert.equal(as.log.devicePolls, 3, "polled through authorization_pending until approved");
  const session = await connect("headless", spec, { tokenStore: store });
  await session.listTools();
  session.close();
  await rs.close();
  await as.close();
}
console.log("ok · 3 device code: prints where and what to type, polls through pending, then works");

// ── 4 · client_credentials, with each way a client proves itself ──────────
{
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = (key: { export(o: object): string | Buffer }, type: "spki" | "pkcs8") => String(key.export({ type, format: "pem" }));
  const as = await authServer({
    dcr: false,
    clients: {
      "svc-basic": { secret: "basic-secret-value", redirectUris: [] },
      "svc-post": { secret: "post-secret-value", redirectUris: [] },
      "svc-rsa": { publicKey: pem(rsa.publicKey, "spki"), redirectUris: [] },
      "svc-ec": { publicKey: pem(ec.publicKey, "spki"), redirectUris: [] },
    },
  });
  const rs = await protectedServer(as);
  const secrets: Record<string, string> = { BASIC: "basic-secret-value", POST: "post-secret-value", RSA_KEY: pem(rsa.privateKey, "pkcs8"), EC_KEY: pem(ec.privateKey, "pkcs8") };
  const secretResolver = (n: string) => secrets[n];

  const cases: Array<[string, RemoteServerSpec["auth"], string, string?]> = [
    ["basic", { type: "oauth", grant: "client_credentials", clientId: "svc-basic", clientSecret: "${BASIC}" }, "client_secret_basic"],
    ["post", { type: "oauth", grant: "client_credentials", clientId: "svc-post", clientSecret: "${POST}", tokenEndpointAuth: "client_secret_post" }, "client_secret_post"],
    ["rsa", { type: "oauth", grant: "client_credentials", clientId: "svc-rsa", privateKey: "${RSA_KEY}" }, "private_key_jwt", "RS256"],
    ["ec", { type: "oauth", grant: "client_credentials", clientId: "svc-ec", privateKey: "${EC_KEY}", tokenEndpointAuth: "private_key_jwt" }, "private_key_jwt", "ES256"],
  ];
  for (const [name, auth, method, alg] of cases) {
    // No login step: a machine grants itself on connect.
    const session = await connect(name, { url: rs.url, auth }, { tokenStore: freshStore().store, secretResolver });
    await session.listTools();
    session.close();
    const used = as.log.tokens.at(-1);
    assert.equal(used.grant, "client_credentials");
    assert.equal(used.method, method, `${name} authenticated with ${method}`);
    if (alg) assert.equal(used.alg, alg);
    assert.equal(used.resource, rs.url);
  }

  // A wrong secret is refused, and the error does not carry it.
  await assert.rejects(
    () => connect("bad", { url: rs.url, auth: { type: "oauth", grant: "client_credentials", clientId: "svc-basic", clientSecret: "${BAD}" } }, { tokenStore: freshStore().store, secretResolver: () => "not-the-secret" }),
    (error: Error) => {
      assert.match(error.message, /client_credentials was refused: invalid_client/);
      assert.ok(!error.message.includes("not-the-secret"));
      return true;
    },
  );
  await rs.close();
  await as.close();
}
console.log("ok · 4 client_credentials with client_secret_basic, client_secret_post and private_key_jwt (RS256, ES256)");

// ── 5 · refresh before expiry, on 401, and rotation ────────────────────────
{
  const as = await authServer({ expiresIn: 1 });
  const rs = await protectedServer(as);
  const { dir, store } = freshStore();
  const spec: RemoteServerSpec = { url: rs.url, auth: { type: "oauth" } };
  await login("rotating", spec, { tokenStore: store, openBrowser: browser(), prompt: quiet });
  const first = JSON.parse(readFileSync(join(dir, "rotating.json"), "utf8")).tokens;

  await new Promise((r) => setTimeout(r, 900)); // inside the refresh margin, before expiry
  const session = await connect("rotating", spec, { tokenStore: store });
  await session.listTools();
  const second = JSON.parse(readFileSync(join(dir, "rotating.json"), "utf8")).tokens;
  assert.notEqual(second.access, first.access, "refreshed before it could expire in flight");
  assert.notEqual(second.refresh, first.refresh, "and the refresh token rotated");
  assert.ok(as.log.tokens.some((t: { grant: string }) => t.grant === "refresh_token"));

  // The server forgets the token early: a 401 mid-session refreshes and retries.
  as.expireAccess();
  const refreshes = as.log.tokens.filter((t: { grant: string }) => t.grant === "refresh_token").length;
  assert.equal((await session.call("echo", { text: "still here" })).text, "still here");
  assert.ok(as.log.tokens.filter((t: { grant: string }) => t.grant === "refresh_token").length > refreshes);
  session.close();
  await rs.close();
  await as.close();
}
console.log("ok · 5 tokens refresh before expiry and after a 401, and each refresh token is used once");

// ── 6 · step-up: 403 insufficient_scope asks again with more ───────────────
{
  const as = await authServer({ clients: { svc: { secret: "svc-secret-value", redirectUris: [] } } });
  const rs = await protectedServer(as);

  // A machine steps up on its own.
  const machine = await connect("svc", { url: rs.url, auth: { type: "oauth", grant: "client_credentials", clientId: "svc", clientSecret: "${S}", scopes: ["read"] } }, { tokenStore: freshStore().store, secretResolver: () => "svc-secret-value" });
  assert.equal((await machine.call("admin", {})).text, "admin ok");
  assert.equal(as.log.tokens.at(-1).scope, "read admin");
  machine.close();

  // A person's login cannot step up in a run: it says which scopes, and how.
  const { store } = freshStore();
  const spec: RemoteServerSpec = { url: rs.url, auth: { type: "oauth" } };
  await login("person", spec, { tokenStore: store, openBrowser: browser(), prompt: quiet });
  const session = await connect("person", spec, { tokenStore: store });
  await assert.rejects(() => session.call("admin", {}), /needs more access \(scopes: read admin\) — run: npx ensemble mcp login person --url/);
  session.close();

  // Interactively, it logs in again with the wider scope — and the next login remembers it.
  const opened: string[] = [];
  const interactive = await connect("person", spec, { tokenStore: store, interactive: true, openBrowser: browser(opened), prompt: quiet });
  assert.equal((await interactive.call("admin", {})).text, "admin ok");
  assert.equal(new URL(opened.at(-1)!).searchParams.get("scope"), "read admin");
  interactive.close();
  await rs.close();
  await as.close();
}
console.log("ok · 6 insufficient_scope: machines step up alone; people are told the scopes, or asked when present");

// ── 7 · logout revokes both tokens and forgets them ────────────────────────
{
  const as = await authServer();
  const rs = await protectedServer(as);
  const { dir, store } = freshStore();
  const spec: RemoteServerSpec = { url: rs.url, auth: { type: "oauth" } };
  await login("leaving", spec, { tokenStore: store, openBrowser: browser(), prompt: quiet });
  const tokens = JSON.parse(readFileSync(join(dir, "leaving.json"), "utf8")).tokens;
  assert.equal((await loginStatus("leaving", spec, { tokenStore: store })).loggedIn, true);

  const { revoked } = await logout("leaving", spec, { tokenStore: store });
  assert.equal(revoked, true);
  assert.deepEqual(as.log.revoked, [tokens.refresh, tokens.access], "refresh token first, then access");
  const after = JSON.parse(readFileSync(join(dir, "leaving.json"), "utf8"));
  assert.equal(after.tokens, undefined, "tokens gone; the registered client is kept for next time");
  assert.ok(after.client.id);
  assert.equal((await loginStatus("leaving", spec, { tokenStore: store })).loggedIn, false);
  await rs.close();
  await as.close();
}
console.log("ok · 7 logout revokes at the server (RFC 7009) and forgets the tokens");

// ── 8 · a run that needs a person fails fast, and never opens a browser ────
{
  const as = await authServer();
  const rs = await protectedServer(as);
  const { store } = freshStore();
  let opened = 0;
  const began = Date.now();
  await assert.rejects(
    () => connect("potion", { url: rs.url, headers: { workspace: "home" }, auth: { type: "oauth" } }, { tokenStore: store, openBrowser: () => void opened++ }),
    /mcp "potion": needs a login — run: npx ensemble mcp login potion --url http:\/\/127\.0\.0\.1:\d+\/mcp/,
  );
  // The implicit form (no auth written) says the same.
  await assert.rejects(() => connect("potion", { url: rs.url }, { tokenStore: store }), /needs a login — run: npx ensemble mcp login potion/);

  const flow = runner({
    name: "needs-login",
    inputs: ["goal"],
    mcpServers: { potion: { url: rs.url, auth: { type: "oauth" } } },
    nodes: { list: { mcp: { server: "potion", tool: "echo" }, args: { text: "x" }, writes: ["out"] } },
    entry: "list",
  });
  const failed = (await flow({}, { tokenStore: store }).catch((e: unknown) => e)) as RunFailed;
  assert.ok(failed instanceof RunFailed);
  assert.match(failed.run.steps[0]!.error!, /needs a login — run: npx ensemble mcp login potion/);
  assert.equal(opened, 0);
  assert.ok(Date.now() - began < 5000, "failed at once rather than waiting on a person");

  // And preflight says so before a run starts.
  const flight = await preflight(flow.spec, { tokenStore: store, env: { OPENROUTER_API_KEY: "x" } });
  assert.match(flight.problems.join("\n"), /MCP server "potion" needs a login — run: npx ensemble mcp login potion --url/);
  await rs.close();
  await as.close();
}
console.log("ok · 8 needing a login fails fast with the command, in connect, in a run, and in preflight");

// ── 9 · secrets by NAME in preflight; never a value anywhere ───────────────
{
  const flight = await preflight(
    {
      name: "x",
      nodes: { n: { mcp: { server: "hosted", tool: "t" }, writes: ["o"] } },
      mcpServers: { hosted: { url: "https://hosted.example/mcp", headers: { "x-team": "${TEAM_ID}" }, auth: { type: "bearer", token: "${HOSTED_TOKEN}" } } },
    },
    { env: { TEAM_ID: "blue" } },
  );
  assert.deepEqual(flight.env.map((e) => [e.name, e.set]), [["TEAM_ID", true], ["HOSTED_TOKEN", false]]);
  assert.match(flight.problems.join(), /HOSTED_TOKEN is not set — needed by MCP server "hosted"/);
  assert.match(flight.notes.join(), /reaches MCP server "hosted" at https:\/\/hosted\.example\/mcp \(auto, auth: bearer\)/);

  // Status reports a login's shape, never its tokens.
  const as = await authServer();
  const rs = await protectedServer(as);
  const { dir, store } = freshStore();
  const spec: RemoteServerSpec = { url: rs.url, auth: { type: "oauth" } };
  await login("quiet", spec, { tokenStore: store, openBrowser: browser(), prompt: quiet });
  const { access, refresh } = JSON.parse(readFileSync(join(dir, "quiet.json"), "utf8")).tokens;
  const status = JSON.stringify(await loginStatus("quiet", spec, { tokenStore: store }));
  assert.ok(!status.includes(access) && !status.includes(refresh));

  // A store entry for another url is never sent there.
  const elsewhere = await loginStatus("quiet", { url: "https://other.example/mcp", auth: { type: "oauth" } }, { tokenStore: store });
  assert.equal(elsewhere.loggedIn, false, "tokens are bound to the url they were issued for");
  await rs.close();
  await as.close();
}
console.log("ok · 9 preflight names secrets it needs; status never shows a token; tokens stay with their url");

// ── 10 · the CLI: status and logout, without printing a secret ─────────────
{
  const as = await authServer();
  const rs = await protectedServer(as);
  const dir = join(scratch, "cli-store");
  await login("potion", { url: rs.url, auth: { type: "oauth" } }, { tokenStore: fileTokenStore(dir), openBrowser: browser(), prompt: quiet });
  const { access } = JSON.parse(readFileSync(join(dir, "potion.json"), "utf8")).tokens;

  const file = join(scratch, "runner.mts");
  writeFileSync(
    file,
    `import { runner } from ${JSON.stringify(join(here, "..", "src", "index.ts"))};\n` +
      `export default runner({ name: "cli", inputs: ["goal"], mcpServers: { potion: { url: ${JSON.stringify(rs.url)}, headers: { workspace: "home" }, auth: { type: "oauth" } }, keyed: { url: "https://k.example/mcp", auth: { type: "bearer", token: "literal-token" } } },\n` +
      `  nodes: { n: { mcp: { server: "potion", tool: "echo" }, writes: ["o"] } }, entry: "n" });\n`,
  );
  // Async: the servers live in this process, and a blocking spawn would starve them.
  const cli = (...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(here, "..", "src", "cli.ts"), ...args], { env: { ...process.env, ENSEMBLE_MCP_TOKENS: dir } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

  const status = await cli("mcp", "status", file);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /potion\s+http:\/\/127\.0\.0\.1:\d+\/mcp\s+oauth\/authorization_code\s+logged in/);
  assert.match(status.stdout, /keyed\s+https:\/\/k\.example\/mcp\s+bearer\s+credentials from the spec/);
  assert.ok(!status.stdout.includes(access) && !status.stdout.includes("literal-token"));

  const validated = await cli("validate", file);
  assert.equal(validated.status, 0);
  assert.match(validated.stderr, /⚠ MCP server "keyed" has a literal secret in auth \(bearer\)\.token/);

  const out = await cli("mcp", "logout", "potion", file);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /logged out of "potion" — tokens revoked/);
  assert.match((await cli("mcp", "status", file)).stdout, /potion.+not logged in/);
  await rs.close();
  await as.close();
}
console.log("ok · 10 ensemble mcp status / logout from a runner file, never printing a secret");

rmSync(scratch, { recursive: true, force: true });
console.log("10 cases");
