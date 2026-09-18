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
 * A caveat stated rather than buried: the MCP registry is a specified API and
 * is treated as one. skills.sh is not — it is an undocumented endpoint behind a
 * website, and it may change or vanish without notice. It is here because
 * discovery is useful and the failure is harmless (you find no skills), but
 * nothing that RUNS depends on it. Installing is still a clone or a copy you
 * make deliberately, because a skill is instructions a model will follow, and
 * fetching those automatically from a public index is not something a library
 * should do quietly.
 */
import type { McpServerSpec } from "./mcp.ts";

export const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io";
export const SKILLS_INDEX_URL = "https://skills.sh";

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
  type: string;
  url: string;
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
  remotes: ((raw["remotes"] as RegistryRemote[]) ?? []).map((remote) => ({
    type: String(remote.type ?? ""),
    url: String(remote.url ?? ""),
  })),
});

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

/** Every variable a server declares, required ones first. */
export function requirements(entry: RegistryServer): EnvVarSpec[] {
  const all = new Map<string, EnvVarSpec>();
  for (const pkg of entry.packages) for (const variable of pkg.environmentVariables) all.set(variable.name, variable);
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
 * Only stdio packages can become a local command; a remote-only server is
 * reachable over HTTP, which this client does not speak, so it returns
 * undefined rather than inventing something that would fail at run time.
 */
export function toServerSpec(entry: RegistryServer, prefer = "npm"): McpServerSpec | undefined {
  const usable = entry.packages.filter((pkg) => (pkg.transport?.type ?? "stdio") === "stdio");
  const pkg = usable.find((candidate) => candidate.registryType === prefer) ?? usable[0];
  if (!pkg) return undefined;

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
 * "Ready" means *this client could start it now*, which is narrower than the
 * registry's own notion: a remote-only server is perfectly real but speaks
 * HTTP, and the mcp node runs local stdio processes. Saying ready would be a
 * lie that only surfaces at run time.
 */
export function describeServer(entry: RegistryServer, env?: Record<string, string | undefined>): string {
  const missing = missingEnv(entry, env);
  const spec = toServerSpec(entry);
  const how = spec
    ? `${spec.command} ${(spec.args ?? []).join(" ")}`
    : (entry.remotes[0]?.url ?? "no runnable package");
  const status = !spec
    ? entry.remotes.length
      ? "  — remote only; this client speaks stdio"
      : "  — no stdio package"
    : missing.length
      ? `  ⚠ needs ${missing.map((v) => v.name).join(", ")}`
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

/* ──────────────────────────────── preflight ──────────────────────────────── */

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
    mcpServers?: Record<string, unknown>;
  },
  config: DiscoveryConfig & {
    catalog?: () => Promise<Array<{ id: string; vision: boolean; draws: boolean; tools: boolean }>>;
    env?: Record<string, string | undefined>;
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

  if (decides.length) need("TYPESAFE_API_KEY", `${decides.length} decide node${decides.length === 1 ? "" : "s"}`);
  if (models.length) need("OPENROUTER_API_KEY", `${models.length} model node${models.length === 1 ? "" : "s"}`);

  for (const [name, raw] of mcps) {
    const node = raw as { mcp: { server: string } };
    if (!(spec.mcpServers ?? {})[node.mcp.server]) continue;
    notes.push(`node "${name}" starts MCP server "${node.mcp.server}" as a local process`);
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

  for (const entry of needs) {
    if (!entry.set) problems.push(`${entry.name} is not set — needed by ${entry.why}`);
  }

  return { problems, notes, env: needs };
}
