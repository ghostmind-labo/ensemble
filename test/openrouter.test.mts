// The generative caller and the catalogue behind it, against a mocked fetch.
// Offline: nothing here reaches OpenRouter.
import assert from "node:assert/strict";
import { catalog, forgetCatalog, modelOptions, openrouter, OpenRouterError, shortlist } from "../src/index.ts";

process.env["OPENROUTER_API_KEY"] = "test-key";

function mock(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
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

const CATALOG = {
  data: [
    {
      id: "cheap/text",
      name: "Cheap Text",
      context_length: 128_000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
      pricing: { prompt: "0.0000001", completion: "0.0000004" },
    },
    {
      id: "mid/vision",
      name: "Mid Vision",
      context_length: 1_000_000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
      pricing: { prompt: "0.000003", completion: "0.000015" },
    },
    {
      id: "draws/pictures",
      name: "Draws Pictures",
      context_length: 32_000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["image", "text"] },
      supported_parameters: [],
      pricing: { prompt: "0.0000003", completion: "0.0000025", image_output: "0.00003" },
    },
  ],
};

// ── 1 · the catalogue turns raw json into capability facts ──────────────────
forgetCatalog();
{
  const fetch = mock([{ status: 200, body: CATALOG }]);
  const models = await catalog({ fetch });
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));

  assert.equal(byId["cheap/text"]!.vision, false);
  assert.equal(byId["mid/vision"]!.vision, true);
  assert.equal(byId["mid/vision"]!.draws, false, "it SEES images; it does not make them");
  assert.equal(byId["draws/pictures"]!.draws, true);
  assert.equal(byId["draws/pictures"]!.imageUsd, 0.00003);
  assert.equal(byId["cheap/text"]!.tools, true);
  assert.equal(byId["draws/pictures"]!.tools, false);
  assert.equal(byId["mid/vision"]!.promptUsd * 1e6, 3, "$3 per million input tokens");

  // cached in-process, so a second read costs nothing
  await catalog({ fetch });
  assert.equal(fetch.calls.length, 1);
  forgetCatalog();
}
console.log("ok · 1 the catalogue reads vision, drawing, tools and price, and caches");

// ── 2 · shortlist filters on numbers and booleans — never a model's opinion ──
{
  const fetch = mock([{ status: 200, body: CATALOG }]);
  const models = await catalog({ fetch });

  assert.deepEqual(shortlist(models, { vision: true }).map((m) => m.id), ["draws/pictures", "mid/vision"]);
  assert.deepEqual(shortlist(models, { draws: true }).map((m) => m.id), ["draws/pictures"]);
  assert.deepEqual(shortlist(models, { tools: true, minContext: 500_000 }).map((m) => m.id), ["mid/vision"]);
  assert.deepEqual(shortlist(models, { maxPromptUsdPerM: 1 }).map((m) => m.id), ["cheap/text", "draws/pictures"]);
  assert.deepEqual(shortlist(models, { idIncludes: "draws/" }).map((m) => m.id), ["draws/pictures"]);

  // cheapest first, and the Choice ceiling is enforced whatever you ask for
  assert.deepEqual(shortlist(models).map((m) => m.id), ["cheap/text", "draws/pictures", "mid/vision"]);
  assert.equal(shortlist(models, { limit: 2 }).length, 2);
  const many = Array.from({ length: 400 }, (_, i) => ({ ...models[0]!, id: `m${i}` }));
  assert.equal(shortlist(many, { limit: 400 }).length, 255, "Choice accepts at most 255 options");
  forgetCatalog();
}
console.log("ok · 2 shortlist filters in code, cheapest first, capped at Choice's limit");

// ── 3 · modelOptions is ready to hand to choice() ───────────────────────────
{
  const fetch = mock([{ status: 200, body: CATALOG }]);
  const options = modelOptions(shortlist(await catalog({ fetch }), { draws: true }));
  assert.deepEqual(Object.keys(options), ["draws/pictures"]);
  assert.match(options["draws/pictures"]!.what, /\$0\.30\/M in/);
  assert.match(options["draws/pictures"]!.what, /makes images/);
  assert.match(options["draws/pictures"]!.what, /sees images/);
  forgetCatalog();
}
console.log("ok · 3 modelOptions states price and capability, tersely — every option costs tokens");

// ── 4 · a text call ─────────────────────────────────────────────────────────
{
  const fetch = mock([
    {
      status: 200,
      body: {
        model: "cheap/text-2026",
        choices: [{ message: { content: "hello there" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.000042 },
      },
    },
  ]);
  const reply = await openrouter({ fetch })({ model: "cheap/text", prompt: "hi", system: "be brief" });

  assert.equal(reply.text, "hello there");
  assert.equal(reply.model, "cheap/text-2026", "the versioned model that actually answered");
  assert.equal(reply.cost, 0.000042, "OpenRouter prices the call; we do not guess");
  assert.deepEqual(reply.images, []);

  const call = fetch.calls[0]!;
  assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal((call.init.headers as Record<string, string>)["authorization"], "Bearer test-key");
  const body = JSON.parse(String(call.init.body));
  assert.deepEqual(body.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(body.usage, { include: true }, "so the reply carries its own cost");
}
console.log("ok · 4 a text call sends plain content and reports OpenRouter's own cost");

// ── 5 · vision: images become content parts ─────────────────────────────────
{
  const fetch = mock([
    { status: 200, body: { choices: [{ message: { content: "a corridor" } }], usage: { cost: 0.001 } } },
  ]);
  await openrouter({ fetch })({
    model: "mid/vision",
    prompt: "what do you see?",
    images: ["https://example.com/a.jpg", "data:image/png;base64,AAAA"],
  });
  const body = JSON.parse(String(fetch.calls[0]!.init.body));
  assert.deepEqual(body.messages[0].content, [
    { type: "text", text: "what do you see?" },
    { type: "image_url", image_url: { url: "https://example.com/a.jpg" } },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ]);
}
console.log("ok · 5 images are sent as content parts alongside the text");

// ── 6 · generation: images come back as data: urls ──────────────────────────
{
  const fetch = mock([
    {
      status: 200,
      body: {
        choices: [
          {
            message: {
              content: "",
              images: [
                { type: "image_url", image_url: { url: "data:image/png;base64,ONE" } },
                { type: "image_url", image_url: { url: "data:image/png;base64,TWO" } },
              ],
            },
          },
        ],
        usage: { cost: 0.06 },
      },
    },
  ]);
  const reply = await openrouter({ fetch })({ model: "draws/pictures", prompt: "a hero image" });
  assert.deepEqual(reply.images, ["data:image/png;base64,ONE", "data:image/png;base64,TWO"]);
  assert.equal(reply.text, "", "an image model may answer with pictures and no prose");
}
console.log("ok · 6 generated images come back as data: urls, empty prose and all");

// ── 7 · errors ──────────────────────────────────────────────────────────────
{
  const saved = process.env["OPENROUTER_API_KEY"];
  delete process.env["OPENROUTER_API_KEY"];
  const none = mock([{ status: 200 }]);
  await assert.rejects(() => openrouter({ fetch: none })({ model: "x", prompt: "y" }), /OPENROUTER_API_KEY/);
  assert.equal(none.calls.length, 0, "nothing was sent");
  process.env["OPENROUTER_API_KEY"] = saved;

  const denied = mock([{ status: 401 }]);
  await assert.rejects(() => openrouter({ fetch: denied, retries: 3 })({ model: "x", prompt: "y" }), (error: Error) => {
    assert.ok(error instanceof OpenRouterError);
    assert.match(error.message, /rejected the key/);
    return true;
  });
  assert.equal(denied.calls.length, 1, "a bad key is not worth retrying");

  const flaky = mock([
    { status: 429, headers: { "retry-after": "0" } },
    { status: 200, body: { choices: [{ message: { content: "ok" } }], usage: { cost: 0 } } },
  ]);
  assert.equal((await openrouter({ fetch: flaky })({ model: "x", prompt: "y" })).text, "ok");
  assert.equal(flaky.calls.length, 2);

  const empty = mock([{ status: 200, body: { choices: [{ message: { content: "" } }] } }]);
  await assert.rejects(() => openrouter({ fetch: empty })({ model: "x", prompt: "y" }), /neither text nor images/);
}
console.log("ok · 7 a missing key, a bad key, a rate limit and an empty reply each fail correctly");

console.log("7 cases");
