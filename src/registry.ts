/**
 * Discovery — what capabilities exist, and what they need from you.
 *
 * Building a graph means knowing what is out there. Two catalogues answer that,
 * and this module reads both:
 *
 *   The **official MCP registry** (`registry.modelcontextprotocol.io`), which
 *   is documented, versioned and schema'd. Its entries carry the thing that
 *   makes automated setup possible at all: `environmentVariables`, each marked
 *   required or optional, secret or not. So "what would I have to set up to use
 *   this?" is a question with a real answer — see `missingEnv`.
 *
 *   The **Agent Skills** ecosystem, which since the format was opened as a
 *   standard has real directories behind it. `searchSkills` reads one of them.
 *
 *   The **ACP registry** (`cdn.agentclientprotocol.com`), one published JSON
 *   file listing the agents that speak the Agent Client Protocol and how each
 *   is launched. `searchAgents` reads it. (An A2A agent has no central list by
 *   design: it is found by its own card, which `agentCard` in `a2a.ts` reads.)
 *
 * A caveat stated rather than buried: the MCP registry is a specified API and
 * is treated as one. skills.sh is not — it is an undocumented endpoint behind a
 * website, and it may change or vanish without notice. It is here because
 * discovery is useful and the failure is harmless (you find no skills), but
 * nothing that RUNS depends on it. Installing is still a clone or a copy you
 * make deliberately, because a skill is instructions a model will follow, and
 * fetching those automatically from a public index is not something a library
 * should do quietly.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { isRemote, type McpServerSpec, type RemoteServerSpec } from "./mcp.ts";
import { authList, authMode, loginStatus, safeUrl, secretNames, templateNames, type SecretResolver } from "./mcp-auth.ts";
import { describeAgent, type A2aAgentSpec, type AcpAgentSpec, type AgentSpec } from "./agent.ts";
import type { AgentCard } from "./a2a.ts";

export const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io";
export const SKILLS_INDEX_URL = "https://skills.sh";
export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export interface EnvVarSpec {
  name: string;
  description?: string;
  isRequired: boolean;
  isSecret: boolean;
  format?: string;
}

export interface RegistryPackage {
  /** `npm`, `pypi`, `oci`, … */
  registryType: string;
  identifier: string;
  version?: string;
  transport?: { type: string };
  environmentVariables: EnvVarSpec[];
}

export interface RegistryRemote {
  /** `streamable-http` or `sse`. */
  type: string;
  url: string;
  /** Headers the server expects, each marked required or secret like an environment variable. */
  headers?: Array<{ name: string; description?: string; isRequired: boolean; isSecret: boolean; value?: string }>;
}

export interface RegistryServer {
  /** Reverse-DNS, e.g. `io.github.owner/server`. */
  name: string;
  title?: string;
  description: string;
  version: string;
  repository?: { url: string; source: string };
  packages: RegistryPackage[];
  remotes: RegistryRemote[];
}

export interface DiscoveryConfig {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class DiscoveryError extends Error {
  readonly status?: number;
  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "DiscoveryError";
    this.status = options.status;
  }
}

const envVar = (raw: Record<string, unknown>): EnvVarSpec => ({
  name: String(raw["name"] ?? ""),
  ...(raw["description"] ? { description: String(raw["description"]) } : {}),
  isRequired: raw["isRequired"] === true,
  isSecret: raw["isSecret"] === true,
  ...(raw["format"] ? { format: String(raw["format"]) } : {}),
});

const server = (raw: Record<string, unknown>): RegistryServer => ({
  name: String(raw["name"] ?? ""),
  ...(raw["title"] ? { title: String(raw["title"]) } : {}),
  description: String(raw["description"] ?? ""),
  version: String(raw["version"] ?? ""),
  ...(raw["repository"] ? { repository: raw["repository"] as RegistryServer["repository"] } : {}),
  packages: ((raw["packages"] as Array<Record<string, unknown>>) ?? []).map((pkg) => ({
    registryType: String(pkg["registryType"] ?? ""),
    identifier: String(pkg["identifier"] ?? ""),
    ...(pkg["version"] ? { version: String(pkg["version"]) } : {}),
    ...(pkg["transport"] ? { transport: pkg["transport"] as { type: string } } : {}),
    environmentVariables: ((pkg["environmentVariables"] as Array<Record<string, unknown>>) ?? []).map(envVar),
  })),
  remotes: ((raw["remotes"] as Array<Record<string, unknown>>) ?? []).map((remote) => ({
    type: String(remote["type"] ?? ""),
    url: String(remote["url"] ?? ""),
    ...(Array.isArray(remote["headers"]) && remote["headers"].length
      ? {
          headers: (remote["headers"] as Array<Record<string, unknown>>).map((h) => ({
            name: String(h["name"] ?? ""),
            ...(h["description"] ? { description: String(h["description"]) } : {}),
            isRequired: h["isRequired"] === true,
            isSecret: h["isSecret"] === true,
            ...(typeof h["value"] === "string" ? { value: h["value"] } : {}),
          })),
        }
      : {}),
  })),
});

/** The environment variable a remote header is filled from: `X-API-Key` → `X_API_KEY`. */
const headerEnv = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");

const REMOTE_TYPES: Record<string, RemoteServerSpec["transport"]> = { "streamable-http": "streamable-http", sse: "sse" };

const stdioPackage = (entry: RegistryServer, prefer = "npm"): RegistryPackage | undefined => {
  const usable = entry.packages.filter((pkg) => (pkg.transport?.type ?? "stdio") === "stdio");
  return usable.find((candidate) => candidate.registryType === prefer && KNOWN.has(candidate.registryType)) ??
    usable.find((candidate) => KNOWN.has(candidate.registryType));
};
const KNOWN = new Set(["npm", "pypi", "oci"]);
const remoteOf = (entry: RegistryServer): RegistryRemote | undefined =>
  entry.remotes.find((remote) => remote.type === "streamable-http") ?? entry.remotes.find((remote) => remote.type in REMOTE_TYPES);

/**
 * Search the official MCP registry.
 *
 * Returns only the latest version of each server name — the registry keeps
 * every published version, and a list with six copies of one server is not a
 * catalogue anyone can read.
 */
export async function searchServers(
  query?: string,
  config: DiscoveryConfig & { limit?: number } = {},
): Promise<RegistryServer[]> {
  const baseUrl = (config.baseUrl ?? MCP_REGISTRY_URL).replace(/\/+$/, "");
  const doFetch = config.fetch ?? globalThis.fetch;
  const url = new URL(`${baseUrl}/v0/servers`);
  if (query) url.searchParams.set("search", query);
  url.searchParams.set("limit", String(Math.min(config.limit ?? 50, 100)));

  let response: Response;
  try {
    response = await doFetch(url, { signal: AbortSignal.timeout(config.timeoutMs ?? 20_000) });
  } catch (cause) {
    throw new DiscoveryError(`could not reach the MCP registry: ${(cause as Error).message}`, { cause });
  }
  if (!response.ok) {
    throw new DiscoveryError(`MCP registry returned HTTP ${response.status}`, { status: response.status });
  }

  const payload = (await response.json()) as { servers?: Array<{ server?: Record<string, unknown> }> };
  const latest = new Map<string, RegistryServer>();
  for (const entry of payload.servers ?? []) {
    if (!entry?.server) continue;
    const parsed = server(entry.server);
    if (parsed.name) latest.set(parsed.name, parsed); // later pages are newer
  }
  return [...latest.values()];
}

/**
 * Every variable a server declares, required ones first — for the way this
 * client would reach it: a package's environment when it runs locally, the
 * headers a remote declares when it is reached over the network.
 */
export function requirements(entry: RegistryServer): EnvVarSpec[] {
  const all = new Map<string, EnvVarSpec>();
  if (stdioPackage(entry) || !remoteOf(entry)) {
    for (const pkg of entry.packages) for (const variable of pkg.environmentVariables) all.set(variable.name, variable);
  } else {
    for (const h of remoteOf(entry)!.headers ?? []) {
      const names = h.value ? [...h.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!) : [headerEnv(h.name)];
      for (const name of names) {
        all.set(name, {
          name,
          ...(h.description ? { description: h.description } : {}),
          isRequired: h.isRequired,
          isSecret: h.isSecret,
        });
      }
    }
  }
  return [...all.values()].sort((a, b) => Number(b.isRequired) - Number(a.isRequired) || a.name.localeCompare(b.name));
}

/**
 * What is still missing before this server could run.
 *
 * The question the whole registry exists to answer: "if I want this, what do I
 * have to set up?" Empty means ready.
 */
export function missingEnv(
  entry: RegistryServer,
  env: Record<string, string | undefined> = process.env,
): EnvVarSpec[] {
  return requirements(entry).filter((variable) => variable.isRequired && !env[variable.name]);
}

/**
 * Turn a registry entry into something `mcpServers` accepts.
 *
 * A stdio package becomes a local command, and is preferred when there is one:
 * it runs on your machine, under your control. Otherwise a declared remote
 * becomes a url, its headers filled from `${ENV}` so no secret is written
 * down. No auth is set: a server that wants OAuth says so with a 401, and the
 * client answers it. Undefined only when there is truly nothing to reach.
 */
export function toServerSpec(entry: RegistryServer, prefer = "npm"): McpServerSpec | undefined {
  const pkg = stdioPackage(entry, prefer);
  if (!pkg) {
    const remote = remoteOf(entry);
    if (!remote) return undefined;
    const headers: Record<string, string> = {};
    for (const h of remote.headers ?? []) {
      headers[h.name] = h.value ? h.value.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}") : `\${${headerEnv(h.name)}}`;
    }
    return {
      url: remote.url,
      transport: REMOTE_TYPES[remote.type]!,
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }

  const pinned = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
  switch (pkg.registryType) {
    case "npm":
      return { command: "npx", args: ["-y", pinned] };
    case "pypi":
      return { command: "uvx", args: [pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier] };
    case "oci":
      return { command: "docker", args: ["run", "-i", "--rm", pinned] };
    default:
      return undefined;
  }
}

/**
 * One entry, for a terminal or a report.
 *
 * "Ready" means *this client could reach it now*: a command it can start, or a
 * url it can speak to, with every required variable set. A hosted server may
 * still ask for a login when first reached — that is said, not hidden.
 */
export function describeServer(entry: RegistryServer, env?: Record<string, string | undefined>): string {
  const missing = missingEnv(entry, env);
  const spec = toServerSpec(entry);
  const how = !spec
    ? (entry.remotes[0]?.url ?? "no runnable package")
    : isRemote(spec)
      ? `${spec.url} (${spec.transport})`
      : `${spec.command} ${(spec.args ?? []).join(" ")}`;
  const status = !spec
    ? "  — no package or remote this client can use"
    : missing.length
      ? `  ⚠ needs ${missing.map((v) => v.name).join(", ")}`
      : isRemote(spec)
        ? "  ✓ ready (remote; it may ask for a login: ensemble mcp login)"
        : "  ✓ ready";
  return `${entry.name}@${entry.version}\n  ${entry.description}\n  ${how}${status}`;
}

/** Can this client start it, with the environment it has? */
export const isRunnable = (entry: RegistryServer, env?: Record<string, string | undefined>): boolean =>
  Boolean(toServerSpec(entry)) && missingEnv(entry, env).length === 0;

/* ─────────────────────────── agent skills index ─────────────────────────── */

export interface SkillListing {
  /** `owner/repo/path`, which is also where it lives on GitHub. */
  id: string;
  name: string;
  /** `owner/repo` the skill is published from. */
  source: string;
  installs?: number;
  /** Where to read it. Follows the id convention; verify before trusting it. */
  url: string;
}

/**
 * Search a public Agent Skills directory.
 *
 * **Unofficial.** Unlike the MCP registry this is not a specified API, so treat
 * a failure as "no results" rather than an error worth propagating, and do not
 * build anything load-bearing on the shape. It is here so that "what skills
 * exist for X?" has an answer while assembling a graph.
 */
export async function searchSkills(
  query: string,
  config: DiscoveryConfig = {},
): Promise<SkillListing[]> {
  const baseUrl = (config.baseUrl ?? SKILLS_INDEX_URL).replace(/\/+$/, "");
  const doFetch = config.fetch ?? globalThis.fetch;
  try {
    const response = await doFetch(`${baseUrl}/api/search?q=${encodeURIComponent(query)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { skills?: Array<Record<string, unknown>> };
    return (payload.skills ?? []).flatMap((raw) => {
      const id = String(raw["id"] ?? "");
      const source = String(raw["source"] ?? "");
      if (!id || !source) return [];
      const path = id.startsWith(`${source}/`) ? id.slice(source.length + 1) : id;
      return [
        {
          id,
          name: String(raw["name"] ?? path),
          source,
          ...(typeof raw["installs"] === "number" ? { installs: raw["installs"] } : {}),
          url: `https://github.com/${source}/tree/HEAD/${path}`,
        },
      ];
    });
  } catch {
    return [];
  }
}

/* ────────────────────────────── the ACP registry ─────────────────────────── */

export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  license?: string;
  /** How it is obtained: `npx`, `uvx`, `binary`. */
  distribution: string[];
  /** Present when a package manager can launch it as it stands. A binary must be installed first. */
  launch?: { command: string; args: string[] };
}

/**
 * Agents that speak ACP, from the protocol's own registry.
 *
 * The registry is one JSON file, so a search is a fetch and a filter. What it
 * answers is "which agents could an `acp` agent point at, and with what
 * command" — an entry distributed through npx or uvx can be launched as
 * written; one distributed as a binary has to be installed first, and says so.
 */
export async function searchAgents(query?: string, config: DiscoveryConfig & { limit?: number } = {}): Promise<RegistryAgent[]> {
  const doFetch = config.fetch ?? globalThis.fetch;
  const url = config.baseUrl ?? ACP_REGISTRY_URL;
  let payload: { agents?: Array<Record<string, unknown>> };
  try {
    const response = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(config.timeoutMs ?? 15_000) });
    if (!response.ok) throw new DiscoveryError(`the ACP registry returned HTTP ${response.status}`, { status: response.status });
    payload = (await response.json()) as typeof payload;
  } catch (cause) {
    if (cause instanceof DiscoveryError) throw cause;
    throw new DiscoveryError(`could not read the ACP registry at ${url}: ${(cause as Error).message}`, { cause });
  }
  const needle = (query ?? "").trim().toLowerCase();
  const out: RegistryAgent[] = [];
  for (const raw of payload.agents ?? []) {
    const distribution = (raw["distribution"] ?? {}) as Record<string, { package?: unknown; args?: unknown }>;
    const entry: RegistryAgent = {
      id: String(raw["id"] ?? ""),
      name: String(raw["name"] ?? ""),
      version: String(raw["version"] ?? ""),
      description: String(raw["description"] ?? ""),
      ...(raw["repository"] ? { repository: String(raw["repository"]) } : {}),
      ...(raw["website"] ? { website: String(raw["website"]) } : {}),
      ...(raw["license"] ? { license: String(raw["license"]) } : {}),
      distribution: Object.keys(distribution),
    };
    for (const [manager, command, flags] of [["npx", "npx", ["-y"]], ["uvx", "uvx", []]] as const) {
      const how = distribution[manager];
      if (entry.launch || !how || typeof how.package !== "string") continue;
      const extra = Array.isArray(how.args) ? how.args.filter((arg): arg is string => typeof arg === "string") : [];
      entry.launch = { command, args: [...flags, how.package, ...extra] };
    }
    if (!entry.id) continue;
    if (needle && !`${entry.id} ${entry.name} ${entry.description}`.toLowerCase().includes(needle)) continue;
    out.push(entry);
  }
  return out.slice(0, config.limit ?? 100);
}

/** A registry entry as an `agents` declaration, when it can be launched as it stands. */
export const toAgentSpec = (entry: RegistryAgent): AcpAgentSpec | undefined =>
  entry.launch ? { protocol: "acp", command: entry.launch.command, args: entry.launch.args } : undefined;

/* ──────────────────────────────── preflight ──────────────────────────────── */

/** Is a command launchable from here? A look along PATH, never a spawn. */
function onPath(command: string, path: string | undefined): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return (path ?? "").split(delimiter).some((dir) => dir && extensions.some((ext) => existsSync(join(dir, `${command}${ext}`))));
}

export interface Preflight {
  /** Hard problems: this graph cannot run as written, here. */
  problems: string[];
  /** Things worth knowing that are not necessarily wrong. */
  notes: string[];
  /** Environment variables this graph needs, and whether they are set. */
  env: Array<{ name: string; why: string; set: boolean }>;
}

/**
 * Can this graph actually run, on this machine, with these models?
 *
 * `validate` proves the things that are true offline and forever: every branch
 * wired, every key with an origin. This asks the other half, and it needs the
 * network to do it — *is the model you named able to do what the node asks of
 * it?*
 *
 * That question matters because a model being good is not the same as a model
 * being able. A `sees:` node pointed at a text-only model does not fail loudly;
 * it either errors deep inside a provider or quietly ignores the picture. The
 * catalogue knows which models see, which draw and which take tools, so this is
 * checkable — and much better checked before a run than during one.
 *
 * Note what is NOT checked, because it does not need to be: whether a model
 * supports tool calling. An `mcp` node makes the call itself and puts the
 * result on the blackboard, so a model with no tool-calling ability at all can
 * still sit downstream of every tool you own. Same for skills, which are
 * inlined as text. Capability constrains only what a model must do ITSELF.
 */
export async function preflight(
  spec: {
    name: string;
    nodes: Record<string, unknown>;
    skills?: Array<{ name: string; path: string; description: string; compatibility?: string }>;
    mcpServers?: Record<string, McpServerSpec>;
    agents?: Record<string, AgentSpec>;
  },
  config: DiscoveryConfig & {
    /** Reads an A2A agent's card. Default: the network. A test passes a stub. */
    card?: (name: string, agent: A2aAgentSpec) => Promise<AgentCard>;
    /** Is this command launchable here? Default: a look along PATH. */
    which?: (command: string) => boolean;
    catalog?: () => Promise<Array<{ id: string; vision: boolean; draws: boolean; tools: boolean }>>;
    env?: Record<string, string | undefined>;
    /** Checks `${NAME}`s in remote MCP servers — by name, never printing a value. Default: `env`. */
    secretResolver?: SecretResolver;
    /** Where OAuth logins are looked for. Default: the file store. */
    tokenStore?: import("./mcp-auth.ts").TokenStore;
  } = {},
): Promise<Preflight> {
  const problems: string[] = [];
  const notes: string[] = [];
  const env = config.env ?? process.env;
  const nodes = Object.entries(spec.nodes ?? {});

  const needs: Array<{ name: string; why: string; set: boolean }> = [];
  const need = (name: string, why: string): void => {
    if (!needs.some((entry) => entry.name === name)) needs.push({ name, why, set: Boolean(env[name]) });
  };

  const models = nodes.filter(([, node]) => node && typeof node === "object" && "model" in node);
  const decides = nodes.filter(([, node]) => node && typeof node === "object" && "decide" in node);
  const mcps = nodes.filter(([, node]) => node && typeof node === "object" && "mcp" in node);

  // One key for both: the decider reaches Jev through OpenRouter, the same
  // service every model node calls, so there is exactly one credential to name.
  const callers = [
    decides.length ? `${decides.length} decide node${decides.length === 1 ? "" : "s"}` : "",
    models.length ? `${models.length} model node${models.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  if (callers.length) need("OPENROUTER_API_KEY", callers.join(" and "));

  const secrets: Array<{ name: string; server: string; what?: string }> = [];
  const checked = new Set<string>();
  for (const [name, raw] of mcps) {
    const node = raw as { mcp: { server: string } };
    const server = (spec.mcpServers ?? {})[node.mcp.server];
    if (!server) continue;
    if (!isRemote(server)) {
      notes.push(`node "${name}" starts MCP server "${node.mcp.server}" as a local process`);
      continue;
    }
    notes.push(
      `node "${name}" reaches MCP server "${node.mcp.server}" at ${safeUrl(server.url)} ` +
        `(${server.transport ?? "auto"}, auth: ${authMode(server)})`,
    );
    if (checked.has(node.mcp.server)) continue;
    checked.add(node.mcp.server);
    for (const secret of secretNames(server)) secrets.push({ name: secret, server: node.mcp.server });
    const oauth = authList(server).find((auth) => auth.type === "oauth");
    const person = oauth && (oauth.grant ?? "authorization_code") !== "client_credentials" && oauth.grant !== "refresh_token";
    if (person) {
      const status = await loginStatus(node.mcp.server, server, config.tokenStore ? { tokenStore: config.tokenStore } : {}).catch(() => undefined);
      if (status && !status.loggedIn) {
        problems.push(
          `MCP server "${node.mcp.server}" needs a login — run: npx ensemble mcp login ${node.mcp.server} --url ${safeUrl(server.url)}`,
        );
      }
    }
  }

  // Agents: a card that can be read and spoken to, a command that exists, a
  // tool on a declared server. Checked once per agent, however many nodes use it.
  const delegating = nodes.filter(([, node]) => node && typeof node === "object" && "agent" in node);
  const seen = new Set<string>();
  for (const [name, raw] of delegating) {
    const key = String((raw as { agent: unknown }).agent);
    const agent = (spec.agents ?? {})[key];
    if (!agent || seen.has(key)) continue;
    seen.add(key);
    if (agent.protocol === "acp") {
      notes.push(
        `node "${name}" launches agent "${key}" as a local process over ACP (${describeAgent(agent)}); ` +
          `permission requests are answered "${typeof (agent.permissions ?? "reject") === "string" ? (agent.permissions ?? "reject") : `allow: ${(agent.permissions as { allow: string[] }).allow.join(", ")}`}"`,
      );
      for (const value of [...Object.values(agent.env ?? {}), ...(agent.args ?? [])]) {
        for (const secret of templateNames(value)) secrets.push({ name: secret, server: key, what: "agent" });
      }
      const found = config.which ? config.which(agent.command) : onPath(agent.command, env["PATH"]);
      if (!found) problems.push(`agent "${key}" runs "${agent.command}", which is not on PATH here — install it, or give the full path as command`);
      continue;
    }
    if (agent.protocol === "mcp") {
      notes.push(`node "${name}" reaches agent "${key}" as the MCP tool ${describeAgent(agent)}`);
      const server = (spec.mcpServers ?? {})[agent.server];
      if (server && isRemote(server)) for (const secret of secretNames(server)) secrets.push({ name: secret, server: agent.server });
      continue;
    }
    if (agent.protocol !== "a2a") continue;
    const remote = { url: agent.url, ...(agent.headers ? { headers: agent.headers } : {}), ...(agent.auth !== undefined ? { auth: agent.auth } : {}) };
    for (const secret of secretNames(remote)) secrets.push({ name: secret, server: key, what: "agent" });
    try {
      const card = config.card
        ? await config.card(key, agent)
        : await (await import("./a2a.ts")).agentCard(key, agent, {
            // The same environment the rest of this check reads, so `env` in a test or a host is honoured.
            secretResolver: config.secretResolver ?? ((secret) => env[secret]),
            ...(config.tokenStore ? { tokenStore: config.tokenStore } : {}),
          });
      const route = (await import("./a2a.ts")).chooseInterface(key, agent, card);
      notes.push(
        `node "${name}" delegates to agent "${key}" — "${card.name}"${card.version ? ` ${card.version}` : ""} at ${describeAgent(agent)} ` +
          `(A2A ${route.dialect}, ${route.binding}, ${card.streaming && agent.streaming !== false ? "streaming" : "polling"}, auth: ${authMode(remote)})`,
      );
      if (card.skills.length) notes.push(`agent "${key}" offers: ${card.skills.map((skill) => skill.name || skill.id).slice(0, 8).join(", ")}${card.skills.length > 8 ? ", …" : ""}`);
      if (card.security.length && agent.auth === undefined && !Object.keys(agent.headers ?? {}).length) {
        notes.push(
          `agent "${key}" declares security (${card.security.map((scheme) => `${scheme.name}: ${scheme.type}`).join(", ")}) and the runner gives it no auth — add auth to agents.${key} if calls are refused`,
        );
      }
    } catch (error) {
      const message = (error as Error).message;
      // A missing secret is reported once, by name, below — not as an unreachable agent.
      if (!/which (is|are) not set/.test(message)) problems.push(message);
    }
  }

  if (models.length) {
    let cards: Array<{ id: string; vision: boolean; draws: boolean; tools: boolean }>;
    try {
      cards = config.catalog
        ? await config.catalog()
        : ((await (await import("./openrouter.ts")).catalog(config)) as typeof cards);
    } catch (error) {
      notes.push(`could not read the model catalogue, so model capabilities were not checked: ${(error as Error).message}`);
      cards = [];
    }

    if (cards.length) {
      const byId = new Map(cards.map((card) => [card.id, card]));
      for (const [name, raw] of models) {
        const node = raw as { model: string | { from: string }; sees?: string[]; writes?: string[] };
        if (typeof node.model !== "string") {
          notes.push(`node "${name}" picks its model at run time, so its capabilities cannot be checked here`);
          continue;
        }
        const card = byId.get(node.model);
        if (!card) {
          problems.push(`node "${name}" names "${node.model}", which OpenRouter does not list — check the id`);
          continue;
        }
        if (node.sees?.length && !card.vision) {
          problems.push(
            `node "${name}" looks at ${node.sees.join(", ")} but "${node.model}" does not accept images. ` +
              `Pick a model whose card says vision — shortlist(await catalog(), { vision: true }).`,
          );
        }
        if ((node.writes ?? []).length > 1 && !card.draws) {
          problems.push(
            `node "${name}" declares writes [text, images] but "${node.model}" does not return images. ` +
              `Either drop the second key or use shortlist(await catalog(), { draws: true }).`,
          );
        }
      }
    }
  }

  for (const skill of spec.skills ?? []) {
    if (skill.compatibility) notes.push(`skill "${skill.name}" requires: ${skill.compatibility}`);
  }

  // A secret is reported by NAME, set or not, so a run never starts only to find one missing.
  for (const { name, server, what } of secrets) {
    const set = config.secretResolver ? Boolean(await config.secretResolver(name)) : Boolean(env[name]);
    const why = `${what ?? "MCP server"} "${server}"`;
    const existing = needs.find((entry) => entry.name === name);
    if (existing) {
      if (!existing.why.includes(why)) existing.why = `${existing.why} and ${why}`;
    } else needs.push({ name, why, set });
  }

  for (const entry of needs) {
    if (!entry.set) problems.push(`${entry.name} is not set — needed by ${entry.why}`);
  }

  return { problems, notes, env: needs };
}
