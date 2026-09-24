/**
 * The caller — one HTTP call to OpenRouter, and the catalogue behind it.
 *
 * This library was built on the rule that it never calls a model. That rule was
 * right for a router and wrong for a brain: something that perceives has to
 * *look*, and Jev is text-only by construction. So generation lives here, in
 * one place, behind one seam.
 *
 * Two jobs, and the second is the interesting one:
 *
 *   `chat`     — call a model. Text, or text plus images.
 *   `catalog`  — what models exist, what they cost, and what they can SEE.
 *
 * The catalogue exists because "which model should handle this?" is a real
 * decision and a bad one to hardcode. But note the division of labour, because
 * it is the whole thesis in miniature: code filters the 445 models down by
 * price and capability — those are NUMBERS and booleans — and only then does
 * Jev choose among what is left, on fit. Asking Jev "which of these is under
 * two dollars" would be asking a model documented as unreliable at arithmetic
 * to do arithmetic.
 */

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

export interface ModelCard {
  id: string;
  name: string;
  contextLength: number;
  /** Accepts images. The only reason a perception node can exist. */
  vision: boolean;
  /** RETURNS images. The only reason a generation node can exist. */
  draws: boolean;
  /** Accepts tool definitions. */
  tools: boolean;
  /** USD per input token. Multiply by 1e6 for the familiar per-million figure. */
  promptUsd: number;
  /** USD per output token. */
  completionUsd: number;
  /** USD per generated image, when the model draws. */
  imageUsd: number;
}

export interface CallerConfig {
  /** Defaults to `process.env.OPENROUTER_API_KEY`. */
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  fetch?: typeof globalThis.fetch;
  /** Sent as HTTP-Referer / X-Title, which is how OpenRouter attributes traffic. */
  app?: { url?: string; title?: string };
}

export interface ModelRequest {
  model: string;
  prompt: string;
  system?: string;
  /** Image URLs or data: URLs. Requires a model whose card says `vision`. */
  images?: string[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ModelReply {
  /** The versioned model that actually answered. */
  model: string;
  text: string;
  /**
   * Images the model DREW, as data: URLs. Empty for a text model.
   *
   * They come back in the same shape images go out in, which is what lets a
   * generated frame be fed straight back to a vision model on the next node
   * without anything in between having to know it was generated.
   */
  images: string[];
  cost: number;
  usage: { prompt_tokens: number; completion_tokens: number };
}

/** The seam. Swap it for a stub, a cache, a different vendor. */
export type Caller = (request: ModelRequest) => Promise<ModelReply>;

export class OpenRouterError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, options: { status?: number; body?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "OpenRouterError";
    this.status = options.status;
    this.body = options.body;
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
/** A backoff the caller can cut short: waiting out 8s after a cancellation is pure latency. */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

const backoffMs = (attempt: number, header: string | null): number => {
  const advertised = header ? Number(header) * 1000 : NaN;
  return Number.isFinite(advertised) ? advertised : Math.min(2 ** attempt * 400, 8000);
};

/* ──────────────────────────────── catalogue ──────────────────────────────── */

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string; image_output?: string; image?: string };
}

const card = (raw: RawModel): ModelCard => ({
  id: raw.id,
  name: raw.name ?? raw.id,
  contextLength: raw.context_length ?? 0,
  vision: (raw.architecture?.input_modalities ?? []).includes("image"),
  draws: (raw.architecture?.output_modalities ?? []).includes("image"),
  tools: (raw.supported_parameters ?? []).includes("tools"),
  promptUsd: Number(raw.pricing?.prompt ?? 0),
  completionUsd: Number(raw.pricing?.completion ?? 0),
  imageUsd: Number(raw.pricing?.image_output ?? raw.pricing?.image ?? 0),
});

/**
 * Cached per SOURCE, not globally.
 *
 * One process can hold several callers — a host app serving two tenants, a test
 * replacing `fetch`, a proxy on another `baseUrl` — and a single slot would hand
 * the first one's catalogue to all of them. So the key is what actually decides
 * the answer: where it came from, and who fetched it.
 */
const cached = new Map<string, { at: number; models: ModelCard[] }>();
const CATALOG_TTL_MS = 10 * 60_000;

// A custom `fetch` is part of the identity of the source, but a function is not
// a string. Give each one a stable tag, held weakly so tagging a short-lived
// client does not keep the client itself alive.
const tags = new WeakMap<object, string>();
let nextTag = 0;
const tagOf = (fn: object): string => {
  let tag = tags.get(fn);
  if (!tag) tags.set(fn, (tag = `f${++nextTag}`));
  return tag;
};

/** Every model OpenRouter serves, as capability data. Cached in-process for ten minutes, per source. */
export async function catalog(config: CallerConfig = {}, signal?: AbortSignal): Promise<ModelCard[]> {
  const doFetch = config.fetch ?? globalThis.fetch;
  const baseUrl = (config.baseUrl ?? OPENROUTER_URL).replace(/\/+$/, "");
  const key = config.fetch ? `${baseUrl}\u0000${tagOf(config.fetch)}` : baseUrl;

  const hit = cached.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.models;
  // Stale entries are dropped as we go, so the map holds one catalogue per
  // source actually used in the last ten minutes and not one per client ever built.
  for (const [at, entry] of cached) if (Date.now() - entry.at >= CATALOG_TTL_MS) cached.delete(at);

  const timeout = AbortSignal.timeout(config.timeoutMs ?? 30_000);
  const response = await doFetch(`${baseUrl}/models`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    throw new OpenRouterError(`could not read the model catalogue (HTTP ${response.status})`, {
      status: response.status,
    });
  }
  const payload = (await response.json()) as { data?: RawModel[] };
  const models = (payload.data ?? []).map(card);
  cached.set(key, { at: Date.now(), models });
  return models;
}

/** Drop the cache — for tests, and for a long-lived process that wants fresh prices. */
export const forgetCatalog = (): void => {
  cached.clear();
};

export interface ModelFilter {
  /** Must accept images. */
  vision?: boolean;
  /** Must RETURN images — an image generator. */
  draws?: boolean;
  /** Must accept tool definitions. */
  tools?: boolean;
  /** Ceiling on input price, in USD per MILLION tokens — the unit people quote. */
  maxPromptUsdPerM?: number;
  maxCompletionUsdPerM?: number;
  minContext?: number;
  /** Substring match on the id, e.g. "anthropic/" or "gemini". */
  idIncludes?: string;
  /** Keep only the n cheapest that survive. Choice accepts at most 255 options. */
  limit?: number;
}

/**
 * Filter the catalogue in CODE, on numbers and booleans.
 *
 * This is the step that must not be delegated. Price ceilings and "can it see"
 * are arithmetic and facts; a classifier has no business with either, and
 * there are 445 models against Choice's limit of 255 regardless.
 */
export function shortlist(models: ModelCard[], filter: ModelFilter = {}): ModelCard[] {
  const kept = models.filter((m) => {
    if (filter.vision !== undefined && m.vision !== filter.vision) return false;
    if (filter.draws !== undefined && m.draws !== filter.draws) return false;
    if (filter.tools !== undefined && m.tools !== filter.tools) return false;
    if (filter.minContext !== undefined && m.contextLength < filter.minContext) return false;
    if (filter.idIncludes !== undefined && !m.id.includes(filter.idIncludes)) return false;
    if (filter.maxPromptUsdPerM !== undefined && m.promptUsd * 1e6 > filter.maxPromptUsdPerM) return false;
    if (filter.maxCompletionUsdPerM !== undefined && m.completionUsd * 1e6 > filter.maxCompletionUsdPerM) return false;
    return true;
  });
  kept.sort((a, b) => a.promptUsd - b.promptUsd || a.id.localeCompare(b.id));
  return kept.slice(0, Math.min(filter.limit ?? 255, 255));
}

/**
 * Turn a shortlist into `choice` criteria, so Jev can pick on FIT.
 *
 * Descriptions stay terse because every option is input tokens, and the price
 * is stated because "cheap or capable" is a judgement worth letting the model
 * weigh once code has ruled out what is unaffordable outright.
 */
export function modelOptions(models: ModelCard[]): Record<string, { what: string }> {
  return Object.fromEntries(
    models.map((m) => [
      m.id,
      {
        what:
          `${m.name} · $${(m.promptUsd * 1e6).toFixed(2)}/M in` +
          `${m.vision ? " · sees images" : ""}${m.draws ? ` · makes images ($${m.imageUsd.toFixed(5)} each)` : ""}` +
          `${m.tools ? " · tools" : ""} · ${Math.round(m.contextLength / 1000)}k context`,
      },
    ]),
  );
}

/* ───────────────────────────────── calling ───────────────────────────────── */

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** Build a caller bound to this configuration. */
export function openrouter(config: CallerConfig = {}): Caller {
  const baseUrl = (config.baseUrl ?? process.env["OPENROUTER_BASE_URL"] ?? OPENROUTER_URL).replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 120_000;
  const retries = config.retries ?? 2;
  const doFetch = config.fetch ?? globalThis.fetch;

  return async function chat(request) {
    const apiKey = config.apiKey ?? process.env["OPENROUTER_API_KEY"];
    if (!apiKey) {
      throw new OpenRouterError(
        "no OpenRouter key — set OPENROUTER_API_KEY, or pass openrouter: { apiKey } to the runner. " +
          "Keys come from https://openrouter.ai/keys",
      );
    }

    const content: ContentPart[] | string = request.images?.length
      ? [
          { type: "text", text: request.prompt },
          ...request.images.map((url): ContentPart => ({ type: "image_url", image_url: { url } })),
        ]
      : request.prompt;

    const body = JSON.stringify({
      model: request.model,
      messages: [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        { role: "user", content },
      ],
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      // Ask OpenRouter to price the call for us, rather than guessing from the
      // catalogue — it knows which provider actually served it.
      usage: { include: true },
    });

    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };
    if (config.app?.url) headers["http-referer"] = config.app.url;
    if (config.app?.title) headers["x-title"] = config.app.title;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      request.signal?.throwIfAborted();
      const signal = request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body, signal });
      } catch (cause) {
        lastError = new OpenRouterError(`could not reach ${baseUrl}: ${(cause as Error).message}`, { cause });
        if (request.signal?.aborted || attempt === retries) throw lastError;
        await sleep(backoffMs(attempt, null), request.signal);
        continue;
      }

      if (response.ok) {
        const payload = (await response.json()) as {
          model?: string;
          choices?: Array<{
            message?: { content?: string; images?: Array<{ image_url?: { url?: string } }> };
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        };
        const message = payload.choices?.[0]?.message;
        const images = (message?.images ?? [])
          .map((entry) => entry.image_url?.url)
          .filter((url): url is string => typeof url === "string");
        // An image model may answer with pictures and no prose, so empty text
        // is only a failure when nothing came back at all.
        const text = message?.content ?? "";
        if (typeof text !== "string" || (text === "" && images.length === 0)) {
          throw new OpenRouterError("OpenRouter returned neither text nor images", {
            body: JSON.stringify(payload).slice(0, 500),
          });
        }
        return {
          model: payload.model ?? request.model,
          text,
          images,
          cost: payload.usage?.cost ?? 0,
          usage: {
            prompt_tokens: payload.usage?.prompt_tokens ?? 0,
            completion_tokens: payload.usage?.completion_tokens ?? 0,
          },
        };
      }

      const detail = await response.text().catch(() => "");
      lastError = new OpenRouterError(
        response.status === 401
          ? "OpenRouter rejected the key (HTTP 401) — check OPENROUTER_API_KEY"
          : `OpenRouter request failed (HTTP ${response.status})`,
        { status: response.status, body: detail.slice(0, 500) },
      );
      if (!RETRYABLE.has(response.status) || attempt === retries) throw lastError;
      await sleep(backoffMs(attempt, response.headers.get("retry-after")), request.signal);
    }

    throw lastError as Error;
  };
}
