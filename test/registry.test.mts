// Discovery and preflight: what exists, what it needs, and whether this graph
// can run here. Offline — the registry and catalogue are both mocked.
import assert from "node:assert/strict";
import {
  describeServer,
  DiscoveryError,
  isRunnable,
  missingEnv,
  preflight,
  requirements,
  searchServers,
  searchSkills,
  toServerSpec,
  type RegistryServer,
} from "../src/index.ts";

function mock(status: number, body?: unknown) {
  const calls: string[] = [];
  const fetch = async (url: string | URL | Request): Promise<Response> => {
    calls.push(String(url));
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  };
  return Object.assign(fetch as unknown as typeof globalThis.fetch, { calls });
}

// The registry's real envelope: every published version, newest last.
const REGISTRY = {
  servers: [
    {
      server: {
        name: "io.github.acme/files",
        description: "Read and write files.",
        version: "1.0.0",
        packages: [
          { registryType: "npm", identifier: "@acme/files", version: "1.0.0", transport: { type: "stdio" }, environmentVariables: [] },
        ],
      },
    },
    {
      server: {
        name: "io.github.acme/files",
        description: "Read and write files.",
        version: "1.2.0",
        packages: [
          { registryType: "npm", identifier: "@acme/files", version: "1.2.0", transport: { type: "stdio" }, environmentVariables: [] },
        ],
      },
    },
    {
      server: {
        name: "com.scanner/github",
        description: "Scan GitHub orgs.",
        version: "1.0.0",
        packages: [
          {
            registryType: "npm",
            identifier: "@scanner/github",
            version: "1.0.0",
            transport: { type: "stdio" },
            environmentVariables: [
              { name: "APIFY_TOKEN", description: "From the Apify console.", isRequired: true, isSecret: true },
              { name: "SCAN_DEPTH", description: "How deep.", isRequired: false, isSecret: false },
            ],
          },
        ],
      },
    },
    {
      server: {
        name: "ai.hosted/remote-only",
        description: "A hosted server.",
        version: "2.0.0",
        remotes: [{ type: "streamable-http", url: "https://hosted.example/mcp" }],
      },
    },
  ],
};

// ── 1 · searching returns the LATEST of each name, not every version ────────
{
  const fetch = mock(200, REGISTRY);
  const servers = await searchServers("files", { fetch });

  assert.deepEqual(servers.map((s) => s.name), [
    "io.github.acme/files",
    "com.scanner/github",
    "ai.hosted/remote-only",
  ]);
  assert.equal(servers[0]!.version, "1.2.0", "four entries, three servers — the older 1.0.0 is dropped");
  assert.match(fetch.calls[0]!, /\/v0\/servers\?search=files&limit=50$/);
}
console.log("ok · 1 the registry is read and collapsed to one entry per server");

// ── 2 · requirements and what is still missing ─────────────────────────────
{
  const servers = await searchServers(undefined, { fetch: mock(200, REGISTRY) });
  const scanner = servers.find((s) => s.name === "com.scanner/github")!;

  assert.deepEqual(requirements(scanner).map((v) => v.name), ["APIFY_TOKEN", "SCAN_DEPTH"], "required first");
  assert.equal(requirements(scanner)[0]!.isSecret, true);

  assert.deepEqual(missingEnv(scanner, {}).map((v) => v.name), ["APIFY_TOKEN"]);
  assert.deepEqual(missingEnv(scanner, { APIFY_TOKEN: "x" }), [], "optional ones are never 'missing'");
  assert.deepEqual(missingEnv(servers.find((s) => s.name === "io.github.acme/files")!, {}), []);
}
console.log("ok · 2 required-vs-optional is honoured, so 'what must I set' has a real answer");

// ── 3 · an entry becomes an mcpServers spec, or honestly does not ──────────
{
  const servers = await searchServers(undefined, { fetch: mock(200, REGISTRY) });
  const files = servers.find((s) => s.name === "io.github.acme/files")!;
  const remote = servers.find((s) => s.name === "ai.hosted/remote-only")!;

  assert.deepEqual(toServerSpec(files), { command: "npx", args: ["-y", "@acme/files@1.2.0"] });
  assert.equal(toServerSpec(remote), undefined, "this client speaks stdio, so a remote server is not runnable");

  // and the description says so, rather than claiming it is ready
  assert.match(describeServer(remote), /remote only; this client speaks stdio/);
  assert.match(describeServer(files, {}), /✓ ready/);
  assert.match(describeServer(servers.find((s) => s.name === "com.scanner/github")!, {}), /⚠ needs APIFY_TOKEN/);

  assert.equal(isRunnable(files, {}), true);
  assert.equal(isRunnable(remote, {}), false);
  assert.equal(isRunnable(servers.find((s) => s.name === "com.scanner/github")!, {}), false);

  const pypi: RegistryServer = {
    name: "p",
    description: "d",
    version: "1",
    packages: [{ registryType: "pypi", identifier: "thing", version: "2.0", environmentVariables: [] }],
    remotes: [],
  };
  assert.deepEqual(toServerSpec(pypi), { command: "uvx", args: ["thing==2.0"] });
}
console.log("ok · 3 npm and pypi become commands; remote-only says so instead of pretending");

// ── 4 · a registry failure is an error; a skills-index failure is silence ───
{
  await assert.rejects(() => searchServers("x", { fetch: mock(503) }), (error: Error) => {
    assert.ok(error instanceof DiscoveryError);
    assert.match(error.message, /HTTP 503/);
    return true;
  });

  // the skills index is unofficial, so a failure means "no results", not a crash
  assert.deepEqual(await searchSkills("pdf", { fetch: mock(500) }), []);
  const listings = await searchSkills("pdf", {
    fetch: mock(200, { skills: [{ id: "anthropics/skills/pdf", name: "pdf", source: "anthropics/skills", installs: 197572 }] }),
  });
  assert.deepEqual(listings, [
    {
      id: "anthropics/skills/pdf",
      name: "pdf",
      source: "anthropics/skills",
      installs: 197572,
      url: "https://github.com/anthropics/skills/tree/HEAD/pdf",
    },
  ]);
}
console.log("ok · 4 the specified API errors; the unofficial one degrades to nothing");

// ── 5 · preflight catches what validate cannot: capability ─────────────────
{
  const cards = async () => [
    { id: "text/only", vision: false, draws: false, tools: true },
    { id: "sees/things", vision: true, draws: false, tools: true },
    { id: "makes/pictures", vision: true, draws: true, tools: false },
  ];
  const keys = { TYPESAFE_API_KEY: "k", OPENROUTER_API_KEY: "k" };

  const blind = await preflight(
    { name: "x", nodes: { look: { model: "text/only", sees: ["frame"], writes: ["scene"] } } },
    { catalog: cards, env: keys },
  );
  assert.ok(blind.problems.some((p) => /does not accept images/.test(p)), blind.problems.join("\n"));
  assert.ok(blind.problems.some((p) => /shortlist\(await catalog\(\), \{ vision: true \}\)/.test(p)), "it names the fix");

  const cannotDraw = await preflight(
    { name: "x", nodes: { make: { model: "sees/things", writes: ["caption", "art"] } } },
    { catalog: cards, env: keys },
  );
  assert.ok(cannotDraw.problems.some((p) => /does not return images/.test(p)));

  const fine = await preflight(
    {
      name: "x",
      nodes: {
        look: { model: "sees/things", sees: ["frame"], writes: ["scene"] },
        draw: { model: "makes/pictures", writes: ["cap", "art"] },
      },
    },
    { catalog: cards, env: keys },
  );
  assert.deepEqual(fine.problems, []);

  const unknown = await preflight(
    { name: "x", nodes: { n: { model: "ghost/model", prompt: "p", writes: ["o"] } } },
    { catalog: cards, env: keys },
  );
  assert.ok(unknown.problems.some((p) => /OpenRouter does not list/.test(p)));

  // a model chosen at run time cannot be checked, and says so rather than passing quietly
  const late = await preflight(
    { name: "x", nodes: { n: { model: { from: "picked" }, writes: ["o"] } } },
    { catalog: cards, env: keys },
  );
  assert.deepEqual(late.problems, []);
  assert.ok(late.notes.some((n) => /picks its model at run time/.test(n)));
}
console.log("ok · 5 preflight catches a text model asked to see, and a non-drawer asked to draw");

// ── 6 · preflight reports the environment a graph needs ────────────────────
{
  const cards = async () => [{ id: "m", vision: true, draws: true, tools: true }];
  const flight = await preflight(
    {
      name: "x",
      nodes: {
        judge: { decide: {}, reads: ["goal"] },
        write: { model: "m", writes: ["o"] },
        fetchIt: { mcp: { server: "fs", tool: "read" } },
      },
      mcpServers: { fs: {} },
      skills: [{ name: "pascal", path: "/p", description: "d", compatibility: "Requires the Pascal CLI" }],
    },
    { catalog: cards, env: { TYPESAFE_API_KEY: "k" } },
  );

  assert.deepEqual(flight.env, [
    { name: "TYPESAFE_API_KEY", why: "1 decide node", set: true },
    { name: "OPENROUTER_API_KEY", why: "1 model node", set: false },
  ]);
  assert.ok(flight.problems.some((p) => /OPENROUTER_API_KEY is not set — needed by 1 model node/.test(p)));
  assert.ok(flight.notes.some((n) => /starts MCP server "fs" as a local process/.test(n)));
  assert.ok(flight.notes.some((n) => /skill "pascal" requires: Requires the Pascal CLI/.test(n)));

  // Nothing here asks whether a model supports TOOL CALLING, and that is the
  // point: an mcp node makes the call itself, so a model that cannot call
  // tools still sits downstream of every tool you own.
  assert.ok(!flight.problems.some((p) => /tool calling/i.test(p)));
}
console.log("ok · 6 preflight reports required env vars and skill compatibility, never tool-calling");

console.log("6 cases");
