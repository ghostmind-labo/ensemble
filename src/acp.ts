/**
 * ACP — one prompt turn with an agent that runs as a local command.
 *
 * The Agent Client Protocol is what editors use to drive a coding agent: start
 * it as a subprocess, speak JSON-RPC over its stdin and stdout, send a prompt,
 * and listen while it works. The agents people already have installed speak it,
 * which is the reason to be a client of it: a graph can hand a step to one of
 * them without importing its SDK or knowing what model is behind it.
 *
 * An editor is an interactive client and this is not, and every decision below
 * follows from that difference:
 *
 *   One turn. `initialize`, `session/new`, one `session/prompt`, and the
 *   process is closed. The loop is inside the agent; the runner waits for a
 *   stop reason and records what the agent said it did on the way.
 *
 *   Nobody is watching. A permission request is answered by the policy written
 *   in the runner — reject by default — because a run never waits on a person
 *   at a prompt it cannot show.
 *
 *   Nothing is lent. The client declares no file-system and no terminal
 *   capability, so the agent has no reach into this process. File access can
 *   be switched on, confined to the session's directory; a terminal cannot.
 *
 * The wire is newline-delimited JSON-RPC 2.0 written by hand, like the stdio
 * MCP pipe beside it, because the alternative was a dependency.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  AgentError,
  type AcpAgentSpec,
  type AgentPermission,
  type AgentReply,
  type AgentRequest,
  type AgentToolCall,
} from "./agent.ts";
import { authList, envSecrets, Redactor, templateNames } from "./mcp-auth.ts";
import { isRemote, type McpServerSpec, type RpcMessage } from "./mcp.ts";

/** The stable major version of the protocol. v2 is published as a draft and is not spoken here. */
export const ACP_VERSION = 1;
const CLIENT_INFO = { name: "ensemble", title: "Ensemble", version: "2" };
const HANDSHAKE_TIMEOUT = 30_000;
const DEFAULT_TIMEOUT = 600_000;
/** After `session/cancel`, how long the agent gets to answer `cancelled` before the process is ended. */
const CANCEL_GRACE = 2_000;

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** What the client tells the agent it may use. Omitted means unsupported, by the protocol's own rule. */
export function clientCapabilities(spec: AcpAgentSpec): Json {
  const read = spec.fs?.read === true;
  const write = spec.fs?.write === true;
  return read || write ? { fs: { readTextFile: read, writeTextFile: write } } : {};
}

/** Answer a permission request from the declared policy. Pure, so it can be tested without a process. */
export function decidePermission(
  policy: AcpAgentSpec["permissions"],
  kind: string,
  options: Array<{ optionId: string; kind: string }>,
): { outcome: AgentPermission["outcome"]; optionId?: string } {
  const allow = policy === "allow" || (typeof policy === "object" && policy !== null && policy.allow.includes(kind || "other"));
  const find = (...kinds: string[]): string | undefined => {
    for (const wanted of kinds) {
      const hit = options.find((option) => option.kind === wanted);
      if (hit) return hit.optionId;
    }
    return undefined;
  };
  if (allow) {
    const optionId = find("allow_once", "allow_always");
    if (optionId) return { outcome: "allowed", optionId };
  }
  const optionId = find("reject_once", "reject_always");
  // No way to say no among the options offered: decline to choose at all.
  return optionId ? { outcome: "rejected", optionId } : { outcome: "cancelled" };
}

/** Auth a forwarded server can carry: only what fits in a header, because the agent makes the connection. */
export const FORWARDABLE_AUTH = ["none", "headers", "bearer", "basic", "api_key"];

/**
 * A runner's MCP server, in the shape `session/new` takes. `undefined` when it
 * cannot be handed over: the reason is in `why`.
 */
export function forwardServer(
  name: string,
  server: McpServerSpec,
  offers: { http?: boolean; sse?: boolean },
): { server?: Json; why?: string } {
  const pairs = (map: Record<string, string> | undefined): Array<{ name: string; value: string }> =>
    Object.entries(map ?? {}).map(([key, value]) => ({ name: key, value }));
  if (!isRemote(server)) return { server: { name, command: server.command, args: server.args ?? [], env: pairs(server.env) } };
  const type = server.transport === "sse" ? "sse" : "http";
  if (server.transport === "websocket" || /^wss?:/.test(server.url)) return { why: `it is a WebSocket server, and ACP forwards stdio, http and sse servers only` };
  if (!offers[type]) return { why: `the agent does not advertise mcpCapabilities.${type}, so it cannot connect to a url server` };
  const headers: Record<string, string> = { ...server.headers };
  for (const auth of authList(server)) {
    if (auth.type === "bearer") headers["Authorization"] = `Bearer ${auth.token}`;
    else if (auth.type === "basic") headers["Authorization"] = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
    else if (auth.type === "api_key" && auth.in === "header") headers[auth.name] = auth.value;
    else if (auth.type !== "none" && auth.type !== "headers") {
      return { why: `its auth (${auth.type}${auth.type === "api_key" ? " in the query" : ""}) cannot be handed to another program — use bearer, basic, an api_key header or headers` };
    }
  }
  return { server: { type, name, url: server.url, headers: pairs(headers) } };
}

/** Run one prompt turn against an ACP agent. */
export async function promptAcp(name: string, spec: AcpAgentSpec, request: AgentRequest): Promise<AgentReply> {
  const limit = spec.timeoutMs ?? DEFAULT_TIMEOUT;
  const cwd = resolve(spec.cwd ?? process.cwd());
  const redactor = new Redactor();
  const resolver = request.secretResolver ?? envSecrets;

  // `${NAME}` in env and args is resolved here, at launch, and remembered only to be redacted.
  const missing: string[] = [];
  const fill = async (value: string): Promise<string> => {
    let out = value;
    for (const key of templateNames(value)) {
      const secret = await resolver(key);
      if (secret === undefined || secret === "") missing.push(key);
      else {
        redactor.add(secret);
        out = out.split(`\${${key}}`).join(secret);
      }
    }
    return out;
  };
  const args = await Promise.all((spec.args ?? []).map(fill));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = await fill(value);
  if (missing.length) {
    throw new AgentError(name, `needs ${[...new Set(missing)].join(", ")}, which ${missing.length === 1 ? "is" : "are"} not set`);
  }
  if (request.signal.aborted) throw new AgentError(name, "was aborted before it started");

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(spec.command, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  } catch (cause) {
    throw new AgentError(name, `could not start "${spec.command}" — is it installed and on PATH?`, { cause });
  }

  let text = "";
  let lastMessage: string | undefined;
  const toolCalls = new Map<string, AgentToolCall>();
  const permissions: AgentPermission[] = [];
  let usage: Json | undefined;
  let cost: number | undefined;
  let sessionId = "";
  let agentInfo: Json = {};
  let stopReason = "";
  let exited = false;
  let stderr = "";
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  const partial = (): Partial<AgentReply> => ({
    text,
    ...(stopReason ? { status: stopReason } : {}),
    toolCalls: [...toolCalls.values()],
    permissions,
    ...(cost !== undefined ? { cost } : {}),
    ...(usage ? { usage } : {}),
    meta: meta(),
  });
  const meta = (): Record<string, unknown> => ({
    ...(str(agentInfo["name"]) ? { name: str(agentInfo["name"]) } : {}),
    ...(str(agentInfo["version"]) ? { version: str(agentInfo["version"]) } : {}),
    acp: ACP_VERSION,
    ...(sessionId ? { sessionId } : {}),
  });
  const fail = (message: string, cause?: unknown): AgentError =>
    new AgentError(name, redactor.redact(message), { ...(cause !== undefined ? { cause } : {}), partial: partial() });

  const write = (message: RpcMessage): void => {
    if (exited || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const ask = (method: string, params: Json, timeoutMs?: number): Promise<unknown> =>
    new Promise((resolvePromise, reject) => {
      if (exited) return reject(fail(`the agent is not running${tail()}`));
      const id = nextId++;
      const timer = timeoutMs
        ? setTimeout(() => {
            pending.delete(id);
            reject(fail(`${method} did not answer within ${timeoutMs}ms — is "${spec.command}" an ACP agent? (e.g. opencode acp)`));
          }, timeoutMs)
        : undefined;
      pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolvePromise(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      write({ jsonrpc: "2.0", id, method, params });
    });
  const tail = (): string => (stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : "");

  const inside = (path: unknown): string => {
    const given = str(path);
    if (!given || !isAbsolute(given)) throw new Error(`path must be absolute: ${given}`);
    const target = resolve(given);
    const rel = relative(cwd, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path is outside the session directory: ${given}`);
    return target;
  };

  /** A request FROM the agent. Everything not offered is declined, so an agent waiting on us is told. */
  const serve = async (message: RpcMessage): Promise<void> => {
    const id = message.id!;
    const params = obj(message.params);
    const reply = (result: unknown): void => write({ jsonrpc: "2.0", id, result });
    const refuse = (code: number, text: string): void => write({ jsonrpc: "2.0", id, error: { code, message: text } });
    try {
      switch (message.method) {
        case "session/request_permission": {
          const call = obj(params["toolCall"]);
          const callId = str(call["toolCallId"]);
          const known = toolCalls.get(callId);
          const kind = str(call["kind"]) || known?.kind || "other";
          const title = str(call["title"]) || known?.title;
          const options = (Array.isArray(params["options"]) ? params["options"] : []).map((option) => ({
            optionId: str(obj(option)["optionId"]),
            kind: str(obj(option)["kind"]),
          }));
          // Answered at once, by policy. A turn being cancelled answers `cancelled`, as the protocol requires.
          const verdict = cancelling ? { outcome: "cancelled" as const } : decidePermission(spec.permissions ?? "reject", kind, options);
          permissions.push({ toolCall: callId, ...(title ? { title } : {}), kind, outcome: verdict.outcome });
          reply({ outcome: verdict.optionId ? { outcome: "selected", optionId: verdict.optionId } : { outcome: "cancelled" } });
          return;
        }
        case "fs/read_text_file": {
          if (!spec.fs?.read) return refuse(-32601, "fs/read_text_file is not offered by this client");
          const content = await readFile(inside(params["path"]), "utf8");
          const line = typeof params["line"] === "number" ? Math.max(1, params["line"]) : undefined;
          const count = typeof params["limit"] === "number" ? params["limit"] : undefined;
          if (line === undefined && count === undefined) return reply({ content });
          const lines = content.split("\n");
          const from = (line ?? 1) - 1;
          return reply({ content: lines.slice(from, count === undefined ? undefined : from + count).join("\n") });
        }
        case "fs/write_text_file": {
          if (!spec.fs?.write) return refuse(-32601, "fs/write_text_file is not offered by this client");
          await writeFile(inside(params["path"]), str(params["content"]), "utf8");
          return reply({});
        }
        default:
          return refuse(-32601, `method not supported: ${message.method}`);
      }
    } catch (error) {
      refuse(-32603, redactor.redact((error as Error).message));
    }
  };

  const update = (params: Json): void => {
    if (sessionId && str(params["sessionId"]) && str(params["sessionId"]) !== sessionId) return;
    const change = obj(params["update"]);
    switch (change["sessionUpdate"]) {
      case "agent_message_chunk": {
        const content = obj(change["content"]);
        if (content["type"] !== "text" || typeof content["text"] !== "string") return;
        const messageId = str(change["messageId"]);
        // A new message id is a new message: keep them apart in the text.
        if (messageId && lastMessage !== undefined && messageId !== lastMessage && text) text += "\n\n";
        if (messageId) lastMessage = messageId;
        text += content["text"];
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = str(change["toolCallId"]);
        if (!id) return;
        const call = toolCalls.get(id) ?? { id };
        if (str(change["title"])) call.title = str(change["title"]);
        if (str(change["kind"])) call.kind = str(change["kind"]);
        if (str(change["status"])) call.status = str(change["status"]);
        else if (change["sessionUpdate"] === "tool_call" && !call.status) call.status = "pending";
        toolCalls.set(id, call);
        return;
      }
      case "usage_update": {
        usage = { used: change["used"], size: change["size"], ...(change["cost"] ? { cost: change["cost"] } : {}) };
        const reported = obj(change["cost"]);
        // Cumulative for the session, and the session is this one turn. Only USD joins the run's total.
        if (typeof reported["amount"] === "number" && str(reported["currency"]).toUpperCase() === "USD") cost = reported["amount"];
        return;
      }
      default:
        return; // thoughts, plans, commands and modes are the agent's business
    }
  };

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a banner or a log line; the protocol forbids it, real programs do it anyway
      }
      if (typeof message.method === "string") {
        if (message.id === undefined || message.id === null) {
          if (message.method === "session/update") update(obj(message.params));
        } else void serve(message);
        continue;
      }
      if (typeof message.id !== "number") continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) {
        const error = new Error(str(message.error.message) || "request failed") as Error & { code?: number };
        if (typeof message.error.code === "number") error.code = message.error.code;
        waiter.reject(error);
      } else waiter.resolve(message.result);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  const gone = (why: string, cause?: unknown): void => {
    exited = true;
    const error = fail(why, cause);
    for (const waiter of [...pending.values()]) waiter.reject(error);
    pending.clear();
  };
  child.on("error", (cause) =>
    gone(
      (cause as NodeJS.ErrnoException).code === "ENOENT"
        ? `could not start "${spec.command}" — it is not installed or not on PATH`
        : `process error: ${cause.message}`,
      cause,
    ),
  );
  child.on("exit", (code) => gone(`the agent exited (${code}) before answering${tail()}`));
  child.stdin.on("error", () => {});

  const close = (): void => {
    if (exited) return;
    exited = true;
    child.stdin.end();
    child.kill();
  };

  let cancelling = false;
  let timedOut = false;
  let prompting = false;
  let abandon: ((error: Error) => void) | undefined;
  const cancel = (): void => {
    if (cancelling) return;
    cancelling = true;
    if (prompting && sessionId) {
      // Ask the agent to stop, and give it a moment to say `cancelled` before ending the process.
      write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
      setTimeout(() => abandon?.(new Error("aborted")), CANCEL_GRACE).unref?.();
    } else abandon?.(new Error("aborted"));
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, limit);
  request.signal.addEventListener("abort", cancel, { once: true });
  const stopped = new Promise<never>((_resolve, reject) => {
    abandon = reject;
  });
  stopped.catch(() => {});

  try {
    const hello = obj(
      await Promise.race([
        ask("initialize", { protocolVersion: ACP_VERSION, clientCapabilities: clientCapabilities(spec), clientInfo: CLIENT_INFO }, HANDSHAKE_TIMEOUT),
        stopped,
      ]),
    );
    agentInfo = obj(hello["agentInfo"]);
    if (hello["protocolVersion"] !== ACP_VERSION) {
      throw fail(
        `speaks ACP protocol version ${JSON.stringify(hello["protocolVersion"])}, and this client speaks ${ACP_VERSION} — ` +
          `use a release of the agent that still offers v${ACP_VERSION}`,
      );
    }

    // The graph's own MCP servers, handed over by name. The agent connects; this client does not.
    const offers = obj(obj(hello["agentCapabilities"])["mcpCapabilities"]);
    const mcpServers: Json[] = [];
    for (const key of spec.mcpServers ?? []) {
      const declared = request.mcpServers?.[key];
      if (!declared) throw fail(`is handed MCP server "${key}", which the runner does not declare`);
      const { server, why } = forwardServer(key, declared, { http: offers["http"] === true, sse: offers["sse"] === true });
      if (!server) throw fail(`cannot be handed MCP server "${key}": ${why}`);
      // Secrets are resolved here, for the agent's eyes only, and remembered to be redacted.
      const filled = JSON.parse(JSON.stringify(server)) as Json;
      for (const list of [filled["env"], filled["headers"]]) {
        for (const pair of (Array.isArray(list) ? list : []) as Array<{ name: string; value: string }>) {
          const before = pair.value;
          pair.value = await fill(pair.value);
          if (pair.value !== before || /authorization|token|secret|key|password/i.test(pair.name)) redactor.add(pair.value);
        }
      }
      if (typeof filled["url"] === "string") filled["url"] = await fill(filled["url"]);
      if (Array.isArray(filled["args"])) filled["args"] = await Promise.all((filled["args"] as string[]).map(fill));
      mcpServers.push(filled);
    }
    if (missing.length) throw fail(`needs ${[...new Set(missing)].join(", ")}, which ${missing.length === 1 ? "is" : "are"} not set`);

    let session: Json;
    try {
      session = obj(await Promise.race([ask("session/new", { cwd, mcpServers }, HANDSHAKE_TIMEOUT), stopped]));
    } catch (error) {
      if (error instanceof AgentError || cancelling) throw error;
      const code = (error as { code?: number }).code;
      const methods = (Array.isArray(hello["authMethods"]) ? hello["authMethods"] : []).map((method) => str(obj(method)["name"]) || str(obj(method)["id"]));
      throw fail(
        code === -32000 || /auth/i.test((error as Error).message)
          ? `the agent wants a login before it opens a session (${(error as Error).message})` +
            `${methods.length ? ` — it offers: ${methods.join(", ")}` : ""}. A run cannot log in for it: ` +
            `run the agent's own login once in a terminal (or give it its key through env: { KEY: "\${NAME}" }), then run again`
          : `session/new failed: ${(error as Error).message}`,
        error,
      );
    }
    sessionId = str(session["sessionId"]);
    if (!sessionId) throw fail("session/new returned no sessionId");

    prompting = true;
    const result = obj(await Promise.race([ask("session/prompt", { sessionId, prompt: [{ type: "text", text: request.prompt }] }), stopped]));
    stopReason = str(result["stopReason"]);

    if (stopReason === "end_turn") {
      return {
        text,
        status: stopReason,
        artifacts: [],
        toolCalls: [...toolCalls.values()],
        permissions,
        ...(cost !== undefined ? { cost } : {}),
        ...(usage ? { usage } : {}),
        meta: meta(),
      };
    }
    if (stopReason === "cancelled") {
      throw fail(timedOut ? `did not finish within ${limit}ms — the turn was cancelled. Raise timeoutMs on the agent if it needs longer` : cancelling ? "was aborted — the turn was cancelled" : "the agent cancelled the turn");
    }
    if (stopReason === "refusal") throw fail("the agent refused to continue (stop reason: refusal) — rephrase the prompt, or route this request elsewhere");
    if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
      throw fail(
        `stopped at ${stopReason} before it finished, so its reply is incomplete — ask for less in one turn, or raise the agent's own limit`,
      );
    }
    throw fail(
      `ended the turn with stop reason ${JSON.stringify(result["stopReason"])}, which ACP v${ACP_VERSION} does not define ` +
        `(end_turn, max_tokens, max_turn_requests, refusal, cancelled)`,
    );
  } catch (error) {
    if (cancelling) {
      throw fail(
        timedOut ? `did not finish within ${limit}ms — the turn was cancelled. Raise timeoutMs on the agent if it needs longer` : "was aborted — the turn was cancelled",
        error,
      );
    }
    if (error instanceof AgentError) throw error;
    throw fail((error as Error).message, error);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    close();
  }
}
