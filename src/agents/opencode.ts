/**
 * The `opencode` backend.
 *
 * Chosen as the one shipped in-tree because it is the only agent CLI that needs
 * NOTHING but the credential ensemble already requires: `opencode providers`
 * reads `OPENROUTER_API_KEY` straight from the environment, and its model
 * namespace is `openrouter/<vendor>/<model>` — byte-identical to a scene's
 * model ref, so it passes through to `-m` with no translation.
 *
 * The interesting part is `OPENCODE_CONFIG_CONTENT`. opencode accepts its whole
 * config as a string in the environment, which means a node's skills, MCP
 * servers and permissions can be injected per call with nothing written to
 * disk. That is what keeps this from being the old `compile.ts` integration
 * wearing a new hat: no generated agent files, no shared project config, no
 * state surviving the process. Each call is a sealed one-shot.
 *
 * It also answers the awkward question a rented agent usually raises — "do my
 * scene's skills and tools apply to it?" Here they do: the same
 * `defaults.skills` grant that our own loop inlines into a system prompt is
 * handed to opencode as `skills.paths`, and the same registry MCP servers go
 * across as `mcp`. One grant, both agents.
 */
import type { AgentBackend } from "./index.ts";
import { registerAgentBackend } from "./index.ts";
import type { McpServer } from "../registry.ts";

/** ensemble's McpServer maps 1:1 onto opencode's McpLocalConfig/McpRemoteConfig. */
function mcpConfig(servers: McpServer[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    out[s.name] = s.type === "remote"
      ? { type: "remote", url: s.url, enabled: true, ...(s.headers ? { headers: s.headers } : {}) }
      : { type: "local", command: s.command ?? [], enabled: true, ...(s.environment ? { environment: s.environment } : {}) };
  }
  return out;
}

export const opencodeBackend: AgentBackend = {
  name: "opencode",
  summary: "rents opencode's coding loop — real edits, sandboxed, BYO OpenRouter key",
  badge: "⧉",
  bin: "opencode",
  install: "brew install sst/tap/opencode  (or: npm i -g opencode-ai)",

  command: ({ model, prompt, cwd, skillDirs, mcp }) => {
    const config: Record<string, unknown> = {
      // Headless: nothing can wait for a human. stdin is closed anyway, so an
      // approval prompt would deadlock until the node's timeout.
      permission: "allow",
    };
    if (skillDirs.length > 0) config["skills"] = { paths: skillDirs };
    if (mcp.length > 0) config["mcp"] = mcpConfig(mcp);

    return {
      argv: [
        "opencode", "run",
        "--dir", cwd,
        "--model", model,
        "--format", "json",
        "--auto",
        prompt,
      ],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        // This scene's config is the whole config: an unrelated opencode.json
        // in the project would otherwise change what a node does.
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    };
  },

  parse: (res) => {
    if (!res.stdout.trim()) {
      return {
        text: "",
        error: `opencode exited ${res.exitCode ?? "on a signal"} with no output: ${res.stderr.trim().slice(0, 400) || "(nothing on stderr)"}`,
      };
    }

    // `--format json` emits one event per line, and everything real hangs off
    // `part` — verified against opencode 1.18.21, not guessed:
    //
    //   {"type":"text",        "part":{"type":"text","text":"PONG"}}
    //   {"type":"step_finish", "part":{"tokens":{"input":6864,"output":4},"cost":0.0006}}
    //
    // Text parts are concatenated in order rather than last-one-wins: a run with
    // tool calls emits several, and the engine's extractOutputs takes the LAST
    // fenced json block anyway, so keeping the prose costs nothing and keeps the
    // node's reported answer readable.
    const chunks: string[] = [];
    let cost = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let failure = "";

    for (const line of res.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let event: OpencodeEvent;
      try {
        event = JSON.parse(trimmed) as OpencodeEvent;
      } catch {
        continue; // a tool's own stray output, not our business
      }

      const part = event.part ?? {};
      if (event.type === "text" && typeof part.text === "string") chunks.push(part.text);
      if (typeof part.cost === "number") cost += part.cost;
      if (part.tokens) {
        tokensIn += part.tokens.input ?? 0;
        tokensOut += part.tokens.output ?? 0;
      }
      if (event.type === "error") {
        failure = typeof part.message === "string" ? part.message : "opencode reported an error";
      }
    }

    const text = chunks.join("\n").trim();

    // Nothing recognisable in the stream: hand the raw stdout to the engine's
    // extractor rather than discarding a run that may well have answered.
    if (!text && !failure) {
      return {
        text: res.stdout,
        cost,
        tokensIn,
        tokensOut,
        ...(res.exitCode !== 0
          ? { error: `opencode exited ${res.exitCode} and emitted no text: ${res.stderr.trim().slice(0, 400)}` }
          : {}),
      };
    }

    return {
      text,
      cost,
      tokensIn,
      tokensOut,
      ...(failure ? { error: `opencode: ${failure}` } : {}),
      ...(!failure && res.exitCode !== 0 && !text
        ? { error: `opencode exited ${res.exitCode}: ${res.stderr.trim().slice(0, 400)}` }
        : {}),
    };
  },
};

/** The subset of opencode's `--format json` events we read. */
interface OpencodeEvent {
  type?: string;
  part?: {
    type?: string;
    text?: string;
    message?: string;
    cost?: number;
    tokens?: { input?: number; output?: number };
  };
}

registerAgentBackend(opencodeBackend);
