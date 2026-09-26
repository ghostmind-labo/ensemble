/**
 * Auth for remote MCP — every way a server may ask who you are, and nowhere a
 * secret can leak.
 *
 * A local server inherits trust from the machine it runs on. A hosted one does
 * not, and hosted servers disagree about how to be asked: a static header, an
 * API key in the query, basic auth, a client certificate, a vendor's own SSO,
 * or OAuth 2.1 with discovery, dynamic registration, PKCE, device codes and
 * rotating refresh tokens. The MCP spec settles on OAuth; the servers people
 * actually run have not all read it. So all of them are here, behind one
 * question the transports ask — "what headers, what TLS, and what now that the
 * server said 401?" — and none of them leaks into anything a run writes down.
 *
 * Three rules shape the module:
 *
 *   A secret is written as `${NAME}` and resolved at connect time through a
 *   `SecretResolver` (the environment, by default; Vault, a keychain or a
 *   per-user store when an app mounts one). A literal secret in a runner file
 *   is a warning from `validate`, not a convenience.
 *
 *   Tokens live in a `TokenStore` — a 0600 file per server by default — and
 *   never in `run.json`, `graph.json`, an event or an error. Every error this
 *   module or the transports raise goes through `redact` first.
 *
 *   A run never waits on a person. When a login is needed and the caller did
 *   not say `interactive`, the connect fails at once and names the command
 *   that fixes it. Machines grant themselves (client credentials, a refresh
 *   token); people log in with `ensemble mcp login`.
 *
 * It also owns the one HTTP helper both it and the transports use, built on
 * `node:http`/`node:https` rather than `fetch`: global fetch cannot present a
 * client certificate without a dependency, and mTLS has to work on every path.
 */
import { createHash, createPrivateKey, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequestRaw, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequestRaw } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpError, type ConnectOptions, type RemoteServerSpec } from "./mcp.ts";

/* ───────────────────────────────── types ─────────────────────────────────── */

/** Turns a secret's NAME into its value. Default: `process.env`. */
export type SecretResolver = (name: string) => string | undefined | Promise<string | undefined>;

export type TokenEndpointAuth = "none" | "client_secret_basic" | "client_secret_post" | "private_key_jwt";

export interface OAuthConfig {
  type: "oauth";
  /**
   * How to get a token. `authorization_code` (the default) and `device_code`
   * need a person, once, through `ensemble mcp login`; `client_credentials` and
   * `refresh_token` are for machines and happen on their own.
   */
  grant?: "authorization_code" | "device_code" | "client_credentials" | "refresh_token";
  /** Omit to register dynamically (RFC 7591), when the server allows it. */
  clientId?: string;
  /** Required for confidential clients and client_credentials. */
  clientSecret?: string;
  tokenEndpointAuth?: TokenEndpointAuth;
  /** PEM, or a path to one — for private_key_jwt. */
  privateKey?: string;
  /** `kid` in the client assertion header, when the server needs it. */
  keyId?: string;
  scopes?: string[];
  audience?: string;
  /** RFC 8707 resource indicator. Default: the protected resource's own, else the server url. */
  resource?: string;
  /** Fixed loopback port for the redirect. Default: any free port. */
  redirectPort?: number;
  /** A directory to keep this server's login in, instead of the default store. */
  tokenStore?: string;
  /** For grant: "refresh_token" — a long-lived token issued out of band. */
  refreshToken?: string;
}

export interface McpAuthContext {
  url: string;
  server: string;
  /** The server's `WWW-Authenticate`, when asked again after a 401. */
  challenge?: string;
  signal: AbortSignal;
}

export type McpAuth =
  | { type: "none" }
  | { type: "headers" }
  | { type: "bearer"; token: string }
  | { type: "api_key"; in: "header" | "query"; name: string; value: string }
  | { type: "basic"; username: string; password: string }
  | OAuthConfig
  | { type: "mtls"; cert: string; key: string; ca?: string; passphrase?: string }
  | { type: "custom"; provider: (context: McpAuthContext) => Promise<Record<string, string>> };

/** What a login leaves behind. Holds secrets — lives only in a `TokenStore`. */
export interface StoredLogin {
  version: 1;
  server: string;
  /** The canonical server url these tokens are for. A store entry for a different url is ignored. */
  resource: string;
  /** The RFC 8707 resource indicator the tokens were granted for, when discovery named one. */
  indicator?: string;
  metadata?: AuthServerMetadata;
  client?: { id: string; secret?: string; method?: TokenEndpointAuth; redirectUri?: string; registered?: boolean };
  tokens?: { access: string; refresh?: string; type?: string; issuedAt?: number; expiresAt?: number; scope?: string };
  /** Scopes asked for, including any a step-up added. */
  scopes?: string[];
  updated: string;
}

export interface TokenStore {
  load(server: string): Promise<StoredLogin | undefined>;
  save(server: string, login: StoredLogin): Promise<void>;
  delete(server: string): Promise<void>;
  /** Server names with an entry, for `ensemble mcp status`. */
  list?(): Promise<string[]>;
}

export interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  device_authorization_endpoint?: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

/* ──────────────────────────────── secrets ────────────────────────────────── */

export const envSecrets: SecretResolver = (name) => process.env[name];

const TEMPLATE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The `${NAME}`s a string refers to. */
export const templateNames = (value: string): string[] => [...value.matchAll(TEMPLATE)].map((match) => match[1]!);

/** Every secret NAME a server spec needs, in the order written. */
export function secretNames(spec: RemoteServerSpec): string[] {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") for (const name of templateNames(value)) names.add(name);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(spec.headers);
  visit(spec.auth);
  return [...names];
}

const SECRET_HEADER = /authorization|token|secret|key|password|cookie|session/i;

/**
 * Secrets written inline rather than as `${NAME}` — a warning, because a
 * runner file gets committed, shared and pasted into chats.
 */
export function literalSecrets(server: string, spec: RemoteServerSpec): string[] {
  const found: string[] = [];
  const literal = (value: unknown): boolean => typeof value === "string" && value.length > 0 && templateNames(value).length === 0;
  const pem = (value: unknown): boolean => typeof value === "string" && value.includes("-----BEGIN");
  for (const [header, value] of Object.entries(spec.headers ?? {})) {
    if (SECRET_HEADER.test(header) && literal(value)) found.push(`headers["${header}"]`);
  }
  for (const auth of authList(spec)) {
    const at = (field: string) => `auth (${auth.type}).${field}`;
    if (auth.type === "bearer" && literal(auth.token)) found.push(at("token"));
    if (auth.type === "api_key" && literal(auth.value)) found.push(at("value"));
    if (auth.type === "basic" && literal(auth.password)) found.push(at("password"));
    if (auth.type === "oauth") {
      if (literal(auth.clientSecret)) found.push(at("clientSecret"));
      if (literal(auth.refreshToken)) found.push(at("refreshToken"));
      if (pem(auth.privateKey)) found.push(at("privateKey"));
    }
    if (auth.type === "mtls") {
      if (pem(auth.key)) found.push(at("key"));
      if (literal(auth.passphrase)) found.push(at("passphrase"));
    }
  }
  return found.map((where) => `MCP server "${server}" has a literal secret in ${where} — write it as "\${NAME}" and set NAME in the environment`);
}

export const authList = (spec: RemoteServerSpec): McpAuth[] =>
  spec.auth === undefined ? [] : Array.isArray(spec.auth) ? spec.auth : [spec.auth];

/** How a server authenticates, in words — never with a value. */
export function authMode(spec: RemoteServerSpec): string {
  const list = authList(spec);
  if (!list.length) return "none (OAuth if the server asks)";
  return list.map((auth) => (auth.type === "oauth" ? `oauth/${auth.grant ?? "authorization_code"}` : auth.type)).join(" + ");
}

/** Replaces the value of every secret it has seen with `***`. */
export class Redactor {
  #secrets = new Set<string>();
  add(value: string | undefined): void {
    if (value && value.length >= 4) this.#secrets.add(value);
  }
  redact = (text: string): string => {
    let out = text;
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join("***");
    return out;
  };
}

/** Where a url points, safely: no query (it may hold a key), no credentials. */
export const safeUrl = (url: string | URL): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "(invalid url)";
  }
};

/* ────────────────────────────────── http ─────────────────────────────────── */

export interface TlsOptions {
  cert?: string;
  key?: string;
  ca?: string;
  passphrase?: string;
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: IncomingMessage;
  text(): Promise<string>;
}

/** One HTTP request over node:http(s), so a client certificate can ride along. */
export function httpRequest(
  url: URL,
  init: { method?: string; headers?: Record<string, string>; body?: string; tls?: TlsOptions; signal?: AbortSignal },
): Promise<HttpResponse> {
  const send = url.protocol === "https:" ? httpsRequestRaw : httpRequestRaw;
  return new Promise((resolve, reject) => {
    const headers = { ...init.headers };
    if (init.body !== undefined) headers["content-length"] = String(Buffer.byteLength(init.body));
    const req = send(
      url,
      { method: init.method ?? "GET", headers, ...(url.protocol === "https:" ? (init.tls ?? {}) : {}), signal: init.signal },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
          text: async () => {
            res.setEncoding("utf8");
            let out = "";
            for await (const chunk of res) out += chunk;
            return out;
          },
        });
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value;
};

/** `Bearer realm="x", error="insufficient_scope", scope="a b"` → its params. */
export function parseChallenge(value: string | undefined): { scheme?: string; params: Record<string, string> } {
  if (!value) return { params: {} };
  const scheme = /^\s*([A-Za-z0-9_-]+)/.exec(value)?.[1];
  const params: Record<string, string> = {};
  for (const match of value.matchAll(/([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params[match[1]!.toLowerCase()] = (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return { ...(scheme ? { scheme } : {}), params };
}

/* ─────────────────────────────── token store ─────────────────────────────── */

export const DEFAULT_TOKEN_DIR = (): string =>
  process.env["ENSEMBLE_MCP_TOKENS"] || join(homedir(), ".ensemble", "mcp-tokens");

const fileName = (server: string): string => `${server.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;

/**
 * Logins as files: one per server, 0600, in a 0700 directory. Point one at a
 * directory per user to keep a hosted app's users apart.
 */
export function fileTokenStore(dir: string = DEFAULT_TOKEN_DIR()): TokenStore {
  return {
    async load(server) {
      try {
        const login = JSON.parse(await readFile(join(dir, fileName(server)), "utf8")) as StoredLogin;
        return login?.version === 1 ? login : undefined;
      } catch {
        return undefined;
      }
    },
    async save(server, login) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, fileName(server));
      const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, path);
    },
    async delete(server) {
      await rm(join(dir, fileName(server)), { force: true });
    },
    async list() {
      try {
        return (await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
      } catch {
        return [];
      }
    },
  };
}

/* ─────────────────────────────── authorizer ──────────────────────────────── */

/** What a transport asks of auth. */
export interface Authorizer {
  /** Headers for the next request: static ones, then credentials. */
  headers(): Promise<Record<string, string>>;
  /** The url with any query-string key applied. */
  url(base: URL): URL;
  tls: TlsOptions | undefined;
  /**
   * The server refused (401) or wanted more (403). Resolves true when the
   * request is worth sending again, throws an `McpError` saying what to do
   * when it is not.
   */
  challenge(status: number, wwwAuthenticate: string | undefined): Promise<boolean>;
  redact: (text: string) => string;
}

const pemOrPath = (value: string): string => (value.includes("-----BEGIN") ? value : readFileSync(value, "utf8"));

/** Resolve every `${NAME}` in a spec, failing with the names that are missing. */
async function resolveSecrets<T>(name: string, value: T, resolver: SecretResolver, redactor: Redactor): Promise<T> {
  const missing = new Set<string>();
  const walk = async (item: unknown): Promise<unknown> => {
    if (typeof item === "string") {
      let out = item;
      for (const key of templateNames(item)) {
        const secret = await resolver(key);
        if (secret === undefined || secret === "") missing.add(key);
        else {
          redactor.add(secret);
          out = out.split(`\${${key}}`).join(secret);
        }
      }
      return out;
    }
    if (typeof item === "function") return item;
    if (Array.isArray(item)) return Promise.all(item.map(walk));
    if (item && typeof item === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(item)) out[key] = await walk(inner);
      return out;
    }
    return item;
  };
  const resolved = (await walk(value)) as T;
  if (missing.size) {
    throw new McpError(name, `needs ${[...missing].join(", ")}, which ${missing.size === 1 ? "is" : "are"} not set`);
  }
  return resolved;
}

export async function authorizer(
  name: string,
  spec: RemoteServerSpec,
  options: ConnectOptions & { timeoutMs: number },
): Promise<Authorizer> {
  const redactor = new Redactor();
  const resolver = options.secretResolver ?? envSecrets;
  const headers = await resolveSecrets(name, spec.headers ?? {}, resolver, redactor);
  const list = await resolveSecrets(name, authList(spec), resolver, redactor);
  for (const [key, value] of Object.entries(headers)) if (SECRET_HEADER.test(key)) redactor.add(value);

  const credentials: Record<string, string> = {};
  const query: Array<[string, string]> = [];
  let tls: TlsOptions | undefined;
  let custom: Extract<McpAuth, { type: "custom" }> | undefined;
  let oauth: OAuth | undefined;
  let bearer = false;

  for (const auth of list) {
    switch (auth.type) {
      case "none":
      case "headers":
        break;
      case "bearer":
        credentials["authorization"] = `Bearer ${auth.token}`;
        bearer = true;
        break;
      case "basic": {
        const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
        redactor.add(encoded);
        credentials["authorization"] = `Basic ${encoded}`;
        break;
      }
      case "api_key":
        if (auth.in === "query") query.push([auth.name, auth.value]);
        else credentials[auth.name.toLowerCase()] = auth.value;
        break;
      case "mtls":
        try {
          tls = {
            cert: pemOrPath(auth.cert),
            key: pemOrPath(auth.key),
            ...(auth.ca ? { ca: pemOrPath(auth.ca) } : {}),
            ...(auth.passphrase ? { passphrase: auth.passphrase } : {}),
          };
        } catch (cause) {
          throw new McpError(name, `could not read the client certificate or key: ${(cause as Error).message}`);
        }
        break;
      case "custom":
        custom = auth;
        break;
      case "oauth":
        oauth = new OAuth(name, spec, auth, options, redactor);
        break;
      default:
        throw new McpError(name, `unknown auth type "${(auth as { type: string }).type}"`);
    }
  }
  // No auth written at all: the server may still negotiate OAuth on a 401.
  const implicit = list.length === 0;
  if (oauth) oauth.tls = tls;

  let customHeaders: Record<string, string> | undefined;
  const runCustom = async (challenge?: string): Promise<void> => {
    if (!custom) return;
    const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs);
    customHeaders = await custom.provider({ url: spec.url, server: name, ...(challenge ? { challenge } : {}), signal });
    for (const value of Object.values(customHeaders)) redactor.add(value);
  };

  const self: Authorizer = {
    tls,
    redact: redactor.redact,
    url(base) {
      const out = new URL(base);
      for (const [key, value] of query) out.searchParams.set(key, value);
      return out;
    },
    async headers() {
      if (custom && !customHeaders) await runCustom();
      const out: Record<string, string> = { ...headers, ...credentials, ...customHeaders };
      const token = oauth ? await oauth.accessToken() : undefined;
      if (token) out["authorization"] = `Bearer ${token}`;
      return out;
    },
    async challenge(status, wwwAuthenticate) {
      const parsed = parseChallenge(wwwAuthenticate);
      if (custom && status === 401) {
        await runCustom(wwwAuthenticate);
        return true;
      }
      if (!oauth && implicit && /^bearer$/i.test(parsed.scheme ?? "")) {
        oauth = new OAuth(name, spec, { type: "oauth" }, options, redactor);
        oauth.tls = tls;
      }
      if (oauth) return status === 403 ? oauth.forbidden(parsed) : oauth.unauthorized(parsed);
      throw new McpError(
        name,
        status === 403
          ? `the server refused access (HTTP 403)${parsed.params["error"] ? `: ${parsed.params["error"]}` : ""}`
          : bearer
            ? `the server rejected the bearer token (HTTP 401)`
            : `the server wants credentials (HTTP 401${parsed.scheme ? `, ${parsed.scheme}` : ""}) — add auth to its spec`,
      );
    },
  };
  return self;
}

/* ────────────────────────────────── oauth ────────────────────────────────── */

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const b64url = (buffer: Buffer): string => buffer.toString("base64url");

/** The resource a token is for: the server url, without query or fragment. */
export const canonicalResource = (url: string): string => {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.href.replace(/\/$/, "");
};

class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Parsed {
  scheme?: string;
  params: Record<string, string>;
}

/** One server's OAuth: discovery, registration, the grants, refresh and logout. */
export class OAuth {
  tls: TlsOptions | undefined;
  #login: StoredLogin | undefined;
  #loaded = false;
  #metadata: AuthServerMetadata | undefined;
  /** Identity of the store entry: the server url, fixed. */
  #key: string;
  /** What is sent as `resource`: configured, else the protected resource's own, else the url. */
  #resource: string;
  #scopes: string[] | undefined;
  #store: TokenStore;
  #refreshed = false;
  /** The scopes of the last step-up, so a server that keeps refusing is not asked forever. */
  #stepped: string | undefined;

  readonly server: string;
  readonly spec: RemoteServerSpec;
  readonly config: OAuthConfig;
  readonly options: ConnectOptions & { timeoutMs: number };
  readonly redactor: Redactor;

  constructor(
    server: string,
    spec: RemoteServerSpec,
    config: OAuthConfig,
    options: ConnectOptions & { timeoutMs: number },
    redactor: Redactor,
  ) {
    this.server = server;
    this.spec = spec;
    this.config = config;
    this.options = options;
    this.redactor = redactor;
    this.#key = canonicalResource(spec.url);
    this.#resource = config.resource ?? this.#key;
    this.#store = options.tokenStore ?? fileTokenStore(config.tokenStore);
    this.#scopes = config.scopes;
    redactor.add(config.clientSecret);
    redactor.add(config.refreshToken);
  }

  get grant(): NonNullable<OAuthConfig["grant"]> {
    return this.config.grant ?? "authorization_code";
  }

  #fail(message: string): McpError {
    return new McpError(this.server, this.redactor.redact(message));
  }

  #loginCommand(extra = ""): string {
    return `npx ensemble mcp login ${this.server} --url ${safeUrl(this.spec.url)}${extra}`;
  }

  async #load(): Promise<StoredLogin | undefined> {
    if (!this.#loaded) {
      this.#loaded = true;
      const stored = await this.#store.load(this.server);
      // Tokens issued for another url are not ours to send here.
      this.#login = stored && stored.resource === this.#key ? stored : undefined;
      if (this.#login?.indicator && !this.config.resource) this.#resource = this.#login.indicator;
      this.redactor.add(this.#login?.tokens?.access);
      this.redactor.add(this.#login?.tokens?.refresh);
      this.redactor.add(this.#login?.client?.secret);
      if (this.#login?.metadata) this.#metadata = this.#login.metadata;
      if (!this.#scopes && this.#login?.scopes?.length) this.#scopes = this.#login.scopes;
    }
    return this.#login;
  }

  async #save(update: Partial<StoredLogin>): Promise<void> {
    const current = await this.#load();
    this.#login = {
      version: 1,
      server: this.server,
      ...current,
      resource: this.#key,
      ...(this.#resource !== this.#key ? { indicator: this.#resource } : {}),
      ...(this.#metadata ? { metadata: this.#metadata } : {}),
      ...update,
      updated: new Date().toISOString(),
    };
    await this.#store.save(this.server, this.#login);
  }

  #signal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    return this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
  }

  async #getJson(url: string): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await httpRequest(new URL(url), {
        headers: { accept: "application/json", "mcp-protocol-version": "2025-06-18" },
        tls: this.tls,
        signal: this.#signal(),
      });
      const text = await response.text();
      if (response.status < 200 || response.status >= 300) return undefined;
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  /** Protected resource metadata (RFC 9728), then the authorization server's (RFC 8414 / OIDC). */
  async discover(challenge?: Parsed): Promise<AuthServerMetadata> {
    if (this.#metadata?.token_endpoint && !challenge?.params["resource_metadata"]) return this.#metadata;
    const url = new URL(this.spec.url);

    let challengeParams = challenge?.params;
    if (!challengeParams) {
      // Ask the server itself: an unauthenticated initialize earns a challenge naming its metadata.
      try {
        const probe = await httpRequest(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(await resolveSecrets(this.server, this.spec.headers ?? {}, this.options.secretResolver ?? envSecrets, this.redactor)),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ensemble", version: "2" } } }),
          tls: this.tls,
          signal: this.#signal(),
        });
        probe.body.resume();
        challengeParams = parseChallenge(header(probe.headers, "www-authenticate")).params;
      } catch {
        challengeParams = {};
      }
    }
    if (challengeParams["scope"] && !this.#scopes) this.#scopes = challengeParams["scope"].split(/\s+/).filter(Boolean);

    const path = url.pathname.replace(/\/$/, "");
    const prmCandidates = [
      challengeParams["resource_metadata"],
      path ? `${url.origin}/.well-known/oauth-protected-resource${path}` : undefined,
      `${url.origin}/.well-known/oauth-protected-resource`,
    ].filter((candidate): candidate is string => Boolean(candidate));
    let prm: Record<string, unknown> | undefined;
    for (const candidate of prmCandidates) {
      prm = await this.#getJson(candidate);
      if (prm) break;
    }

    let issuer = url.origin;
    if (prm) {
      const servers = prm["authorization_servers"];
      if (Array.isArray(servers) && typeof servers[0] === "string") issuer = servers[0];
      if (typeof prm["resource"] === "string" && !this.config.resource) this.#resource = canonicalResource(prm["resource"]);
      const supported = prm["scopes_supported"];
      if (!this.#scopes && Array.isArray(supported)) this.#scopes = supported.map(String);
    }

    const issuerUrl = new URL(issuer);
    const issuerPath = issuerUrl.pathname.replace(/\/$/, "");
    const asCandidates = issuerPath
      ? [
          `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
          `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
          `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`,
        ]
      : [`${issuerUrl.origin}/.well-known/oauth-authorization-server`, `${issuerUrl.origin}/.well-known/openid-configuration`];
    let metadata: AuthServerMetadata | undefined;
    for (const candidate of asCandidates) {
      const found = (await this.#getJson(candidate)) as AuthServerMetadata | undefined;
      if (found?.token_endpoint) {
        metadata = found;
        break;
      }
    }
    // The 2025-03-26 fallback: no metadata at all means the default paths at the origin.
    this.#metadata = metadata ?? {
      issuer: issuerUrl.origin,
      authorization_endpoint: `${issuerUrl.origin}/authorize`,
      token_endpoint: `${issuerUrl.origin}/token`,
      registration_endpoint: `${issuerUrl.origin}/register`,
    };
    return this.#metadata;
  }

  /* ── client identity ── */

  #method(client: { secret?: string; method?: TokenEndpointAuth }): TokenEndpointAuth {
    if (this.config.tokenEndpointAuth) return this.config.tokenEndpointAuth;
    if (client.method) return client.method;
    if (this.config.privateKey) return "private_key_jwt";
    if (!client.secret) return "none";
    const supported = this.#metadata?.token_endpoint_auth_methods_supported;
    return !supported || supported.includes("client_secret_basic") ? "client_secret_basic" : "client_secret_post";
  }

  async #client(redirectUri?: string): Promise<{ id: string; secret?: string; method: TokenEndpointAuth; redirectUri?: string }> {
    if (this.config.clientId) {
      const client = { id: this.config.clientId, ...(this.config.clientSecret ? { secret: this.config.clientSecret } : {}) };
      return { ...client, method: this.#method(client), ...(redirectUri ? { redirectUri } : {}) };
    }
    const stored = (await this.#load())?.client;
    if (stored && (!redirectUri || stored.redirectUri === redirectUri)) return { ...stored, method: this.#method(stored) };
    return this.#register(redirectUri);
  }

  /** Dynamic Client Registration (RFC 7591). The client — and its secret, if issued — is kept. */
  async #register(redirectUri?: string): Promise<{ id: string; secret?: string; method: TokenEndpointAuth; redirectUri?: string }> {
    const metadata = await this.discover();
    if (!metadata.registration_endpoint) {
      throw this.#fail(`the authorization server does not allow dynamic client registration — set auth.clientId (and clientSecret if it is confidential)`);
    }
    const wanted =
      this.grant === "client_credentials"
        ? ["client_credentials"]
        : ["authorization_code", "refresh_token", DEVICE_GRANT];
    const grants = metadata.grant_types_supported ? wanted.filter((g) => metadata.grant_types_supported!.includes(g)) : wanted;
    const body = {
      client_name: "ensemble",
      grant_types: grants.length ? grants : wanted,
      ...(redirectUri ? { redirect_uris: [redirectUri], response_types: ["code"] } : {}),
      token_endpoint_auth_method: this.grant === "client_credentials" ? "client_secret_basic" : "none",
      ...(this.#scopes?.length ? { scope: this.#scopes.join(" ") } : {}),
    };
    const response = await httpRequest(new URL(metadata.registration_endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      tls: this.tls,
      signal: this.#signal(),
    });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw this.#fail(`client registration failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    const issued = JSON.parse(text) as { client_id?: string; client_secret?: string; token_endpoint_auth_method?: string };
    if (!issued.client_id) throw this.#fail("client registration returned no client_id");
    this.redactor.add(issued.client_secret);
    const known = ["none", "client_secret_basic", "client_secret_post", "private_key_jwt"];
    const client = {
      id: issued.client_id,
      ...(issued.client_secret ? { secret: issued.client_secret } : {}),
      ...(issued.token_endpoint_auth_method && known.includes(issued.token_endpoint_auth_method)
        ? { method: issued.token_endpoint_auth_method as TokenEndpointAuth }
        : {}),
      ...(redirectUri ? { redirectUri } : {}),
      registered: true,
    };
    await this.#save({ client });
    return { ...client, method: this.#method(client) };
  }

  /** Client authentication at an endpoint, in whichever of the four forms applies. */
  #authenticate(
    client: { id: string; secret?: string; method: TokenEndpointAuth },
    params: URLSearchParams,
    headers: Record<string, string>,
    audience: string,
  ): void {
    switch (client.method) {
      case "client_secret_basic":
        if (!client.secret) throw this.#fail("client_secret_basic needs auth.clientSecret");
        headers["authorization"] = `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString("base64")}`;
        this.redactor.add(headers["authorization"].slice(6));
        break;
      case "client_secret_post":
        if (!client.secret) throw this.#fail("client_secret_post needs auth.clientSecret");
        params.set("client_id", client.id);
        params.set("client_secret", client.secret);
        break;
      case "private_key_jwt":
        params.set("client_id", client.id);
        params.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
        params.set("client_assertion", this.#assertion(client.id, audience));
        break;
      default:
        params.set("client_id", client.id);
    }
  }

  /** A signed client assertion (RFC 7523) for private_key_jwt. */
  #assertion(clientId: string, audience: string): string {
    if (!this.config.privateKey) throw this.#fail("private_key_jwt needs auth.privateKey (a PEM, or a path to one)");
    let key: KeyObject;
    try {
      key = createPrivateKey(pemOrPath(this.config.privateKey));
    } catch (cause) {
      throw this.#fail(`could not read auth.privateKey: ${(cause as Error).message}`);
    }
    const type = key.asymmetricKeyType;
    const curve = key.asymmetricKeyDetails?.namedCurve;
    const [alg, digest, encoding] =
      type === "rsa" || type === "rsa-pss"
        ? (["RS256", "sha256", undefined] as const)
        : type === "ec"
          ? curve === "secp384r1"
            ? (["ES384", "sha384", "ieee-p1363"] as const)
            : (["ES256", "sha256", "ieee-p1363"] as const)
          : type === "ed25519"
            ? (["EdDSA", null, undefined] as const)
            : (() => {
                throw this.#fail(`auth.privateKey is a ${type} key — use RSA, EC or Ed25519`);
              })();
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(Buffer.from(JSON.stringify({ alg, typ: "JWT", ...(this.config.keyId ? { kid: this.config.keyId } : {}) })));
    const claims = b64url(
      Buffer.from(JSON.stringify({ iss: clientId, sub: clientId, aud: audience, jti: randomUUID(), iat: now, exp: now + 300 })),
    );
    const input = Buffer.from(`${head}.${claims}`);
    const signature = sign(digest, input, encoding ? { key, dsaEncoding: encoding } : key);
    return `${head}.${claims}.${b64url(signature)}`;
  }

  /** POST a form to the token endpoint (or any OAuth endpoint), with client auth. */
  async #post(endpoint: string, params: URLSearchParams, client: { id: string; secret?: string; method: TokenEndpointAuth }): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    this.#authenticate(client, params, headers, endpoint);
    const response = await httpRequest(new URL(endpoint), { method: "POST", headers, body: params.toString(), tls: this.tls, signal: this.#signal() });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    if (response.status < 200 || response.status >= 300) {
      const code = String(payload["error"] ?? `http_${response.status}`);
      const description = payload["error_description"] ? `: ${String(payload["error_description"])}` : "";
      throw new OAuthError(code, this.redactor.redact(`${code}${description}`));
    }
    return payload;
  }

  #common(params: URLSearchParams, scopes = this.#scopes): URLSearchParams {
    if (scopes?.length) params.set("scope", scopes.join(" "));
    params.set("resource", this.#resource);
    if (this.config.audience) params.set("audience", this.config.audience);
    return params;
  }

  async #keep(payload: Record<string, unknown>, scopes = this.#scopes): Promise<string> {
    const access = payload["access_token"];
    if (typeof access !== "string" || !access) throw this.#fail("the token endpoint returned no access_token");
    const refresh = typeof payload["refresh_token"] === "string" ? payload["refresh_token"] : undefined;
    const expiresIn = Number(payload["expires_in"]);
    this.redactor.add(access);
    this.redactor.add(refresh);
    const previous = this.#login?.tokens;
    await this.#save({
      tokens: {
        access,
        // Rotation: a new refresh token replaces the old; none returned keeps it.
        ...(refresh ? { refresh } : previous?.refresh ? { refresh: previous.refresh } : {}),
        type: String(payload["token_type"] ?? "Bearer"),
        issuedAt: Date.now(),
        ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
        ...(typeof payload["scope"] === "string" ? { scope: payload["scope"] } : {}),
      },
      ...(scopes?.length ? { scopes } : {}),
    });
    return access;
  }

  /* ── grants ── */

  async #clientCredentials(scopes = this.#scopes): Promise<string> {
    const metadata = await this.discover();
    const client = await this.#client();
    const params = this.#common(new URLSearchParams({ grant_type: "client_credentials" }), scopes);
    try {
      return await this.#keep(await this.#post(metadata.token_endpoint!, params, client), scopes);
    } catch (error) {
      throw error instanceof OAuthError ? this.#fail(`client_credentials was refused: ${error.message}`) : error;
    }
  }

  async #refresh(token: string): Promise<string | undefined> {
    const metadata = await this.discover();
    const client = await this.#client();
    const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: token });
    params.set("resource", this.#resource);
    try {
      return await this.#keep(await this.#post(metadata.token_endpoint!, params, client));
    } catch (error) {
      if (error instanceof OAuthError) {
        // The refresh token is spent or revoked: forget the tokens, keep the client.
        await this.#save({ tokens: undefined });
        return undefined;
      }
      throw error;
    }
  }

  /** A usable access token, if one can be had without a person. */
  async accessToken(): Promise<string | undefined> {
    const login = await this.#load();
    const tokens = login?.tokens;
    if (tokens?.access && fresh(tokens)) return tokens.access;
    if (tokens?.refresh) {
      const fresh = await this.#refresh(tokens.refresh);
      if (fresh) return fresh;
    }
    if (this.grant === "client_credentials") return this.#clientCredentials();
    if (this.grant === "refresh_token" && this.config.refreshToken && !this.#refreshed) {
      this.#refreshed = true;
      const fresh = await this.#refresh(this.config.refreshToken);
      if (!fresh) throw this.#fail("the configured refresh token was refused — issue a new one");
      return fresh;
    }
    return tokens?.access;
  }

  #needsLogin(why: string, extra = ""): McpError {
    return this.#fail(`${why} — run: ${this.#loginCommand(extra)}`);
  }

  async unauthorized(challenge: Parsed): Promise<boolean> {
    await this.discover(challenge);
    const login = await this.#load();
    if (login?.tokens?.refresh) {
      if (await this.#refresh(login.tokens.refresh)) return true;
    } else if (login?.tokens) {
      await this.#save({ tokens: undefined });
    }
    if (this.grant === "client_credentials") {
      await this.#clientCredentials();
      return true;
    }
    if (this.options.interactive) {
      await this.login({ device: this.options.device ?? this.grant === "device_code" });
      return true;
    }
    throw this.#needsLogin(login?.tokens ? "the login has expired" : "needs a login");
  }

  /** 403 insufficient_scope: ask again for the scopes held plus the ones demanded. */
  async forbidden(challenge: Parsed): Promise<boolean> {
    if (challenge.params["error"] !== "insufficient_scope") {
      throw this.#fail(`the server refused access (HTTP 403)${challenge.params["error"] ? `: ${challenge.params["error"]}` : ""}`);
    }
    const wanted = (challenge.params["scope"] ?? "").split(/\s+/).filter(Boolean);
    // What the token was GRANTED decides; what was once asked for only adds to the request.
    const granted = (await this.#load())?.tokens?.scope?.split(/\s+/).filter(Boolean) ?? [];
    const scopes = [...new Set([...(this.#scopes ?? []), ...granted, ...wanted])];
    const key = [...wanted].sort().join(" ");
    if (this.#stepped === key) throw this.#fail(`the server still refuses with scopes ${scopes.join(" ")} (insufficient_scope)`);
    this.#stepped = key;
    this.#scopes = scopes;
    await this.#save({ scopes });
    if (this.grant === "client_credentials") {
      await this.#clientCredentials(scopes);
      return true;
    }
    if (this.options.interactive) {
      await this.login({ device: this.options.device ?? this.grant === "device_code" });
      return true;
    }
    throw this.#needsLogin(`needs more access (scopes: ${scopes.join(" ")})`);
  }

  /**
   * Log in now — a person is present. The browser flow by default, the device
   * flow when asked (a headless box, an SSH session), or the machine grants.
   */
  async login(config: { device?: boolean } = {}): Promise<void> {
    const metadata = await this.discover();
    await this.#load();
    const device = config.device ?? this.grant === "device_code";
    if (this.grant === "client_credentials") {
      await this.#clientCredentials();
      return;
    }
    if (this.grant === "refresh_token" && this.config.refreshToken) {
      if (!(await this.#refresh(this.config.refreshToken))) throw this.#fail("the configured refresh token was refused");
      return;
    }
    if (device) await this.#deviceFlow(metadata);
    else await this.#browserFlow(metadata);
  }

  #say(message: string): void {
    (this.options.prompt ?? ((text: string) => process.stderr.write(`${text}\n`)))(message);
  }

  async #browserFlow(metadata: AuthServerMetadata): Promise<void> {
    if (!metadata.authorization_endpoint) throw this.#fail("the authorization server has no authorization endpoint — try --device");
    const methods = metadata.code_challenge_methods_supported;
    if (methods && !methods.includes("S256")) throw this.#fail("the authorization server does not support PKCE with S256, so a login would not be safe");

    const storedPort = (() => {
      const uri = this.#login?.client?.redirectUri;
      return uri ? Number(new URL(uri).port) : undefined;
    })();
    // A remembered port may be taken now; a new one means registering again, which #client handles.
    const callback = this.config.redirectPort
      ? await loopback(this.config.redirectPort)
      : await loopback(storedPort ?? 0).catch(() => loopback(0));
    try {
      const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
      const client = await this.#client(redirectUri);
      const verifier = b64url(randomBytes(32));
      const state = b64url(randomBytes(16));
      const authorize = new URL(metadata.authorization_endpoint);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", client.id);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("state", state);
      if (this.#scopes?.length) authorize.searchParams.set("scope", this.#scopes.join(" "));
      authorize.searchParams.set("resource", this.#resource);
      if (this.config.audience) authorize.searchParams.set("audience", this.config.audience);

      this.#say(`To sign in to MCP server "${this.server}", open:\n  ${authorize.href}`);
      await (this.options.openBrowser ?? openBrowser)(authorize.href);
      const reply = await callback.wait(this.options.signal);
      if (reply.get("state") !== state) throw this.#fail("the login reply had the wrong state — it may not be yours; try again");
      if (reply.get("error")) throw this.#fail(`the login was refused: ${reply.get("error")}${reply.get("error_description") ? ` (${reply.get("error_description")})` : ""}`);
      const code = reply.get("code");
      if (!code) throw this.#fail("the login reply carried no code");

      const params = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
      params.set("resource", this.#resource);
      try {
        await this.#keep(await this.#post(metadata.token_endpoint!, params, client));
      } catch (error) {
        throw error instanceof OAuthError ? this.#fail(`the code exchange was refused: ${error.message}`) : error;
      }
    } finally {
      callback.close();
    }
  }

  async #deviceFlow(metadata: AuthServerMetadata): Promise<void> {
    if (!metadata.device_authorization_endpoint) throw this.#fail("the authorization server does not offer device login — drop --device");
    const client = await this.#client();
    let start: Record<string, unknown>;
    try {
      start = await this.#post(metadata.device_authorization_endpoint, this.#common(new URLSearchParams()), client);
    } catch (error) {
      throw error instanceof OAuthError ? this.#fail(`device login was refused: ${error.message}`) : error;
    }
    const deviceCode = String(start["device_code"] ?? "");
    if (!deviceCode) throw this.#fail("device login returned no device_code");
    this.redactor.add(deviceCode);
    const where = String(start["verification_uri_complete"] ?? start["verification_uri"] ?? "");
    this.#say(`To sign in to MCP server "${this.server}", open ${where}${start["user_code"] ? `\n  and enter the code: ${String(start["user_code"])}` : ""}`);

    let interval = Math.max(0, Number(start["interval"] ?? 5)) * 1000;
    const deadline = Date.now() + Math.max(1, Number(start["expires_in"] ?? 600)) * 1000;
    while (Date.now() < deadline) {
      await delay(interval, this.options.signal);
      const params = new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: deviceCode });
      params.set("resource", this.#resource);
      try {
        await this.#keep(await this.#post(metadata.token_endpoint!, params, client));
        return;
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        if (error.code === "authorization_pending") continue;
        if (error.code === "slow_down") {
          interval += 5000;
          continue;
        }
        throw this.#fail(`device login ended: ${error.message}`);
      }
    }
    throw this.#fail("device login expired before it was approved");
  }

  /** Forget the tokens, revoking them first where the server allows (RFC 7009). */
  async logout(): Promise<{ revoked: boolean }> {
    const login = await this.#load();
    let revoked = false;
    if (login?.tokens) {
      const endpoint = login.metadata?.revocation_endpoint ?? this.#metadata?.revocation_endpoint;
      if (endpoint) {
        const client = login.client ?? (this.config.clientId ? { id: this.config.clientId, ...(this.config.clientSecret ? { secret: this.config.clientSecret } : {}) } : undefined);
        if (client) {
          const full = { ...client, method: this.#method(client) };
          for (const [token, hint] of [
            [login.tokens.refresh, "refresh_token"],
            [login.tokens.access, "access_token"],
          ] as const) {
            if (!token) continue;
            try {
              await this.#post(endpoint, new URLSearchParams({ token, token_type_hint: hint }), full);
              revoked = true;
            } catch {
              /* revocation is a courtesy; forgetting is the promise */
            }
          }
        }
      }
      await this.#save({ tokens: undefined });
    }
    return { revoked };
  }

  async status(): Promise<{ loggedIn: boolean; expiresAt?: number; scope?: string; refreshable: boolean }> {
    const tokens = (await this.#load())?.tokens;
    return {
      loggedIn: Boolean(tokens?.access && (!tokens.expiresAt || tokens.expiresAt > Date.now() || tokens.refresh)),
      ...(tokens?.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
      ...(tokens?.scope ? { scope: tokens.scope } : {}),
      refreshable: Boolean(tokens?.refresh),
    };
  }
}

/**
 * Still good for the next request? Refreshed a little early — a minute, or a
 * quarter of the token's life when it is short — so it never expires in flight.
 */
const fresh = (tokens: NonNullable<StoredLogin["tokens"]>): boolean => {
  if (!tokens.expiresAt) return true;
  const life = tokens.issuedAt ? tokens.expiresAt - tokens.issuedAt : 240_000;
  return tokens.expiresAt - Math.min(60_000, life / 4) > Date.now();
};

/* ─────────────────────────────── login helpers ───────────────────────────── */

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("aborted"))), { once: true });
  });

/** A one-shot loopback server for the redirect (RFC 8252). */
function loopback(port: number): Promise<{ port: number; wait(signal?: AbortSignal): Promise<URLSearchParams>; close(): void }> {
  return new Promise((resolve, reject) => {
    let deliver: ((params: URLSearchParams) => void) | undefined;
    const received: URLSearchParams[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>ensemble</title><p>Signed in. You can close this tab.</p>");
      if (deliver) deliver(url.searchParams);
      else received.push(url.searchParams);
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : port,
        wait(signal) {
          return new Promise((done, fail) => {
            if (received.length) return done(received.shift()!);
            const timer = setTimeout(() => fail(new Error("no login reply within 5 minutes")), 5 * 60_000);
            timer.unref?.();
            signal?.addEventListener("abort", () => (clearTimeout(timer), fail(new Error("login aborted"))), { once: true });
            deliver = (params) => (clearTimeout(timer), done(params));
          });
        },
        close: () => server.close(),
      });
    });
  });
}

/** The platform's own way to open a url. Failure is fine: the url was also printed. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* printed already */
  }
}

/* ──────────────────────────────── the surface ────────────────────────────── */

const oauthFor = (name: string, spec: RemoteServerSpec, options: ConnectOptions, resolved: McpAuth[], redactor: Redactor): OAuth => {
  const config = resolved.find((auth): auth is OAuthConfig => auth.type === "oauth") ?? { type: "oauth" as const };
  const oauth = new OAuth(name, spec, config, { timeoutMs: spec.timeoutMs ?? 30_000, ...options }, redactor);
  const mtls = resolved.find((auth) => auth.type === "mtls");
  if (mtls) oauth.tls = { cert: pemOrPath(mtls.cert), key: pemOrPath(mtls.key), ...(mtls.ca ? { ca: pemOrPath(mtls.ca) } : {}), ...(mtls.passphrase ? { passphrase: mtls.passphrase } : {}) };
  return oauth;
};

async function oauthOf(name: string, spec: RemoteServerSpec, options: ConnectOptions): Promise<OAuth> {
  const redactor = new Redactor();
  const resolved = await resolveSecrets(name, authList(spec), options.secretResolver ?? envSecrets, redactor);
  if (resolved.length && !resolved.some((auth) => auth.type === "oauth")) {
    throw new McpError(name, `does not use OAuth (auth: ${authMode(spec)}), so there is nothing to log in to`);
  }
  return oauthFor(name, spec, options, resolved, redactor);
}

/** Log in to a server now: a browser, a device code, or a machine grant. */
export async function login(name: string, spec: RemoteServerSpec, options: ConnectOptions = {}): Promise<void> {
  const oauth = await oauthOf(name, spec, options);
  await oauth.login({ device: options.device });
}

/** Forget a server's tokens, revoking them where the server allows. */
export async function logout(name: string, spec: RemoteServerSpec, options: ConnectOptions = {}): Promise<{ revoked: boolean }> {
  return (await oauthOf(name, spec, options)).logout();
}

/** Whether a server has a usable login — never the token itself. */
export async function loginStatus(
  name: string,
  spec: RemoteServerSpec,
  options: ConnectOptions = {},
): Promise<{ mode: string; loggedIn: boolean; expiresAt?: number; scope?: string; refreshable: boolean }> {
  const mode = authMode(spec);
  const list = authList(spec);
  if (list.length && !list.some((auth) => auth.type === "oauth")) return { mode, loggedIn: true, refreshable: false };
  const store = options.tokenStore ?? fileTokenStore(list.find((auth): auth is OAuthConfig => auth.type === "oauth")?.tokenStore);
  const login = await store.load(name);
  const tokens = login && login.resource === canonicalResource(spec.url) ? login.tokens : undefined;
  return {
    mode,
    loggedIn: Boolean(tokens?.access && (!tokens.expiresAt || tokens.expiresAt > Date.now() || tokens.refresh)),
    ...(tokens?.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    ...(tokens?.scope ? { scope: tokens.scope } : {}),
    refreshable: Boolean(tokens?.refresh),
  };
}
