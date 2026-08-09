/**
 * The "agent" runtime — our own tool-calling loop. No opencode, no subprocess.
 *
 * The mechanism is a `while`: send the model its tools, execute whatever it asks
 * for, feed the results back, repeat until it answers with content instead of
 * tool calls. That loop *is* "keep going until the goal is reached"; `maxTurns`
 * is the budget that guarantees it terminates.
 *
 * Why we own this rather than renting it: an off-the-shelf coding agent injects
 * ~8,800 tokens of its own system prompt, tool schemas, and personality into
 * every call, and that prompt competes with the scene's output contract. Here
 * the system prompt is the node's prompt plus roughly 200 tokens of scaffolding,
 * and the tool list is assembled per node — a tool a node did not ask for is not
 * denied, it is absent.
 */
import type { NodeResult } from "./model.ts";
import type { McpHub, McpTool } from "../mcp.ts";
import { BUILTIN_TOOLS, type BuiltinTool } from "../tools/builtin.ts";
import type { Skill } from "../registry.ts";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export type { NodeResult };

export interface ToolCallEvent {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  preview: string;
  ms: number;
}

export interface AgentCallRequest {
  model: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature?: number;
  /** Which MCP servers this node may use. Others are not offered at all. */
  mcp: string[];
  /** Built-in tool names this node may use. Empty disables built-ins. */
  builtins: string[];
  /** Skills whose instructions get inlined into the system prompt. */
  skills: Skill[];
  hub: McpHub | undefined;
  root: string;
  maxTurns: number;
  onDelta?: (delta: string) => void;
  onToolCall?: (event: ToolCallEvent) => void;
  signal?: AbortSignal;
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Ceiling on a single tool result entering the conversation.
 *
 * Defence in depth: built-ins cap themselves, but an MCP server is someone
 * else's code and can return anything. Since every prior tool result is resent
 * on each turn, one unbounded response inflates the whole rest of the run.
 */
const MAX_TOOL_RESULT = 8_000;

function clampResult(text: string): string {
  return text.length <= MAX_TOOL_RESULT
    ? text
    : `${text.slice(0, MAX_TOOL_RESULT)}\n… [truncated: ${text.length} chars total — narrow your query to see more]`;
}

function apiKey(): string {
  const key = process.env["OPENROUTER_API_KEY"];
  if (!key) throw new Error("OPENROUTER_API_KEY is not set — ensemble calls OpenRouter directly.");
  return key;
}

function apiModel(ref: string): string {
  if (!ref.startsWith("openrouter/")) throw new Error(`model must be "openrouter/…", got "${ref}"`);
  return ref.slice("openrouter/".length);
}

interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * A skill's SKILL.md body becomes part of the system prompt.
 *
 * Deliberately eager rather than progressive: a graph node has one narrow job and
 * an explicit allowlist, so the file it was given is the file it needs. Making it
 * fetch its own instructions would only add a turn.
 */
function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const blocks = skills.map((skill) => {
    let body = "";
    try {
      body = readFileSync(skill.path, "utf8").replace(/^\s*---[\s\S]*?\n\s*---\n?/, "").trim();
    } catch {
      body = skill.description;
    }
    return `### Skill: ${skill.name}\n\n${body}`;
  });
  return `\n\n## Skills available to you\n\n${blocks.join("\n\n---\n\n")}`;
}

/**
 * The agent node's system prompt.
 *
 * Order is deliberate: the scene author's prompt comes FIRST and dominates —
 * everything after it is operational scaffolding, not personality. This whole
 * block is ~250 tokens; the coding agent we replaced injected ~8,800, and its
 * identity ("you are a coding CLI") actively fought scene-level instructions.
 * Ours has no identity. The node is whatever the scene says it is.
 */
function buildSystem(req: AgentCallRequest, toolCount: number): string {
  const sections: string[] = [];

  sections.push(
    req.system ?? "You are a capable agent. Accomplish the goal using the tools available to you.",
  );

  const skills = renderSkills(req.skills);
  if (skills) sections.push(skills.trim());

  // Grounding that file/tool work actually needs — nothing more.
  sections.push(
    [
      "## Environment",
      `- working directory: ${req.root} (all relative paths resolve here; file tools cannot leave it)`,
      `- directory name: ${basename(req.root)}`,
      `- date: ${new Date().toISOString().slice(0, 10)}`,
      `- platform: ${process.platform}`,
    ].join("\n"),
  );

  if (toolCount > 0) {
    sections.push(
      [
        `## Working with your ${toolCount} tool(s)`,
        "- Request independent tool calls together in one turn — they run in parallel.",
        "- Prefer narrow, specific queries. Long results are truncated (a note says so);",
        "  refine the query rather than re-requesting the same thing.",
        "- If a tool returns an error, read it, fix the arguments or change approach.",
        "  Never repeat an identical failing call.",
        "- Report only what tool results actually showed. Quote concrete evidence",
        "  (file names, values). If something could not be verified, say so plainly.",
        "- Stop as soon as you can answer — do not keep exploring past the goal.",
        "- Your FINAL message is the answer and is parsed programmatically: no",
        "  trailing tool calls, and if the task specifies a json block, end with it.",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

export async function callAgent(req: AgentCallRequest): Promise<NodeResult & { turns: number }> {
  const model = apiModel(req.model);

  // --- assemble this node's tools. Omission is the access control. ---
  const builtins: BuiltinTool[] = BUILTIN_TOOLS.filter((t) => req.builtins.includes(t.name));
  const mcpTools: McpTool[] = req.hub ? req.hub.toolsFor(req.mcp) : [];

  const tools: OpenAITool[] = [
    ...builtins.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
    ...mcpTools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
  ];

  const system = buildSystem(req, tools.length);

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: system },
    ...req.messages,
  ];

  let text = "";
  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let turns = 0;

  while (turns < req.maxTurns) {
    turns++;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      ...(req.signal ? { signal: req.signal } : {}),
      headers: {
        authorization: `Bearer ${apiKey()}`,
        "content-type": "application/json",
        "x-title": "ensemble",
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let detail = body.slice(0, 300);
      try {
        detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? detail;
      } catch {
        /* keep raw */
      }
      return {
        text,
        modelID: model,
        providerID: "openrouter",
        cost,
        tokensIn,
        tokensOut,
        turns,
        error: `OpenRouter ${res.status}: ${detail || res.statusText}`,
      };
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: Record<string, unknown> }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      error?: { message?: string };
    };

    if (payload.error?.message) {
      return {
        text, modelID: model, providerID: "openrouter", cost, tokensIn, tokensOut, turns,
        error: payload.error.message,
      };
    }

    cost += payload.usage?.cost ?? 0;
    tokensIn += payload.usage?.prompt_tokens ?? 0;
    tokensOut += payload.usage?.completion_tokens ?? 0;

    const message = payload.choices?.[0]?.message ?? {};
    messages.push(message);

    const calls = (message["tool_calls"] ?? []) as Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;

    // No tool calls → the model considers itself done. This is the exit.
    if (calls.length === 0) {
      text = typeof message["content"] === "string" ? message["content"] : "";
      if (text) req.onDelta?.(text);
      return { text: text.trim(), modelID: model, providerID: "openrouter", cost, tokensIn, tokensOut, turns };
    }

    // The model may request several tools at once — run them concurrently.
    const results = await Promise.all(
      calls.map(async (call) => {
        const started = Date.now();
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          return { call, output: `invalid JSON arguments: ${call.function.arguments}`, ok: false, ms: 0 };
        }

        try {
          const builtin = builtins.find((t) => t.name === call.function.name);
          const output = builtin
            ? await builtin.run(args, req.root)
            : await (req.hub as McpHub).call(call.function.name, args);
          return { call, output, ok: true, ms: Date.now() - started };
        } catch (err) {
          // Tool errors are fed back as content, not thrown: the model can often
          // recover (fix a path, try another query) given the error text.
          return {
            call,
            output: `error: ${err instanceof Error ? err.message : String(err)}`,
            ok: false,
            ms: Date.now() - started,
          };
        }
      }),
    );

    for (const { call, output, ok, ms } of results) {
      req.onToolCall?.({
        tool: call.function.name,
        args: {},
        ok,
        preview: output.slice(0, 160).replace(/\s+/g, " "),
        ms,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: clampResult(output) });
    }
  }

  return {
    text: text.trim(),
    modelID: model,
    providerID: "openrouter",
    cost,
    tokensIn,
    tokensOut,
    turns,
    error: `agent did not finish within maxTurns (${req.maxTurns}) — raise it or narrow the node's job`,
  };
}
