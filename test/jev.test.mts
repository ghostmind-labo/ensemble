// The decider client, against a mocked fetch. Offline by construction: the
// suite never reaches the network and needs no key beyond a fake one.
import assert from "node:assert/strict";
import { choice, jev, jevConfigFor, JevError, noul, runner, USD_PER_INPUT_TOKEN } from "../src/index.ts";

process.env["OPENROUTER_API_KEY"] = "test-key";

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch that replays a queue of responses and records what it was asked. */
function mock(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 500 };
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers,
    });
  };
  return Object.assign(fetch as unknown as typeof globalThis.fetch, { calls });
}

const ok = (answers: unknown, inputTokens = 1000) => ({
  status: 200,
  body: { model: "jev-1.13.0", answers, usage: { input_tokens: inputTokens, output_tokens: 40 } },
});

const questions = { team: choice("Which?", { a: null, b: null }), sure: noul("Sure?") };

// ── 1 · the request is exactly what the HTTP API documents ──────────────────
{
  const fetch = mock([ok({ team: { type: "choice", choice: "a", confidence: 1, probabilities: { a: 1 } } })]);
  await jev({ fetch })({ goal: "hello" }, questions);

  const call = fetch.calls[0]!;
  assert.equal(call.url, "https://openrouter.ai/api/v1/systemone", "Jev is reached through OpenRouter's System One route");
  assert.equal(call.init.method, "POST");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], "Bearer test-key");
  assert.equal(headers["content-type"], "application/json");

  const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.deepEqual(body["state"], { goal: "hello" });
  assert.equal(body["model"], "jev-latest");
  assert.deepEqual(Object.keys(body["questions"] as object), ["team", "sure"]);
}
console.log("ok · 1 the request carries state, model and questions, with a bearer token");

// ── 2 · cost comes from input tokens; output is free ────────────────────────
{
  const fetch = mock([ok({ team: { type: "choice", choice: "a", confidence: 1, probabilities: { a: 1 } } }, 250_000)]);
  const decision = await jev({ fetch })("x", questions);
  assert.equal(decision.model, "jev-1.13.0", "the versioned id that answered, not the alias asked for");
  assert.equal(decision.cost, 250_000 * USD_PER_INPUT_TOKEN);
  assert.ok(decision.cost < 0.011, "a quarter-million tokens is about a cent");
}
console.log("ok · 2 cost is input tokens only — output is free");

// ── 3 · a missing key fails before any request is made ──────────────────────
{
  const saved = process.env["OPENROUTER_API_KEY"];
  delete process.env["OPENROUTER_API_KEY"];
  const fetch = mock([ok({})]);
  await assert.rejects(() => jev({ fetch })("x", questions), (error: Error) => {
    assert.ok(error instanceof JevError);
    assert.match(error.message, /OPENROUTER_API_KEY/);
    assert.match(error.message, /openrouter\.ai\/keys/, "it says where a key comes from");
    return true;
  });
  assert.equal(fetch.calls.length, 0, "nothing was sent");
  process.env["OPENROUTER_API_KEY"] = saved;
}
console.log("ok · 3 no key means no request, and a message naming the fix");

// ── 4 · 429 is retried; 401 and 422 are not ─────────────────────────────────
{
  const flaky = mock([
    { status: 429, headers: { "retry-after": "0" } },
    ok({ team: { type: "choice", choice: "b", confidence: 0.8, probabilities: { b: 0.8 } } }),
  ]);
  const decision = await jev({ fetch: flaky })("x", questions);
  assert.equal(flaky.calls.length, 2, "it backed off and tried again");
  assert.equal((decision.answers["team"] as { choice: string }).choice, "b");

  for (const [status, pattern] of [
    [401, /invalid or missing API key/],
    [422, /did not validate/],
  ] as const) {
    const fetch = mock([{ status, body: { detail: "nope" } }]);
    await assert.rejects(() => jev({ fetch, retries: 3 })("x", questions), (error: Error) => {
      assert.ok(error instanceof JevError);
      assert.equal((error as JevError).status, status);
      assert.match(error.message, pattern);
      return true;
    });
    assert.equal(fetch.calls.length, 1, `HTTP ${status} is not worth retrying`);
  }
}
console.log("ok · 4 rate limits are retried; auth and validation errors are not");

// ── 5 · retries are finite, and the last error is the one raised ────────────
{
  const fetch = mock([
    { status: 529 },
    { status: 529 },
    { status: 529 },
    { status: 529 },
  ]);
  await assert.rejects(() => jev({ fetch, retries: 2 })("x", questions), (error: Error) => {
    assert.match(error.message, /overloaded/);
    return true;
  });
  assert.equal(fetch.calls.length, 3, "the first attempt plus two retries");
}
console.log("ok · 5 retries are bounded, and the failure names the status");

// ── 6 · the base url and model are configurable ─────────────────────────────
{
  const fetch = mock([ok({ sure: { type: "noul", noul: 0.9 } })]);
  await jev({ fetch, baseUrl: "https://proxy.internal/", model: "jev-1.13.0" })("x", { sure: noul("Sure?") });
  assert.equal(fetch.calls[0]!.url, "https://proxy.internal/systemone", "a trailing slash is tolerated");
  assert.equal(JSON.parse(String(fetch.calls[0]!.init.body))["model"], "jev-1.13.0");
}
console.log("ok · 6 base url and model can be pointed elsewhere");

// ── 7 · a billed cost wins over the list price ──────────────────────────────
{
  // OpenRouter states what each call cost. That figure knows the price that
  // actually applied; the constant here is only what the list said once.
  const fetch = mock([
    { status: 200, body: { model: "typesafe/jev-1.13-20260917", answers: { sure: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 } } },
  ]);
  const decision = await jev({ fetch })("x", { sure: noul("Sure?") });
  assert.equal(decision.cost, 0.000019992, "the billed figure, not 476 × the list price");
  assert.deepEqual(decision.usage, { input_tokens: 476, output_tokens: 70 });
}
console.log("ok · 7 a billed usage.cost is the cost");

// ── 8 · one key, set once, reaches the decider ──────────────────────────────
{
  const saved = process.env["OPENROUTER_API_KEY"];
  delete process.env["OPENROUTER_API_KEY"];
  const fetch = mock([ok({ sure: { type: "noul", noul: 0.9 } })]);
  // The key goes where the model nodes already look for it. The decider reads
  // it from there, so a runner names its one credential in one place.
  const r = runner({
    name: "one-key",
    openrouter: { apiKey: "shared-key", fetch },
    nodes: { ask: { decide: { sure: noul("Sure?") }, reads: ["goal"] }, done: { code: () => "done" } },
    edges: [{ from: "ask", to: "done" }],
    entry: "ask",
  });
  await r({ goal: "x" });
  assert.equal(fetch.calls.length, 1);
  assert.equal(new Headers(fetch.calls[0]!.init.headers).get("authorization"), "Bearer shared-key");
  assert.equal(fetch.calls[0]!.url, "https://openrouter.ai/api/v1/systemone");
  // And a decider-specific setting still wins where one is given.
  assert.equal(jevConfigFor({ apiKey: "shared" }, { apiKey: "own" }).apiKey, "own");
  assert.equal(jevConfigFor({ apiKey: "shared" }, { model: "jev-1.13" }).apiKey, "shared");
  process.env["OPENROUTER_API_KEY"] = saved;
}
console.log("ok · 8 the runner's one OpenRouter key reaches the decider");

console.log("8 cases");
