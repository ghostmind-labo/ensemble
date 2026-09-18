// The `model` node kind: the one that calls out. Covers what it sends, what it
// writes, how the graph describes it, and the one constraint that shapes every
// perception graph — Jev cannot see.
import assert from "node:assert/strict";
import {
  choice,
  imageKeys,
  runner,
  validate,
  type Caller,
  type ModelReply,
  type ModelRequest,
  type RunnerSpec,
} from "../src/index.ts";

/** A caller that answers from a script and remembers what it was asked. */
function stub(replies: Array<Partial<ModelReply>>): Caller & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  const call = async (request: ModelRequest): Promise<ModelReply> => {
    seen.push(request);
    const next = replies.shift() ?? {};
    return {
      model: next.model ?? `${request.model}-2026`,
      text: next.text ?? "said something",
      images: next.images ?? [],
      cost: next.cost ?? 0.004,
      usage: next.usage ?? { prompt_tokens: 100, completion_tokens: 20 },
    };
  };
  return Object.assign(call, { seen });
}

// ── 1 · a fixed model, looking at state, writing text ───────────────────────
{
  const brain = runner({
    name: "look",
    inputs: ["goal", "frame"],
    nodes: {
      eyes: {
        model: "google/gemini-2.5-flash",
        system: "you are eyes",
        prompt: (s) => `describe this, task: ${String(s["goal"])}`,
        sees: ["frame"],
        reads: ["goal"],
        writes: ["scene"],
        temperature: 0,
      },
    },
    entry: "eyes",
    result: "scene",
  });

  const caller = stub([{ text: "a clear corridor" }]);
  const { result, run } = await brain({ goal: "patrol", frame: "data:image/png;base64,AA" }, { caller });

  assert.equal(result, "a clear corridor");
  assert.equal(run.steps[0]!.kind, "model");
  assert.equal(run.steps[0]!.cost, 0.004);
  assert.equal((run.steps[0]!.meta as { model: string }).model, "google/gemini-2.5-flash-2026");

  const sent = caller.seen[0]!;
  assert.equal(sent.model, "google/gemini-2.5-flash");
  assert.equal(sent.prompt, "describe this, task: patrol", "a function prompt sees the blackboard");
  assert.equal(sent.system, "you are eyes");
  assert.deepEqual(sent.images, ["data:image/png;base64,AA"]);
  assert.equal(sent.temperature, 0);
  assert.ok(sent.signal, "the run's signal is passed through, so a budget stop cancels the call");
}
console.log("ok · 1 a model node sends its prompt, system, images and temperature");

// ── 2 · the model id can be chosen upstream ─────────────────────────────────
{
  const routed = runner({
    name: "routed",
    inputs: ["goal"],
    nodes: {
      choose: { code: () => "anthropic/claude-sonnet-4.5", writes: ["picked"] },
      write: { model: { from: "picked" }, prompt: "go", writes: ["out"] },
    },
    edges: [{ from: "choose", to: "write" }],
    entry: "choose",
    result: "out",
  });
  const caller = stub([{ text: "done" }]);
  await routed({ goal: "x" }, { caller });
  assert.equal(caller.seen[0]!.model, "anthropic/claude-sonnet-4.5");

  // …and an empty one fails loudly rather than calling a model named ""
  const broken = runner({
    name: "broken",
    nodes: {
      choose: { code: () => "", writes: ["picked"] },
      write: { model: { from: "picked" }, prompt: "go", writes: ["out"] },
    },
    edges: [{ from: "choose", to: "write" }],
    entry: "choose",
  });
  await assert.rejects(() => broken({}, { caller: stub([]) }), /nothing upstream chose one/);
}
console.log("ok · 2 { from } takes the id from state, and an empty one is an error");

// ── 3 · writes is positional here: [text] or [text, images] ─────────────────
{
  const draw = runner({
    name: "draw",
    inputs: ["goal"],
    nodes: { make: { model: "draws/pictures", prompt: "a hero image", writes: ["caption", "picture"] } },
    entry: "make",
  });
  const caller = stub([{ text: "a hero image", images: ["data:image/png;base64,ONE"] }]);
  const { state, run } = await draw({ goal: "launch" }, { caller });

  assert.equal(state["caption"], "a hero image");
  assert.deepEqual(state["picture"], ["data:image/png;base64,ONE"], "images always land as an array");
  assert.equal((run.steps[0]!.meta as { drew?: number }).drew, 1);

  // a text-only model simply writes an empty array to the second key
  const textOnly = stub([{ text: "no pictures here", images: [] }]);
  const { state: plain } = await draw({ goal: "launch" }, { caller: textOnly });
  assert.deepEqual(plain["picture"], []);
}
console.log("ok · 3 [text, images] captures a drawing; images are always an array");

// ── 4 · a generated image can be looked at by the next node ─────────────────
{
  const loop = runner({
    name: "draw-then-check",
    inputs: ["goal"],
    nodes: {
      make: { model: "draws/pictures", prompt: "draw it", writes: ["caption", "picture"] },
      check: { model: "mid/vision", prompt: "does this match the brief?", sees: ["picture"], writes: ["verdict"] },
    },
    edges: [{ from: "make", to: "check" }],
    entry: "make",
    result: "verdict",
  });
  const caller = stub([{ images: ["data:image/png;base64,DREW"] }, { text: "yes it does" }]);
  const { result } = await loop({ goal: "x" }, { caller });

  assert.equal(result, "yes it does");
  assert.deepEqual(caller.seen[1]!.images, ["data:image/png;base64,DREW"], "drawn output feeds straight back in");
}
console.log("ok · 4 what one model draws, the next can see — same shape in and out");

// ── 5 · Jev cannot see, and validate says so by name ────────────────────────
{
  const blind: RunnerSpec = {
    name: "blind",
    inputs: ["goal", "frame"],
    nodes: {
      eyes: { model: "v", prompt: "look", sees: ["frame"], writes: ["scene"] },
      judge: {
        decide: { act: choice("Act?", { yes: null, no: null }) },
        reads: ["goal", "frame"], // ← the mistake
      },
      go: { code: () => 1, writes: ["done"] },
      stop: { code: () => 0, writes: ["done"] },
    },
    edges: [
      { from: "eyes", to: "judge" },
      { from: "judge", to: "go", on: "act=yes" },
      { from: "judge", to: "stop", on: "act=no" },
    ],
    entry: "eyes",
  };
  const problems = validate(blind);
  assert.ok(problems.some((p) => /"frame".*image data and Jev takes text only/s.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /Have a model node look at it/.test(p)), "the message names the fix");

  // image keys are derived, not declared — both what is seen and what is drawn
  assert.deepEqual([...imageKeys(blind)], ["frame"]);
  assert.deepEqual(
    [...imageKeys({ ...blind, nodes: { eyes: { model: "d", prompt: "p", writes: ["cap", "art"] } }, entry: "eyes" })],
    ["art"],
  );
}
console.log("ok · 5 an image key reaching a decide node is refused, with the fix named");

// ── 6 · the other model-node checks ─────────────────────────────────────────
{
  const base = (node: Record<string, unknown>): RunnerSpec => ({
    name: "m",
    nodes: { n: node as never },
    entry: "n",
  });
  assert.ok(validate(base({ model: "", prompt: "p" })).some((p) => /names no model/.test(p)));
  assert.ok(validate(base({ model: "x" })).some((p) => /has no prompt/.test(p)));
  assert.ok(
    validate(base({ model: "x", prompt: "p", writes: ["a", "b", "c"] })).some((p) =>
      /writes at most two keys, positionally/.test(p),
    ),
  );
  assert.ok(
    validate(base({ model: "x", prompt: "p", sees: ["f"], writes: ["t", "f"] })).some((p) =>
      /both looks at and overwrites "f"/.test(p),
    ),
  );
  assert.deepEqual(validate(base({ model: "x", prompt: "p", writes: ["t"] })), []);
}
console.log("ok · 6 a model node needs an id and a prompt, and writes at most two keys");

// ── 7 · the graph describes the call without making it ──────────────────────
{
  const brain = runner({
    name: "g",
    inputs: ["goal", "frame"],
    nodes: {
      eyes: { model: "google/gemini-2.5-flash", prompt: (s) => `see ${String(s["goal"])}`, sees: ["frame"], writes: ["scene"] },
      pick: { code: () => "x", writes: ["chosen"] },
      gen: { model: { from: "chosen" }, prompt: "draw", system: "be terse", writes: ["cap", "art"], maxTokens: 50 },
    },
    edges: [
      { from: "eyes", to: "pick" },
      { from: "pick", to: "gen" },
    ],
    entry: "eyes",
  });
  const graph = brain.graph();
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));

  assert.equal(byId["eyes"]!.kind, "model");
  assert.equal(byId["eyes"]!.cost, "metered");
  assert.equal(byId["eyes"]!.model!.id, "google/gemini-2.5-flash");
  assert.deepEqual(byId["eyes"]!.model!.sees, ["frame"]);
  // a computed prompt ships its source, exactly as a when() branch does
  assert.match((byId["eyes"]!.model!.prompt as { source: string }).source, /see \$\{String\(s\["goal"\]\)\}/);
  assert.deepEqual(byId["gen"]!.model!.prompt, { text: "draw" });
  assert.equal(byId["gen"]!.model!.id, undefined);
  assert.equal(byId["gen"]!.model!.from, "chosen", "a run-time choice is visible in the structure");
  assert.equal(byId["gen"]!.model!.maxTokens, 50);

  // and `frame` is recorded as something the eyes read
  const frame = graph.data.find((d) => d.key === "frame")!;
  assert.deepEqual(frame.readBy, ["eyes"]);
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), graph);
}
console.log("ok · 7 graph.json names the model, the prompt and what the node looks at");

console.log("7 cases");
