# ensemble API reference (v2, ≥ 0.26)

Everything is imported from `@ghostmind-dev/ensemble`. When in doubt, the
installed package's `dist/*.d.ts` is the source of truth, so read it rather than
guessing.

## Contents
1. runner(spec)
2. The three questions
3. Node kinds: decide · work · code · model · mcp
4. Edges and the `on:` grammar
5. State and writes
6. Handlers
7. Calling a runner: RunOptions, outcome, errors
8. Other exports

---

## 1. runner(spec)

```ts
export default runner({
  name: "triage",                 // required; appears in graph.json and run ids
  description?: "one line",
  inputs?: ["goal", "path"],      // keys that arrive from outside; goal is always one
  work?: { handlerName: (ctx) => value },
  nodes: { nodeName: NodeSpec },  // required, at least one
  edges?: Edge[],
  entry: "nodeName",              // required; where the run starts
  result?: "stateKey",            // returned as `result`; defaults to the last step's value
  jev?: { model?, baseUrl?, retries?, timeoutMs?, apiKey?, fetch? },
  openrouter?: { apiKey?, baseUrl?, retries?, timeoutMs?, app?, fetch? },
  skills?: Skill[],               // from loadSkills(); needed by model nodes that inline skills
  mcpServers?: { name: { command, args?, env?, cwd?, timeoutMs? } },
});
```

`runner()` doesn't validate when it is built, so a broken runner can still be
inspected. It returns a callable with `.spec`, `.validate(): string[]` and
`.graph(): GraphDoc`. Calling it runs it, and it refuses to start if validation
fails.

The CLI loads a file's **default export**, so always `export default runner({...})`.

## 2. The three questions

```ts
choice(instructions, { optionName: Description | null, ... })  // 2..255 options
score(instructions, [level0, level1, ...])                     // 2..10 levels, low → high
noul(instructions, { true: Description, false: Description }?) // yes/no
```

| Builder | On state | In run.json |
|---|---|---|
| `choice` | the option name (string) | `probabilities`, `confidence` |
| `score` | a **fractional** expected level: 0-based, Σ level·P | `probabilities`, `confidence`, `legend` |
| `noul` | P(yes), 0–1 | the number is its own confidence |

`Instructions` is a string, or
`{ question?: string, focus?: string, inspect?: string, compare?: string[] }`.
`inspect` and `compare` hold backticked state paths, e.g. ``"`goal`"``.

`Description` is a string, or `{ what, not_for, examples?, signals?, summary? }`.
Always prefer the object form with `what` + `not_for`.

Option names and question keys become state keys and branch labels, so use
identifier-like names: `billing`, `needs_text`, not `"Needs Text?"`.

Score levels are counted from 0. A 3-level score returns 0.0–2.0, and `1.3` means
"mostly level 1, some level 2".

## 3. Node kinds

A node is **exactly one** kind, told apart by its key. There is no `type:` field.

### decide: one Jev call

```ts
classify: {
  decide: { team: choice(...), urgent: noul(...), severity: score(...) },
  reads: ["goal", "customer_plan"],   // REQUIRED, non-empty: the only keys sent
  gate?: { on: "team", min: 0.7, to: "escalate" },
  label?: "Classify the ticket",
}
```

- Writes one state key per question, with the same name as the question.
- All questions in one node go out in one request and are answered
  independently.
- `gate` works only on a `choice` or a `score`. Below `min` confidence the run
  goes to `to` whatever the edges say, and the step records `took: "gate"`.
- `reads` must never include an image key. Validation refuses it.

### work: a handler the user wrote

```ts
send: { work: "billing", reads?: ["goal"], writes?: ["reply"], label? }
```

`work` names a key of the runner's `work` map. `reads` only declares data flow,
because the handler sees the whole state anyway.

### code: deterministic, free

```ts
tally: { code: (s) => Number(s.rounds ?? 0) + 1, reads: ["rounds"], writes: ["rounds"] }
```

Can be `async`, e.g. to call `catalog()`. This is where every judgement about a
number goes.

### model: one OpenRouter call

```ts
look: {
  model: "vendor/model-id" | { from: "stateKey" },
  prompt: "text" | (s) => `text using ${s.goal}`,
  system?: "…",
  sees?: ["frame"],                // image URLs or data: URLs, one string or an array per key
  skills?: ["skill-name"] | { from: "skillKey" },   // bodies inlined into the system prompt; "none" = nothing
  reads?: ["goal"],
  writes?: ["text"] | ["text", "images"],           // positional
  temperature?: 0, maxTokens?: 400,
}
```

- `writes[1]` receives an array of `data:` URLs if the model drew images. Those
  keys count as image keys, so a later `sees:` can look at them but a decide node
  can't read them.
- `sees` requires a model with vision, and a second write key requires a model
  that outputs images. `ensemble check` verifies both against the live catalogue.
- A model node never needs tool-calling support.

### mcp: one tool call, not a loop

```ts
read: {
  mcp: { server: "fs", tool: "read_text_file" | { from: "toolKey" } },
  args?: { path: "x" } | (s) => ({ path: String(s.path) }),
  reads?: ["path"],
  writes?: ["text"] | ["text", "data"],   // positional; data = structuredContent
}
```

The server must be declared in `mcpServers`. Servers start lazily, only when a
branch reaches them, and stop when the run ends. A tool of `"none"` or empty
(from state) fails the node, so wire the `none` answer to another branch.

## 4. Edges

```ts
{ from, to, on?: "grammar", when?: (s) => boolean, maxLoops?: n }
```

- `on` is for **meaning**. It must leave the decide node that asked the
  question.
- `when` is for **arithmetic**. It can leave any node and is plain TypeScript.
  Its reads are found by running it against a recording proxy, so every key it
  touches must have an origin.
- No `on` and no `when` makes the default edge. It also satisfies the
  exhaustiveness check.
- Never put both `on` and `when` on one edge.
- **Order matters.** Edges from a node are tried in declaration order and the
  first match wins. Edge ids are `e0`, `e1`… by position across the whole
  `edges` array.
- `maxLoops: n` lets an edge match at most n times. After that it stops matching
  and the next edge takes over.
- A node with no matching outgoing edge ends the run.

### `on:` grammar

| Form | Means | Only on |
|---|---|---|
| `"team=billing"` | the choice picked `billing` | choice |
| `"urgent"` | noul ≥ 0.5 | noul |
| `"!urgent"` | noul < 0.5 | noul |
| `"urgent>=0.7"` | explicit threshold: `>=` `>` `<=` `<` | noul |

A score has **no** `on:` form. Branch on it with
`when: (s) => Number(s.severity) >= 1.5`.

## 5. State and writes

State is a flat blackboard. Keys come from exactly two places: `inputs` (plus
`goal`) and node `writes`. Validation proves every key read has one of these
origins.

- `writes: []` or omitted means the node only has an effect.
- `writes: ["k"]` means the return value is stored **whole** under `k`.
- `writes: ["a", "b"]` means the return value must be an object with `a` and `b`,
  and they are destructured.
- For model and mcp nodes, writes are **positional** (see above).
- Decide nodes write the plain value (`"billing"`, `0.83`, `1.4`), not the answer
  object. The full distribution goes to run.json.

## 6. Handlers

```ts
work: {
  billing: async ({ goal, state, signal, report }) => {
    report({ cost: 0.021, meta: { provider: "x", model: "y" } }); // optional, keeps run cost honest
    return await myApi(goal, { signal });                           // pass signal to fetch
  },
}
```

`state` is read-only. Return values follow the writes rules above. A throw fails
the run with `RunFailed`, which carries the partial run record.

## 7. Calling a runner

```ts
const { result, state, run } = await myRunner(
  { goal: "…", other_input: "…" },
  {
    budget?: 0.05,        // USD; stops once exceeded
    maxSteps?: 50,        // default 50
    signal?: AbortSignal,
    decider?: Decider,    // stub or replace Jev: (state, questions) => Promise<Decision>
    caller?: Caller,      // stub or replace OpenRouter
    onEvent?: (e) => {},  // "node:start" | "node:end" | "run:end"
  },
);
```

Throws `RunnerError` (`.problems`) if the spec does not validate, and `RunFailed`
(`.run`) if a node throws.

A stub decider returns
`{ model, answers: { key: { type:"choice", choice, confidence, probabilities } | { type:"noul", noul } | { type:"score", score, confidence, probabilities, legend } }, usage: { input_tokens, output_tokens }, cost }`.

## 8. Other exports

| Export | Use |
|---|---|
| `catalog()` | Live OpenRouter models as `{ id, vision, draws, tools, promptUsd, completionUsd, imageUsd, contextLength }`. Cached 10 min, network |
| `shortlist(models, { vision?, draws?, tools?, maxPromptUsdPerM?, maxCompletionUsdPerM?, minContext?, idIncludes?, limit? })` | Filter in code, cheapest first |
| `modelOptions(models)` | A shortlist as `choice` criteria (only for a *fixed* shortlist) |
| `loadSkills({ project?, dirs?, plugins? })` | Agent Skills from disk. Sync, local, safe at module scope |
| `skillOptions(skills, { max?, chars?, none? })` | Skills as `choice` criteria, with a `none` option by default |
| `toolOptions(tools, …)` | MCP tools as `choice` criteria |
| `searchServers(q)`, `missingEnv(entry)`, `toServerSpec(entry)` | The official MCP registry |
| `preflight(spec)` | What `ensemble check` runs |
| `validate(spec)`, `toGraph(spec)`, `execute(spec, inputs, opts)` | The functions behind the runner methods |
| `jev(config)`, `openrouter(config)` | The default decider and caller, configurable |
| `reporter()` | The terminal progress view, an `onEvent` consumer |

CLI: `ensemble validate | graph | run | check | skills [q] [--remote] | servers [q]`.
Run options: `--input k=v`, `--budget`, `--max-steps`, `--json`, `-o`.
