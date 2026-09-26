/**
 * MCP — one tool call per node, and never a loop.
 *
 * The old version of this library gave an agent a pile of MCP tools and let it
 * decide which to call, how many times, and when to stop. That is the loop this
 * rewrite exists to avoid: every iteration is another chance to go wrong, and
 * nothing about it can be drawn, proved, or replayed.
 *
 * So MCP arrives in the shape everything else here has. A node names ONE server
 * and ONE tool. Its arguments come from code, or from a decision made upstream.
 * It runs once. Which means the call shows up in `graph.json` like any other
 * node — you can see which tools a workflow can reach before it runs, which you
 * cannot do with a tool-calling agent.
 *
 * Choosing *which* tool is a `choice` over `listTools()`, exactly as choosing a
 * skill is. Both are local and cheap to enumerate, so the graph stays complete.
 *
 * A server is either a local process (`command`) or a URL (`url`). Both speak
 * the same JSON-RPC session, which lives here once; only the pipe differs. The
 * stdio pipe is hand-rolled newline-delimited JSON-RPC 2.0 — the whole of what
 * stdio MCP is — and the remote pipes are in `mcp-remote.ts`, because the
 * alternative was a runtime dependency and this package has none.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpAuth, SecretResolver, TokenStore } from "./mcp-auth.ts";

/** A local server: a process this client starts and talks to over stdio. */
export interface StdioServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** How long any single request may take. Default 30s. */
  timeoutMs?: number;
}

/** A hosted server, reached over the network. */
export interface RemoteServerSpec {
  url: string;
  /**
   * `auto` (the default) tries Streamable HTTP and falls back to the legacy
   * HTTP+SSE transport on 400/404/405; a `ws://` or `wss://` url is WebSocket.
   */
  transport?: "auto" | "streamable-http" | "sse" | "websocket";
  /** Sent on every request. Values may be `${ENV_VAR}`, resolved at connect time. */
  headers?: Record<string, string>;
  /**
   * How to prove who you are. Omitted: no credentials, but a `401` carrying a
   * Bearer challenge is treated as OAuth (a stored login is used, or the run
   * fails fast asking for one). An array combines mechanisms, e.g. mTLS + OAuth.
   */
  auth?: McpAuth | McpAuth[];
  /**
   * Streamable HTTP only: also open the GET stream for messages the server
   * starts. Off by default — one tool call needs none of them.
   */
  listen?: boolean;
  /** How long any single request may take. Default 30s. */
  timeoutMs?: number;
}

export type McpServerSpec = StdioServerSpec | RemoteServerSpec;

export const isRemote = (spec: McpServerSpec): spec is RemoteServerSpec =>
  typeof (spec as RemoteServerSpec).url === "string";

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments, as the server declares it. */
  inputSchema?: Record<string, unknown>;
}

export interface McpResult {
  /** Text content parts, joined. */
  text: string;
  /** `structuredContent` when the server sends one, else undefined. */
  data?: unknown;
  isError: boolean;
}

export class McpError extends Error {
  readonly server: string;
  constructor(server: string, message: string, options: { cause?: unknown } = {}) {
    super(`mcp "${server}": ${message}`, options);
    this.name = "McpError";
    this.server = server;
  }
}

export interface McpSession {
  name: string;
  listTools(options?: { signal?: AbortSignal }): Promise<McpTool[]>;
  call(tool: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<McpResult>;
  close(): void;
}

/** What a remote connection may need beyond its spec — all of it per call, so one runner serves many users. */
export interface ConnectOptions {
  /** Resolves `${NAME}` in headers and auth. Default: `process.env`. */
  secretResolver?: SecretResolver;
  /** Where OAuth logins live. Default: `~/.ensemble/mcp-tokens/`, one 0600 file per server. */
  tokenStore?: TokenStore;
  /**
   * May a login happen now — a browser, a device code? Off by default: a run
   * that needs one fails fast with the command to run instead of waiting.
   */
  interactive?: boolean;
  /** Interactive login uses the device grant (a code to type elsewhere) rather than a browser. */
  device?: boolean;
  /** Where login instructions go. Default: stderr. */
  prompt?: (message: string) => void;
  /** Opens the authorization page. Default: the platform's `open`. */
  openBrowser?: (url: string) => void | Promise<void>;
  /** Closes the session and fails anything pending. */
  signal?: AbortSignal;
}

/* ─────────────────────────────── the session ─────────────────────────────── */

/** A JSON-RPC message, either direction. */
export interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/**
 * A pipe: carries messages, knows nothing about what they mean.
 *
 * `send` resolves once the message is handed over, and may deliver replies
 * through `receive` before it does (Streamable HTTP answers in the POST's own
 * response). A pipe that learns its session is gone throws `SessionExpired`,
 * and the session re-initializes and retries once.
 */
export interface Transport {
  send(message: RpcMessage, signal: AbortSignal): Promise<void>;
  /** Wired by the session before the first send. */
  receive: (message: RpcMessage) => void;
  /** Wired by the session: the pipe broke and nothing more will arrive. */
  broken: (error: Error) => void;
  /** Called once the handshake completes, with the negotiated protocol version. */
  initialized?(protocolVersion: string): void | Promise<void>;
  close(): void | Promise<void>;
}

export class SessionExpired extends Error {
  constructor() {
    super("session expired");
    this.name = "SessionExpired";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const CLIENT_INFO = { name: "ensemble", version: "2" };

/**
 * The part of MCP that is the same on every pipe: ids, the handshake,
 * timeouts, and turning replies into results or `McpError`s.
 */
export async function session(
  name: string,
  transport: Transport,
  config: { timeoutMs: number; protocolVersion: string; signal?: AbortSignal; redact?: (text: string) => string },
): Promise<McpSession> {
  const pending = new Map<number, Pending>();
  const redact = config.redact ?? ((text: string) => text);
  let nextId = 1;
  let closed = false;

  const fail = (error: Error): void => {
    for (const waiter of [...pending.values()]) waiter.reject(error);
  };

  transport.receive = (message) => {
    // A server may ask the client things. Answer ping; decline the rest, so a
    // server waiting on us is told rather than left hanging.
    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) return; // a notification
      const reply: RpcMessage =
        message.method === "ping"
          ? { jsonrpc: "2.0", id: message.id, result: {} }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not supported: ${message.method}` } };
      transport.send(reply, AbortSignal.timeout(config.timeoutMs)).catch(() => {});
      return;
    }
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    if (message.error) waiter.reject(new McpError(name, redact(message.error.message ?? "request failed")));
    else waiter.resolve(message.result);
  };
  transport.broken = (error) => {
    closed = true;
    fail(error);
  };

  const once = (method: string, params: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown> => {
    if (closed) return Promise.reject(new McpError(name, "server is not running"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        config.signal?.removeEventListener("abort", onAbort);
      };
      const settle = (error?: Error, value?: unknown): void => {
        if (!pending.has(id)) return;
        pending.delete(id);
        cleanup();
        if (error) {
          controller.abort(error);
          reject(error);
        } else resolve(value);
      };
      const timer = setTimeout(() => settle(new McpError(name, `${method} timed out after ${config.timeoutMs}ms`)), config.timeoutMs);
      timer.unref?.();
      const onAbort = (): void => settle(new McpError(name, `${method} was aborted`));
      pending.set(id, {
        resolve: (value) => settle(undefined, value),
        reject: (error) => settle(error),
      });
      if (signal?.aborted || config.signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      config.signal?.addEventListener("abort", onAbort, { once: true });
      transport.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, controller.signal).catch((error: Error) => {
        if (controller.signal.aborted) return;
        settle(error instanceof McpError || error instanceof SessionExpired ? error : new McpError(name, redact(error.message), { cause: error }));
      });
    });
  };

  const handshake = async (signal?: AbortSignal): Promise<void> => {
    const result = (await once(
      "initialize",
      { protocolVersion: config.protocolVersion, capabilities: {}, clientInfo: CLIENT_INFO },
      signal,
    )) as { protocolVersion?: string } | undefined;
    await transport.initialized?.(String(result?.protocolVersion ?? config.protocolVersion));
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }, AbortSignal.timeout(config.timeoutMs));
  };

  const request = async (method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    try {
      return await once(method, params, signal);
    } catch (error) {
      if (!(error instanceof SessionExpired)) throw error;
      // The server forgot us. Say hello again and ask once more.
      await handshake(signal);
      try {
        return await once(method, params, signal);
      } catch (again) {
        if (again instanceof SessionExpired) throw new McpError(name, "the server dropped the session twice in a row");
        throw again;
      }
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    fail(new McpError(name, "session closed"));
    Promise.resolve(transport.close()).catch(() => {});
  };
  config.signal?.addEventListener("abort", close, { once: true });

  try {
    await handshake();
  } catch (error) {
    close();
    throw error;
  }

  return {
    name,
    async listTools(options = {}) {
      const result = (await request("tools/list", undefined, options.signal)) as { tools?: Array<Record<string, unknown>> };
      return (result?.tools ?? []).map((tool) => ({
        name: String(tool["name"] ?? ""),
        description: String(tool["description"] ?? ""),
        inputSchema: tool["inputSchema"] as Record<string, unknown> | undefined,
      }));
    },
    async call(tool, args, options = {}) {
      const result = (await request("tools/call", { name: tool, arguments: args }, options.signal)) as {
        content?: Array<{ type?: string; text?: string }>;
        structuredContent?: unknown;
        isError?: boolean;
      };
      const text = (result?.content ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      return {
        text,
        ...(result?.structuredContent !== undefined ? { data: result.structuredContent } : {}),
        isError: Boolean(result?.isError),
      };
    },
    close,
  };
}

/* ──────────────────────────────── stdio pipe ─────────────────────────────── */

const STDIO_PROTOCOL_VERSION = "2024-11-05";

function stdio(name: string, spec: StdioServerSpec): Transport {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new McpError(name, `could not start "${spec.command}"`, { cause });
  }

  let buffer = "";
  let exited = false;
  let stderr = "";
  const pipe: Transport = {
    receive: () => {},
    broken: () => {},
    async send(message) {
      if (exited) throw new McpError(name, "server is not running");
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    close() {
      if (exited) return;
      exited = true;
      child.stdin.end();
      child.kill();
    },
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    // Newline-delimited JSON. A partial line stays in the buffer.
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // servers sometimes log to stdout; ignore anything that is not a message
      }
      pipe.receive(message);
    }
  });

  // Kept only to make a startup failure legible.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });

  child.on("error", (cause) => pipe.broken(new McpError(name, `process error: ${cause.message}`, { cause })));
  child.on("exit", (code) => {
    exited = true;
    pipe.broken(new McpError(name, `server exited (${code})${stderr ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`));
  });
  return pipe;
}

/** Start a server — or reach one — and complete the handshake. */
export async function connect(name: string, spec: McpServerSpec, options: ConnectOptions = {}): Promise<McpSession> {
  const timeoutMs = spec.timeoutMs ?? 30_000;
  if (isRemote(spec)) {
    const { remote } = await import("./mcp-remote.ts");
    return remote(name, spec, { ...options, timeoutMs });
  }
  return session(name, stdio(name, spec), { timeoutMs, protocolVersion: STDIO_PROTOCOL_VERSION, signal: options.signal });
}

/**
 * Sessions, started once and reused across a run.
 *
 * A server is launched the first time a node needs it and shut down when the
 * run ends — so a graph that never reaches its MCP branch never starts the
 * process, or opens the connection, at all.
 */
export function pool(
  servers: Record<string, McpServerSpec>,
  options: ConnectOptions = {},
): {
  get(name: string): Promise<McpSession>;
  closeAll(): void;
} {
  const open = new Map<string, Promise<McpSession>>();
  return {
    get(name) {
      const spec = servers[name];
      if (!spec) {
        const known = Object.keys(servers);
        throw new McpError(
          name,
          `not configured. ${known.length ? `Declared: ${known.map((k) => `"${k}"`).join(", ")}` : "No servers are declared on the runner."}`,
        );
      }
      let session = open.get(name);
      if (!session) {
        session = connect(name, spec, options);
        // A failed connect is not cached: the next node to ask may find the server up.
        session.catch(() => open.delete(name));
        open.set(name, session);
      }
      return session;
    },
    closeAll() {
      for (const [, session] of open) session.then((s) => s.close()).catch(() => {});
      open.clear();
    },
  };
}

/** A server's tools, as `choice` criteria — the same shape `skillOptions` returns. */
export function toolOptions(
  tools: readonly McpTool[],
  config: { max?: number; chars?: number; none?: string | false } = {},
): Record<string, { what: string }> {
  const max = Math.min(config.max ?? 200, 254);
  const chars = config.chars ?? 180;
  const options: Record<string, { what: string }> = {};
  for (const tool of tools.slice(0, max)) {
    const text = tool.description || `The "${tool.name}" tool.`;
    options[tool.name] = { what: text.length <= chars ? text : `${text.slice(0, chars - 1).trimEnd()}…` };
  }
  if (config.none !== false) {
    options["none"] = { what: config.none ?? "No tool here fits; handle it without one." };
  }
  return options;
}
