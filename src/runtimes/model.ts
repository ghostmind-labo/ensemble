/**
 * The "model" runtime — a direct OpenRouter call.
 *
 * For nodes that only think (prompt → text), opencode is pure overhead: a 61 MB
 * dependency tree and a server spawn to make one HTTP request. This runtime is
 * a single fetch with `stream: true`, which also buys the thing opencode cannot
 * provide at all: real token-by-token deltas for the live view.
 *
 * Cost and token counts come from OpenRouter's `usage` object, which is included
 * automatically in the final SSE chunk of every response.
 */
export interface NodeResult {
  text: string;
  modelID: string;
  providerID: string;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  error?: string;
}

export interface ModelCallRequest {
  /** `openrouter/<vendor>/<model>` — the scene-level format. */
  model: string;
  system?: string;
  /** Prior turns, so a reprompt keeps context — mirrors the agent runtime's sessions. */
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

function apiKey(): string {
  const key = process.env["OPENROUTER_API_KEY"];
  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is not set — runtime \"model\" calls OpenRouter directly and needs it. " +
        "Export it, or switch the node to runtime: \"agent\" to go through opencode.",
    );
  }
  return key;
}

/** `openrouter/anthropic/claude-sonnet-5` → `anthropic/claude-sonnet-5` for the API body. */
function apiModel(ref: string): string {
  if (!ref.startsWith("openrouter/")) {
    throw new Error(`runtime "model" requires an "openrouter/…" model, got "${ref}"`);
  }
  return ref.slice("openrouter/".length);
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}

export async function callModel(req: ModelCallRequest): Promise<NodeResult> {
  const model = apiModel(req.model);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    ...(req.signal ? { signal: req.signal } : {}),
    headers: {
      authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      // Attribution headers OpenRouter asks integrations to send.
      "x-title": "graph",
    },
    body: JSON.stringify({
      model,
      stream: true,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      messages: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        ...req.messages,
      ],
    }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    let detail = body.slice(0, 300);
    try {
      detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? detail;
    } catch {
      // keep raw body
    }
    return {
      text: "",
      modelID: model,
      providerID: "openrouter",
      cost: 0,
      tokensIn: 0,
      tokensOut: 0,
      error: `OpenRouter ${res.status}: ${detail || res.statusText}`,
    };
  }

  // OpenRouter streams SSE: `data: {json}\n\n`, terminated by `data: [DONE]`.
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: Usage | undefined;
  let streamError: string | undefined;

  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (!line.startsWith("data:")) continue; // comments / keep-alives
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        let chunk: {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: Usage;
          error?: { message?: string };
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // partial line split across reads lands back in buffer next pass
        }

        if (chunk.error?.message) streamError = chunk.error.message;

        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          req.onDelta?.(delta);
        }
        // The final chunk carries usage; keep the last one seen.
        if (chunk.usage) usage = chunk.usage;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text: text.trim(),
    modelID: model,
    providerID: "openrouter",
    cost: usage?.cost ?? 0,
    tokensIn: usage?.prompt_tokens ?? 0,
    tokensOut: usage?.completion_tokens ?? 0,
    ...(streamError ? { error: streamError } : {}),
  };
}
