/**
 * Native MCP client.
 *
 * Replaces the opencode dependency for tool access. Servers are declared in
 * `ensemble.json` (project, then global) and connected on demand — a scene with
 * no MCP nodes never starts a server.
 *
 * Tools are namespaced `<server>__<tool>` when handed to the model, so a node's
 * allowlist is enforced by *construction*: we build the tool array ourselves, so
 * a tool we omit is not merely denied, it is invisible.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "./registry.ts";

/** Separator between server and tool name. Double underscore avoids collisions
 *  with tool names that contain a single underscore. */
export const NS = "__";

export interface McpTool {
  /** Namespaced name as exposed to the model: `<server>__<tool>`. */
  name: string;
  server: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ServerStatus {
  name: string;
  status: "connected" | "failed" | "disabled";
  error?: string;
  toolCount?: number;
}

export class McpHub {
  private clients = new Map<string, Client>();
  private statuses = new Map<string, ServerStatus>();
  private tools: McpTool[] = [];
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Connects the named servers. Failures are recorded, never thrown: one broken
   * server must not take down a run that also uses three working ones.
   */
  async connect(servers: McpServer[]): Promise<void> {
    await Promise.all(
      servers.map(async (server) => {
        if (!server.enabled) {
          this.statuses.set(server.name, { name: server.name, status: "disabled" });
          return;
        }

        try {
          const client = new Client(
            { name: "ensemble", version: "0.2.0" },
            { capabilities: {} },
          );

          if (server.type === "remote") {
            if (!server.url) throw new Error('remote server needs a "url"');
            await client.connect(
              new StreamableHTTPClientTransport(new URL(server.url), {
                ...(server.headers ? { requestInit: { headers: server.headers } } : {}),
              }),
            );
          } else {
            const [command, ...args] = server.command ?? [];
            if (!command) throw new Error('local server needs a "command" array');
            await client.connect(
              new StdioClientTransport({
                command,
                args,
                cwd: this.cwd,
                // Inherit the environment so servers can see PATH, tokens, etc.
                env: { ...(process.env as Record<string, string>), ...(server.environment ?? {}) },
              }),
            );
          }

          const listed = await client.listTools();
          for (const tool of listed.tools) {
            this.tools.push({
              name: `${server.name}${NS}${tool.name}`,
              server: server.name,
              toolName: tool.name,
              description: tool.description ?? "",
              inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
            });
          }

          this.clients.set(server.name, client);
          this.statuses.set(server.name, {
            name: server.name,
            status: "connected",
            toolCount: listed.tools.length,
          });
        } catch (err) {
          this.statuses.set(server.name, {
            name: server.name,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  /** Tools from the named servers only. An unlisted server contributes nothing. */
  toolsFor(allowed: string[]): McpTool[] {
    return this.tools.filter((tool) => allowed.includes(tool.server));
  }

  status(): ServerStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Executes a namespaced tool call and returns its text content. */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown MCP tool: ${name}`);

    const client = this.clients.get(tool.server);
    if (!client) throw new Error(`MCP server "${tool.server}" is not connected`);

    const result = await client.callTool({ name: tool.toolName, arguments: args });

    const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    const text = content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");

    if ((result as { isError?: boolean }).isError) {
      throw new Error(text || "tool reported an error");
    }
    return text || "(no output)";
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map((client) => client.close().catch(() => undefined)),
    );
    this.clients.clear();
  }
}
