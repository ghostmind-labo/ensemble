/**
 * The decider — one HTTP call to a System One endpoint, reached through OpenRouter.
 *
 * This is deliberately a thin `fetch` over the documented API rather than the
 * vendor SDK. The endpoint is one POST with a JSON body and a handful of error
 * codes; wrapping it costs sixty lines and buys a package with zero runtime
 * dependencies, which matters more here than it usually would, because this
 * library is meant to be dropped into someone else's server.
 *
 * Why OpenRouter and not TypeSafe directly: OpenRouter serves Jev on a native
 * System One route (`POST /api/v1/systemone`) with the SAME request and the SAME
 * typed, calibrated answers — probabilities, confidence, legend — so nothing
 * about the decision changes. What changes is everything around it: one key and
 * one bill for the decider and every model node, and a billed `usage.cost` on
 * each response instead of a price this file would otherwise have to remember.
 * Someone who holds a TypeSafe key can still point `baseUrl` at
 * `https://api.typesafe.ai/v1`; the request is identical.
 *
 * `Decider` is the seam. Everything downstream depends on that function type,
 * never on Jev, so a fallback implementation — a slower model, a stub in a
 * test, a cache — mounts without touching the engine. That is the whole
 * mitigation for betting the design on one young vendor.
 */
import type { Answer, Question } from "./questions.ts";
import { OPENROUTER_URL } from "./openrouter.ts";

/**
 * $0.042 per million input tokens; output tokens are free. Only a fallback now:
 * OpenRouter reports what each call actually cost, and that figure wins.
 */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** Shared with the model caller, so one base URL and one key reach everything. */
export const DEFAULT_BASE_URL = OPENROUTER_URL;
/** An alias OpenRouter resolves to its newest Jev release (`~typesafe/jev-latest`). */
export const DEFAULT_MODEL = "jev-latest";

export interface JevConfig {
  /** Defaults to `process.env.OPENROUTER_API_KEY` — the same key every model node uses. */
  apiKey?: string;
  /** Defaults to `process.env.OPENROUTER_BASE_URL`, then OpenRouter. `https://api.typesafe.ai/v1` reaches TypeSafe directly. */
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
  /** In USD: what OpenRouter billed when it says, otherwise derived from input tokens. */
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
export type Decider = (
  state: unknown,
  questions: Record<string, Question>,
  options?: DecideOptions,
) => Promise<Decision>;

/**
 * What the engine can tell a decider about the call, beyond the question.
 *
 * Only a signal, and it is optional so any two-argument function is still a
 * `Decider`. It matters because this library is meant to be dropped into
 * someone else's server: without it, a cancelled request — the caller hung up,
 * the budget ran out, the step timed out — abandons the promise while the HTTP
 * call runs on to completion, holding a socket and spending money on an answer
 * nobody will read.
 */
export interface DecideOptions {
  signal?: AbortSignal;
}

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
  400: "the request did not validate",
  401: "invalid or missing API key — check OPENROUTER_API_KEY",
  402: "out of credits — add some at https://openrouter.ai/credits",
  422: "the request did not validate",
  429: "rate limited",
  529: "service overloaded",
};

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

/** A backoff the caller can cut short: waiting out 4s after a cancellation is pure latency. */
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

/** Honour `Retry-After` when the server sends one, otherwise back off exponentially. */
function backoffMs(attempt: number, header: string | null): number {
  const advertised = header ? Number(header) * 1000 : NaN;
  return Number.isFinite(advertised) ? advertised : Math.min(2 ** attempt * 250, 4000);
}

/**
 * The decider's configuration for a runner: its own `jev` block, over whatever
 * the runner already gave OpenRouter. One key set once, in `openrouter`, reaches
 * the decider and every model node alike — which is the point of routing both
 * through the same service. Only where to go and who to be are shared; timeouts
 * and retries stay per-call, because a decision and a generation are not the
 * same length of wait.
 */
export function jevConfigFor(
  openrouter: { apiKey?: string; baseUrl?: string; fetch?: typeof globalThis.fetch } | undefined,
  own: JevConfig | undefined,
): JevConfig {
  const shared = Object.fromEntries(
    Object.entries({ apiKey: openrouter?.apiKey, baseUrl: openrouter?.baseUrl, fetch: openrouter?.fetch }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as JevConfig;
  return { ...shared, ...own };
}

/** Build a decider bound to this configuration. */
export function jev(config: JevConfig = {}): Decider {
  const baseUrl = (config.baseUrl ?? process.env["OPENROUTER_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = config.model ?? DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const retries = config.retries ?? 2;
  const doFetch = config.fetch ?? globalThis.fetch;

  return async function ask(state, questions, options) {
    const caller = options?.signal;
    const apiKey = config.apiKey ?? process.env["OPENROUTER_API_KEY"];
    if (!apiKey) {
      throw new JevError(
        "no OpenRouter key — set OPENROUTER_API_KEY, or pass openrouter: { apiKey } to the runner " +
          "(the decider and every model node share it). Keys come from https://openrouter.ai/keys",
      );
    }

    const body = JSON.stringify({ state, model, questions });
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      caller?.throwIfAborted();
      const timeout = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/systemone`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body,
          signal: caller ? AbortSignal.any([caller, timeout]) : timeout,
        });
      } catch (cause) {
        if (caller?.aborted) throw cause;
        lastError = new JevError(`could not reach ${baseUrl}: ${(cause as Error).message}`, { cause });
        if (attempt < retries) {
          await sleep(backoffMs(attempt, null), caller);
          continue;
        }
        throw lastError;
      }

      if (response.ok) {
        const payload = (await response.json()) as Omit<Decision, "cost" | "usage"> & {
          usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
        };
        const input = payload.usage?.input_tokens ?? 0;
        // The billed figure when the service states one — it knows the price that
        // applied — and the list price times the input tokens when it does not.
        const billed = payload.usage?.cost;
        return {
          model: payload.model,
          answers: payload.answers,
          usage: { input_tokens: input, output_tokens: payload.usage?.output_tokens ?? 0 },
          cost: typeof billed === "number" && Number.isFinite(billed) ? billed : input * USD_PER_INPUT_TOKEN,
        };
      }

      const text = await response.text().catch(() => "");
      const why = MEANING[response.status] ?? "request failed";
      lastError = new JevError(`jev: ${why} (HTTP ${response.status})`, {
        status: response.status,
        body: text.slice(0, 500),
      });

      if (!RETRYABLE.has(response.status) || attempt === retries) throw lastError;
      await sleep(backoffMs(attempt, response.headers.get("retry-after")), caller);
    }

    throw lastError as Error;
  };
}
