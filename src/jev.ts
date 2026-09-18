/**
 * The decider — one HTTP call to TypeSafe's System One endpoint.
 *
 * This is deliberately a thin `fetch` over the documented API rather than the
 * vendor SDK. The endpoint is one POST with a JSON body and four error codes;
 * wrapping it costs sixty lines and buys a package with zero runtime
 * dependencies, which matters more here than it usually would, because this
 * library is meant to be dropped into someone else's server.
 *
 * `Decider` is the seam. Everything downstream depends on that function type,
 * never on Jev, so a fallback implementation — a slower model, a stub in a
 * test, a cache — mounts without touching the engine. That is the whole
 * mitigation for betting the design on one young vendor.
 */
import type { Answer, Question } from "./questions.ts";

/** $0.042 per million input tokens. Output tokens are free. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";

export interface JevConfig {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Retries for 429 / 5xx, with backoff. Default 2. */
  retries?: number;
  fetch?: typeof globalThis.fetch;
}

export interface Decision {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
  /** Derived from usage, in USD. */
  cost: number;
}

/**
 * Ask a set of questions about one state.
 *
 * Every implementation must evaluate the questions INDEPENDENTLY — one answer
 * may never become context for another. That property is what lets a caller
 * ask a dozen speculative questions in one round trip and decide in code which
 * ones mattered.
 */
export type Decider = (state: unknown, questions: Record<string, Question>) => Promise<Decision>;

export class JevError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, options: { status?: number; body?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "JevError";
    this.status = options.status;
    this.body = options.body;
  }
}

const MEANING: Record<number, string> = {
  401: "invalid or missing API key — set TYPESAFE_API_KEY",
  422: "the request did not validate",
  429: "rate limited",
  529: "service overloaded",
};

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Honour `Retry-After` when the server sends one, otherwise back off exponentially. */
function backoffMs(attempt: number, header: string | null): number {
  const advertised = header ? Number(header) * 1000 : NaN;
  return Number.isFinite(advertised) ? advertised : Math.min(2 ** attempt * 250, 4000);
}

/** Build a decider bound to this configuration. */
export function jev(config: JevConfig = {}): Decider {
  const baseUrl = (config.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = config.model ?? DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const retries = config.retries ?? 2;
  const doFetch = config.fetch ?? globalThis.fetch;

  return async function ask(state, questions) {
    const apiKey = config.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!apiKey) {
      throw new JevError(
        "no TypeSafe API key — set TYPESAFE_API_KEY, or pass jev: { apiKey } to the runner. " +
          "Keys come from https://console.typesafe.ai/settings/keys",
      );
    }

    const body = JSON.stringify({ state, model, questions });
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/v1/systemone`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body,
          signal: timeout,
        });
      } catch (cause) {
        lastError = new JevError(`could not reach ${baseUrl}: ${(cause as Error).message}`, { cause });
        if (attempt < retries) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
        throw lastError;
      }

      if (response.ok) {
        const payload = (await response.json()) as Omit<Decision, "cost">;
        const inputTokens = payload.usage?.input_tokens ?? 0;
        return { ...payload, cost: inputTokens * USD_PER_INPUT_TOKEN };
      }

      const text = await response.text().catch(() => "");
      const why = MEANING[response.status] ?? "request failed";
      lastError = new JevError(`jev: ${why} (HTTP ${response.status})`, {
        status: response.status,
        body: text.slice(0, 500),
      });

      if (!RETRYABLE.has(response.status) || attempt === retries) throw lastError;
      await sleep(backoffMs(attempt, response.headers.get("retry-after")));
    }

    throw lastError as Error;
  };
}
