/**
 * Bridge to opencode.
 *
 * We spawn `opencode serve` ourselves rather than using the SDK's
 * createOpencodeServer, for two reasons:
 *   1. It sets OPENCODE_CONFIG_CONTENT={} when no config is passed, which would
 *      shadow the user's real opencode.json (and therefore their OpenRouter
 *      provider setup).
 *   2. It offers no cwd control, but opencode discovers project agents by walking
 *      up from its working directory — so the server must start at the scene root.
 *
 * No token streaming. opencode 1.18.15's event bus was measured and does not
 * publish incremental assistant text on this path: a 400-word generation emits a
 * single `message.part.updated` at length 0, and the text only materialises in
 * the `session.prompt` response. Reporting is therefore per node, which is what
 * the engine's events express.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { splitModel } from "../scene.ts";

type Client = ReturnType<typeof createOpencodeClient>;

export interface NodeResult {
  text: string;
  modelID: string;
  providerID: string;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  error?: string;
}

export interface PromptRequest {
  agent: string;
  model: string;
  text: string;
  /** Reuses a session so a reprompt keeps the prior turn in context. */
  sessionID?: string;
}

export class Runtime {
  private client: Client;
  private root: string;
  url: string;
  private proc: ChildProcess | undefined;

  private constructor(client: Client, root: string, url: string, proc: ChildProcess | undefined) {
    this.client = client;
    this.root = root;
    this.url = url;
    this.proc = proc;
  }

  /** Attaches to an existing server when `port` is given, otherwise spawns one. */
  static async start(root: string, port?: number): Promise<Runtime> {
    if (port !== undefined) {
      const url = `http://127.0.0.1:${port}`;
      const client = createOpencodeClient({ baseUrl: url, directory: root });
      // Fail fast with a clear message rather than at the first prompt.
      try {
        await client.project.list({ throwOnError: true });
      } catch {
        throw new Error(`no opencode server reachable at ${url} — start one with \`opencode serve --port ${port}\``);
      }
      return new Runtime(client, root, url, undefined);
    }

    const proc = spawn("opencode", ["serve", "--hostname=127.0.0.1", "--port=0"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      // env inherited untouched, so opencode.json and OPENROUTER_API_KEY apply.
    });

    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        reject(new Error(`opencode serve did not start within 30s.\n${output}`));
      }, 30_000);

      const scan = (chunk: Buffer): void => {
        if (settled) return;
        output += chunk.toString();
        const match = /listening on\s+(https?:\/\/[^\s]+)/i.exec(output);
        if (match?.[1]) {
          settled = true;
          clearTimeout(timer);
          resolve(match[1]);
        }
      };

      proc.stdout?.on("data", scan);
      proc.stderr?.on("data", scan);

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`could not launch opencode: ${err.message}. Is it on PATH?`));
      });

      proc.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`opencode serve exited with code ${code}.\n${output}`));
      });
    });

    return new Runtime(createOpencodeClient({ baseUrl: url, directory: root }), root, url, proc);
  }

  /**
   * Live MCP server status, straight from the running opencode instance.
   *
   * This is the only honest answer to "which MCP servers can a node actually
   * use": parsing opencode.json tells you what was *declared*, not what
   * connected. A server can be configured and still be failed, disabled, or
   * waiting on OAuth.
   */
  async mcpStatus(): Promise<Record<string, { status: string; error?: string }>> {
    const res = await this.client.mcp.status({
      query: { directory: this.root },
      throwOnError: true,
    });
    return (res.data ?? {}) as Record<string, { status: string; error?: string }>;
  }

  async createSession(title: string): Promise<string> {
    const res = await this.client.session.create({
      body: { title },
      query: { directory: this.root },
      throwOnError: true,
    });
    const id = (res.data as { id?: string } | undefined)?.id;
    if (!id) throw new Error("opencode did not return a session id");
    return id;
  }

  /**
   * One node turn. Model is passed per-call so the scene stays the single
   * source of truth even though the generated agent also declares one.
   */
  async prompt(req: PromptRequest): Promise<NodeResult & { sessionID: string }> {
    const sessionID = req.sessionID ?? (await this.createSession(`graph:${req.agent}`));
    const { providerID, modelID } = splitModel(req.model);

    const res = await this.client.session.prompt({
      path: { id: sessionID },
      query: { directory: this.root },
      body: {
        agent: req.agent,
        model: { providerID, modelID },
        parts: [{ type: "text", text: req.text }],
      },
      throwOnError: true,
    });

    const data = res.data as
      | { info?: Record<string, unknown>; parts?: Array<Record<string, unknown>> }
      | undefined;
    const info = data?.info ?? {};
    const parts = data?.parts ?? [];

    const text = parts
      .filter((part) => part["type"] === "text" && typeof part["text"] === "string")
      .map((part) => part["text"] as string)
      .join("\n")
      .trim();

    const tokens = (info["tokens"] ?? {}) as { input?: number; output?: number };
    const err = info["error"] as { name?: string; data?: { message?: string } } | undefined;

    return {
      sessionID,
      text,
      // Reported by the server, so this reflects what actually ran — not what we asked for.
      modelID: typeof info["modelID"] === "string" ? info["modelID"] : modelID,
      providerID: typeof info["providerID"] === "string" ? info["providerID"] : providerID,
      cost: typeof info["cost"] === "number" ? info["cost"] : 0,
      tokensIn: tokens.input ?? 0,
      tokensOut: tokens.output ?? 0,
      ...(err ? { error: err.data?.message ?? err.name ?? "unknown provider error" } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
  }
}
