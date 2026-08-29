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

    // `--format json` emits one JSON value per line. We want the assistant text
    // and, if it is reported, the usage. Be forgiving: an unparseable line is
    // noise from a tool, not a reason to fail a node that did the work.
    let text = "";
    let cost = 0;
    let tokensIn = 0;
    let tokensOut = 0;

    for (const line of res.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
      let event: unknown;
      try { event = JSON.parse(trimmed); } catch { continue; }
      text = harvestText(event) ?? text;
      const usage = harvestUsage(event);
      if (usage) {
        cost += usage.cost ?? 0;
        tokensIn += usage.input ?? 0;
        tokensOut += usage.output ?? 0;
      }
    }

    // Nothing recognisable in the stream: hand the raw stdout to the engine's
    // extractor rather than throwing away a run that may well have answered.
    if (!text) text = res.stdout;

    return {
      text,
      cost,
      tokensIn,
      tokensOut,
      ...(res.exitCode !== 0 && !text.trim()
        ? { error: `opencode exited ${res.exitCode}: ${res.stderr.trim().slice(0, 400)}` }
        : {}),
    };
  },
};

/** Pulls assistant prose out of whatever event shape the stream is using. */
function harvestText(event: unknown): string | undefined {
  if (typeof event === "string") return event;
  if (!event || typeof event !== "object") return undefined;
  const e = event as Record<string, unknown>;

  for (const key of ["text", "content", "message", "result", "output"]) {
    const v = e[key];
    if (typeof v === "string" && v.trim()) return v;
    if (v && typeof v === "object") {
      const nested = harvestText(v);
      if (nested) return nested;
    }
  }
  if (Array.isArray(e["parts"])) {
    const joined = e["parts"].map((p) => harvestText(p) ?? "").filter(Boolean).join("\n");
    if (joined) return joined;
  }
  return undefined;
}

function harvestUsage(event: unknown): { cost?: number; input?: number; output?: number } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as Record<string, unknown>;
  const usage = (e["usage"] ?? e["tokens"]) as Record<string, unknown> | undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  if (usage && typeof usage === "object") {
    return {
      ...(num(e["cost"]) !== undefined ? { cost: num(e["cost"]) } : {}),
      ...(num(usage["input"] ?? usage["prompt_tokens"] ?? usage["input_tokens"]) !== undefined
        ? { input: num(usage["input"] ?? usage["prompt_tokens"] ?? usage["input_tokens"]) }
        : {}),
      ...(num(usage["output"] ?? usage["completion_tokens"] ?? usage["output_tokens"]) !== undefined
        ? { output: num(usage["output"] ?? usage["completion_tokens"] ?? usage["output_tokens"]) }
        : {}),
    };
  }
  const cost = num(e["cost"]);
  return cost !== undefined ? { cost } : undefined;
}

registerAgentBackend(opencodeBackend);
