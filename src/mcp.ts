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
 * The client is hand-rolled newline-delimited JSON-RPC 2.0 over stdio — the
 * whole of what stdio MCP is — because the alternative was a runtime dependency
 * and this package has none.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** How long any single request may take. Default 30s. */
  timeoutMs?: number;
}

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
  listTools(): Promise<McpTool[]>;
  call(tool: string, args: Record<string, unknown>): Promise<McpResult>;
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = "2024-11-05";

/** Start a server and complete the handshake. */
export async function connect(name: string, spec: McpServerSpec): Promise<McpSession> {
  const timeoutMs = spec.timeoutMs ?? 30_000;
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

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let buffer = "";
  let closed = false;
  let stderr = "";

  const fail = (error: Error): void => {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    // Newline-delimited JSON. A partial line stays in the buffer.
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;

      let message: { id?: number; result?: unknown; error?: { message?: string; code?: number } };
      try {
        message = JSON.parse(line);
      } catch {
        continue; // servers sometimes log to stdout; ignore anything that is not a message
      }
      if (typeof message.id !== "number") continue; // a notification
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new McpError(name, message.error.message ?? "request failed"));
      else waiter.resolve(message.result);
    }
  });

  // Kept only to make a startup failure legible.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });

  child.on("error", (cause) => fail(new McpError(name, `process error: ${cause.message}`, { cause })));
  child.on("exit", (code) => {
    closed = true;
    fail(new McpError(name, `server exited (${code})${stderr ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`));
  });

  const send = (payload: Record<string, unknown>): void => {
    if (closed) throw new McpError(name, "server is not running");
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const request = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpError(name, `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  };

  await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "ensemble", version: "2" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    name,
    async listTools() {
      const result = (await request("tools/list")) as { tools?: Array<Record<string, unknown>> };
      return (result?.tools ?? []).map((tool) => ({
        name: String(tool["name"] ?? ""),
        description: String(tool["description"] ?? ""),
        inputSchema: tool["inputSchema"] as Record<string, unknown> | undefined,
      }));
    },
    async call(tool, args) {
      const result = (await request("tools/call", { name: tool, arguments: args })) as {
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
    close() {
      if (closed) return;
      closed = true;
      child.stdin.end();
      child.kill();
    },
  };
}

/**
 * Sessions, started once and reused across a run.
 *
 * A server is launched the first time a node needs it and shut down when the
 * run ends — so a graph that never reaches its MCP branch never starts the
 * process at all.
 */
export function pool(servers: Record<string, McpServerSpec>): {
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
        session = connect(name, spec);
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
