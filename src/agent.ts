/**
 * Delegation — handing one step to an agent somebody else runs.
 *
 * This library runs no tool loop, and that has not changed. What changed is
 * where a loop that lives ELSEWHERE shows up. An agent used to sit inside an
 * opaque `work` handler, so `graph.json` showed a box called "agent" and could
 * not say which agent, reached how, allowed to do what. Declaring it makes the
 * picture more complete, which is the only reason a node kind is ever added:
 * the graph now names the agent and the protocol, `validate` proves it is
 * declared and reachable in principle, and `run.json` records what was asked,
 * what came back, which tools the agent said it used and whether it reported a
 * cost.
 *
 * The agent is reached through the standards the industry settled on, and
 * nothing else:
 *
 *   `a2a`  Agent2Agent — a hosted agent, across the network, by URL.
 *   `acp`  Agent Client Protocol — a local agent, launched as a command.
 *   `mcp`  an agent somebody offers as one MCP tool.
 *
 * One call per node execution, on all three. The loop is the agent's; the
 * route in, the deadline, the budget and the judgement of what came back stay
 * in the graph.
 *
 * This module holds the vocabulary and the one seam (`Delegate`), so a test, a
 * dry run or a host app can replace every protocol at once. The wire work is
 * in `a2a.ts` and `acp.ts`.
 */
import type { McpAuth, SecretResolver, TokenStore } from "./mcp-auth.ts";
import type { McpServerSpec, McpSession } from "./mcp.ts";

/** A hosted agent, reached over the network with A2A. */
export interface A2aAgentSpec {
  protocol: "a2a";
  /**
   * Where the agent lives. Its card is looked for at
   * `<url>/.well-known/agent-card.json`; a url ending in `.json` IS the card.
   */
  url: string;
  /** The card's url, when it is somewhere else. */
  card?: string;
  /**
   * Call this url instead of the one the card names — for a card that
   * advertises an address you cannot reach, or one on another origin.
   */
  endpoint?: string;
  /** Which binding to speak when the card offers both. Default: JSON-RPC, then HTTP+JSON. */
  binding?: "JSONRPC" | "HTTP+JSON";
  /** Force a protocol version instead of reading it from the card. */
  version?: "1.0" | "0.3";
  /** Sent on every request. Values may be `${NAME}`, resolved at call time. */
  headers?: Record<string, string>;
  /** The same modes a remote MCP server takes: bearer, api_key, basic, oauth, mtls, custom. */
  auth?: McpAuth | McpAuth[];
  /** `false` never streams, even when the card offers it. Default: stream when offered. */
  streaming?: boolean;
  /** How often to ask for the task when not streaming. Default 1000ms, backing off to 5s. */
  pollMs?: number;
  /** How long the agent may take, start to finish. Default 10 minutes. */
  timeoutMs?: number;
}

/** What an ACP agent may do when it ASKS. `{ allow }` lists tool kinds: read, search, fetch, think, edit, delete, move, execute, switch_mode, other. */
export type AcpPermissions = "reject" | "allow" | { allow: string[] };

/** A local agent, launched as a command and spoken to over stdio with ACP. */
export interface AcpAgentSpec {
  protocol: "acp";
  command: string;
  args?: string[];
  /** Added to the environment. Values may be `${NAME}`, resolved at launch. */
  env?: Record<string, string>;
  /** The session's working directory. Default: the process's own. */
  cwd?: string;
  /**
   * How permission requests are answered — by policy, never by a person.
   * Default `"reject"`, so an agent that asks before it writes stays read-only.
   */
  permissions?: AcpPermissions;
  /**
   * Offer the client-side file methods, confined to `cwd`. Off by default: the
   * client then declares no file-system capability at all. The terminal
   * capability is never offered.
   */
  fs?: { read?: boolean; write?: boolean };
  /**
   * Keys of the runner's `mcpServers` to hand to the agent in `session/new`,
   * so it can use tools the graph already declares. The AGENT connects to
   * them, not this client. A local server is always accepted; a `url` server
   * needs an agent that advertises the HTTP (or SSE) MCP capability, and auth
   * that fits in headers.
   */
  mcpServers?: string[];
  /** How long the agent may take, start to finish. Default 10 minutes. */
  timeoutMs?: number;
}

/** An agent offered as ONE tool of a declared MCP server. */
export interface McpAgentSpec {
  protocol: "mcp";
  /** A key of the runner's `mcpServers`. */
  server: string;
  tool: string;
  /** The argument the prompt goes in. Default `"prompt"`. */
  input?: string;
  /** Other arguments, sent as written. */
  args?: Record<string, unknown>;
}

export type AgentSpec = A2aAgentSpec | AcpAgentSpec | McpAgentSpec;

export const AGENT_PROTOCOLS = ["a2a", "acp", "mcp"] as const;
export const ACP_TOOL_KINDS = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"];

/** A tool the agent said it used. Data for the record — nothing here is executed by the runner. */
export interface AgentToolCall {
  id: string;
  title?: string;
  kind?: string;
  status?: string;
}

/** A permission the agent asked for, and how the declared policy answered. */
export interface AgentPermission {
  toolCall: string;
  title?: string;
  kind?: string;
  outcome: "allowed" | "rejected" | "cancelled";
}

/** Something the agent produced besides its message. */
export interface AgentArtifact {
  id?: string;
  name?: string;
  text: string;
  data?: unknown[];
  files?: Array<{ url?: string; filename?: string; mediaType?: string }>;
}

export interface AgentReply {
  text: string;
  /** How it ended, in the protocol's own word: `completed` (a2a, mcp), `end_turn` (acp). */
  status: string;
  artifacts: AgentArtifact[];
  toolCalls: AgentToolCall[];
  permissions: AgentPermission[];
  /** Structured output: A2A data parts, or an MCP tool's `structuredContent`. */
  data?: unknown;
  /** USD, and only when the protocol reported one. Absent means UNKNOWN, never zero. */
  cost?: number;
  usage?: Record<string, unknown>;
  /** Who answered and how: the agent's own name and version, ids, whether it streamed. */
  meta: Record<string, unknown>;
}

export interface AgentRequest {
  /** The key in the runner's `agents`. */
  name: string;
  agent: AgentSpec;
  /** The one message sent. */
  prompt: string;
  /** Aborts the call: the task is cancelled (A2A) or the turn is (`session/cancel`, ACP). */
  signal: AbortSignal;
  secretResolver?: SecretResolver;
  tokenStore?: TokenStore;
  /** The run's MCP sessions, for `protocol: "mcp"`. */
  mcp?: (server: string) => Promise<McpSession>;
  /** The runner's MCP server declarations, for an `acp` agent that is handed some of them. */
  mcpServers?: Record<string, McpServerSpec>;
}

/** The seam. Swap it for a stub in a test, a recorder, or a host's own policy. */
export type Delegate = (request: AgentRequest) => Promise<AgentReply>;

/** The agent could not be reached, refused, or stopped somewhere a run cannot continue from. */
export class AgentError extends Error {
  readonly agent: string;
  /** What it had done before it stopped, kept for the run record. */
  readonly partial: Partial<AgentReply> | undefined;
  constructor(agent: string, message: string, options: { cause?: unknown; partial?: Partial<AgentReply> } = {}) {
    super(`agent "${agent}": ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentError";
    this.agent = agent;
    this.partial = options.partial;
  }
}

const shown = (value: unknown): string =>
  typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2);

/**
 * The message an agent node sends when it declares no `prompt`: its reads, as
 * they are. One key is sent bare; several are labelled, so the agent can tell
 * the request from its context.
 */
export function promptFromReads(state: Readonly<Record<string, unknown>>, reads: readonly string[]): string {
  const keys = reads.length ? reads : ["goal"];
  if (keys.length === 1) return shown(state[keys[0]!]);
  return keys.map((key) => `${key}:\n${shown(state[key])}`).join("\n\n");
}

/** Where an agent is, in words safe to print: never a query string, a header or a resolved secret. */
export function describeAgent(agent: AgentSpec): string {
  if (agent.protocol === "a2a") {
    try {
      const url = new URL(agent.url);
      return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return "(invalid url)";
    }
  }
  if (agent.protocol === "acp") return [agent.command, ...(agent.args ?? [])].join(" ");
  return `${agent.server}/${agent.tool}`;
}

/** The default `Delegate`: the real protocols. */
export const delegate: Delegate = async (request) => {
  const { agent, name } = request;
  if (agent.protocol === "a2a") return (await import("./a2a.ts")).sendA2a(name, agent, request);
  if (agent.protocol === "acp") return (await import("./acp.ts")).promptAcp(name, agent, request);
  if (agent.protocol === "mcp") {
    if (!request.mcp) throw new AgentError(name, `is an MCP tool, and no MCP sessions were given to reach "${agent.server}"`);
    let session: McpSession;
    try {
      session = await request.mcp(agent.server);
    } catch (cause) {
      throw new AgentError(name, (cause as Error).message, { cause });
    }
    const outcome = await session.call(agent.tool, { ...agent.args, [agent.input ?? "prompt"]: request.prompt }, { signal: request.signal });
    if (outcome.isError) {
      throw new AgentError(name, `the tool ${agent.server}/${agent.tool} failed: ${outcome.text.slice(0, 300)}`);
    }
    return {
      text: outcome.text,
      status: "completed",
      artifacts: [],
      toolCalls: [],
      permissions: [],
      ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      meta: { server: agent.server, tool: agent.tool },
    };
  }
  throw new AgentError(name, `has protocol "${(agent as { protocol?: unknown }).protocol}" — use "a2a", "acp" or "mcp"`);
};
