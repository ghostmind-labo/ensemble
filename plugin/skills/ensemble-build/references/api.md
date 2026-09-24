# ensemble API reference (v2, ≥ 0.26)

Everything is imported from `@ghostmind-dev/ensemble`. When in doubt, the
installed package's `dist/*.d.ts` is the source of truth, so read it rather than
guessing.

## Contents
1. runner(spec)
2. The three questions
3. Node kinds: decide · work · code · model · mcp
4. Edges and the `on:` grammar
4b. Parallel lanes: fork and join
5. State, writes and memory
6. Handlers
7. Calling a runner: RunOptions, outcome, errors
8. Other exports
9. calibrate: scoring decisions against labelled cases
10. supervise: a runner that lives for days
11. A person in the loop: `by: "human"`, pause and resume

---

## 1. runner(spec)

```ts
export default runner({
  name: "triage",                 // required; appears in graph.json and run ids
  description?: "one line",
  inputs?: ["goal", "path"],      // keys that arrive from outside; goal is always one
  memory?: ["seen"],              // keys that carry over between ticks under supervise; a node must write them
  work?: { handlerName: (ctx) => value },
  nodes: { nodeName: NodeSpec },  // required, at least one
  edges?: Edge[],
  entry: "nodeName",              // required; where the run starts
  result?: "stateKey",            // returned as `result`; defaults to the last step's value
  openrouter?: { apiKey?, baseUrl?, retries?, timeoutMs?, app?, fetch? }, // ONE key for everything: Jev decides through it too
  jev?: { model?, baseUrl?, retries?, timeoutMs?, apiKey?, fetch? },      // rarely needed; apiKey, baseUrl and fetch default to openrouter's
  skills?: Skill[],               // from loadSkills(); needed by model nodes that inline skills
  mcpServers?: { name: { command, args?, env?, cwd?, timeoutMs? } },
});
```

`runner()` doesn't validate when it is built, so a broken runner can still be
inspected. It returns a callable with `.spec`, `.validate(): string[]`,
`.graph(): GraphDoc` and `.resume(paused, answer, options?)` (§11). Calling it
runs it, and it refuses to start if validation fails.

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
  fallback?: "escalate",              // where to go if the decider cannot answer AT ALL
  by?: "human",                       // a person answers instead of Jev — see §11
  comment?: "reviewer_note",          // human only: the state key for their free-text note
  label?: "Classify the ticket",
}
```

- Writes one state key per question, with the same name as the question.
- All questions in one node go out in one request and are answered
  independently.
- `gate` works only on a `choice` or a `score`. Below `min` confidence the run
  goes to `to` whatever the edges say, and the step records `took: "gate"`.
- `fallback` is for **no answer**: the service is down, rate-limited past its
  retries, timed out, or answered outside the question (`DeciderAnswerError` —
  an answer that does not fit is no answer). Without it the run fails; with it
  the run goes there, and the step records `took: "fallback"` and the `error`.
  Low confidence is the gate's job, not this one. Put a person or a hold behind
  it. A malformed *human* answer is the exception: that is a bug, so it never
  takes the fallback (§11).
- `reads` must never include an image key. Validation refuses it.

### work: a handler the user wrote

```ts
send: { work: "billing", reads?: ["goal"], writes?: ["reply"], label? }
```

`work` names a key of the runner's `work` map. `reads` only declares data flow,
because the handler sees the whole state anyway.

A handler is ordinary async TypeScript. It can import any npm package (a vendor
SDK, an agent framework, a database client) and do anything the use case needs,
including running its own loop. Call `report({ cost })` so the run's budget and
cost include it.

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
{ from, to, on?: "grammar", when?: (s) => boolean, maxLoops?: n, fork?: true }
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

### 4b. Parallel lanes: fork and join

```ts
edges: [
  { from: "sense", to: "look",   fork: true },
  { from: "sense", to: "listen", fork: true },
  { from: "look", to: "assess" }, { from: "listen", to: "assess" },
],
nodes: { assess: { join: "all", decide: {…}, reads: ["scene", "heard"] } }
```

- A **forking edge** fires alongside every other forking edge from its node
  that holds, each starting its own lane. A node's edges are all forks or none.
  A fork may carry `on:` or `when:`, so a decide node can fan out to only the
  lanes it chose.
- A **join** (`join: "all"` on any node kind) runs once, after every lane
  leading to it has arrived or ended. It needs at least two incoming edges and
  cannot be the entry.
- Lanes between a fork and its join must not share a node, and must not write a
  key another lane writes or reads. `validate` refuses both, naming the key.
  Write to separate keys and combine them after the join.
- One controller covers every lane: `budget`, `stepTimeout`, `signal` and a
  failure on any lane stop all of them. The first reason to stop is the one
  recorded.
- No variable-width fan-out. N parallel calls over a list is a `work` handler.

## 5. State, writes and memory

State is a flat blackboard. Keys come from exactly three places: `inputs` (plus
`goal`), `memory` (carried in from the previous tick) and node `writes`.
Validation proves every key read has one of these origins, and that every
memory key has a writer (otherwise it could never change).

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
the run with `RunFailed`, which carries the partial run record. **Report the cost
before anything that can throw**: money spent on a step that then fails still
counts toward `run.cost.total` and the `budget`.

### Every step's record

Each entry in `run.json`'s `steps[]` carries: `n`, `node`, `kind`, `lane`
(`"main"`, the forking edge id that started the lane, or the join node's name),
`started`/`ended` (ISO) and `ms`, `cost`, `asked` (the state the node was given,
per its declared reads), `writes`, `answers` (decide: full distributions),
`gate`, `handler`, `meta`, `error`, `took` (the edge id, `"gate"`, `"fallback"`, or null) and
`forked` (the edge ids a fork step fired). `asked` is what an audit or a replay
needs; a work handler sees the whole state, but only what it declared is kept.

## 7. Calling a runner

```ts
const { result, state, run } = await myRunner(
  { goal: "…", other_input: "…" },
  {
    budget?: 0.05,        // USD; stops once exceeded
    maxSteps?: 50,        // default 50
    stepTimeout?: 30_000, // ms; fail any step that runs longer, and abort its signal. Off by default
    signal?: AbortSignal,
    decider?: Decider,    // stub or replace Jev: (state, questions, { signal }?) => Promise<Decision>
    caller?: Caller,      // stub or replace OpenRouter
    human?: Human,        // answers by: "human" nodes; without it they PAUSE — see §11
    onEvent?: (e) => {},  // "node:start" | "node:end" | "run:end"
  },
);
```

The CLI is optional. A runner is a plain module, so a script can import it and
call it directly:

```ts
// run.mts: node run.mts
import triage from "./runners/triage.mts";
const { result } = await triage({ goal: process.argv[2] }, { budget: 0.05 });
console.log(result);
```

Throws `RunnerError` (`.problems`) if the spec does not validate, and `RunFailed`
(`.run`) if a node throws. `RunFailed.cause` is what actually went wrong, so a
host app can tell its own bug from an upstream one: `DeciderAnswerError` when the
decider answered outside the question it was asked (an option that was never
declared, a missing value, the wrong answer type), `HumanAnswerError` when a
person's answer doesn't fit. A `DeciderAnswerError` takes the decide node's
`fallback` when one is declared; a `HumanAnswerError` never does.

A stub decider returns
`{ model, answers: { key: { type:"choice", choice, confidence, probabilities } | { type:"noul", noul } | { type:"score", score, confidence, probabilities, legend } }, usage: { input_tokens, output_tokens }, cost }`
and must answer exactly the questions it was handed, with declared option names —
anything else is a `DeciderAnswerError`. Its third argument is `DecideOptions`
(`{ signal?: AbortSignal }`): pass the signal to your `fetch` so a cancelled
run — the caller hung up, the budget ran out, the step timed out — stops the
work in flight instead of paying for an answer nobody reads. It is optional, so
a two-argument decider is still a valid `Decider`.

## 8. Other exports

| Export | Use |
|---|---|
| `catalog(config?, signal?)` | Live OpenRouter models as `{ id, name, vision, draws, tools, promptUsd, completionUsd, imageUsd, contextLength }`. Cached 10 min per source (baseUrl + injected `fetch`), network |
| `shortlist(models, { vision?, draws?, tools?, maxPromptUsdPerM?, maxCompletionUsdPerM?, minContext?, idIncludes?, limit? })` | Filter in code, cheapest first |
| `modelOptions(models)` | A shortlist as `choice` criteria (only for a *fixed* shortlist) |
| `loadSkills({ project?, home?, dirs?, plugins? })` | Agent Skills from disk. Sync, local, safe at module scope |
| `skillOptions(skills, { max?, chars?, none? })` | Skills as `choice` criteria, with a `none` option by default |
| `toolOptions(tools, …)` | MCP tools as `choice` criteria |
| `searchServers(q)`, `missingEnv(entry)`, `toServerSpec(entry)` | The official MCP registry |
| `preflight(spec)` | What `ensemble check` runs |
| `validate(spec)`, `toGraph(spec)`, `execute(spec, inputs, opts)` | The functions behind the runner methods |
| `jev(config)`, `openrouter(config)` | The default decider and caller, configurable |
| `reporter()` | The terminal progress view, an `onEvent` consumer |

| `calibrate(runner, cases, opts)` | Score decide nodes against labelled cases. See §9 |
| `supervise(runner, opts)` | Run a runner as a long-lived loop. See §10 |

CLI (through `package.json` scripts, never global):
`ensemble validate | graph | run | resume <file> <paused.json> | calibrate <file> <cases> | check | skills [q] [--remote] | servers [q] | version`.
Run options: `--input k=v`, `--budget`, `--max-steps`, `--json`, `-o`; `resume`
adds `--answer k=value` (repeatable, one per question), `--comment` and `--by`.

## 9. calibrate(runner, cases, options?)

Tests decide nodes in isolation, the way you test one neuron: each case gives
the state the node reads, and nothing else runs (no handler, no model).

```ts
const report = await calibrate(triage, [
  { inputs: { goal: "charged twice" }, expect: { route: "billing" } },          // bare key if one node asks it
  { inputs: { goal: "where is it", plan: "vip" }, expect: { "screen.urgent": true, "route.anger": 1 } },
  { inputs: { goal: "refund please" }, expect: { route: "billing" }, set: "holdout" },
], { budget: 0.05, concurrency: 4, decider? });
```

**Split the cases.** `set: "dev"` (the default) is what you tune questions
against; `set: "holdout"` is scored separately and should be read **once**,
after the wording is frozen. Tuning against the cases that judge you is how a
graph comes to score well on those cases and nowhere else. The report keeps the
sets apart and adds `gap`, the dev-minus-holdout accuracy per question: a drop
of 0.1 or more means the dev set is flattering you.

- `expect` values: a choice takes an option name, a noul `true`/`false`, a score
  its **0-based** level (right when the fractional score rounds to it).
- Every key the tested node `reads` must be in `inputs`, even keys a model node
  would normally write. Put the text that node would have produced there.
- A bad case set throws `CalibrationError` (`.problems`) **before anything is
  asked**, so it costs nothing.
- One decider call per case per node, so several questions in one node cost one call.

The report has, per question: `n`, `accuracy`, `confidence` (mean), `gap`
(expected calibration error; near 0 means confidence can be trusted), `misses`
(`{ case, expected, got, confidence }`), plus `brier` for a noul, `meanError`
for a score, and `gates` for a choice or score:
`[{ min, keeps, accuracy }]`, meaning a gate at `min` keeps this share of cases
and gets this share of those right. Set `gate.min` from that table.

CLI: `npm run calibrate -- runner.mts cases.jsonl [--holdout held.jsonl] [--budget 0.05] [--json]`.
It reads one case per line, or a JSON array; `--holdout` tags a second file as
the frozen set and prints both blocks plus the gap.

## 10. supervise(runner, options)

A runner is one tick. `supervise` runs it again and again: memory between
ticks, budgets, a crash-safe journal, a failure streak limit, signal handling,
and an optional watcher runner that judges drift.

```ts
const outcome = await supervise(worker, {                // worker declares memory: ["notes"]
  next: async ({ tick, memory, last, interrupted, signal }) => ({ goal: await queue.pop() }), // undefined ends it
  memory: { notes: "" },                     // starting values; ignored once a checkpoint exists
  budget: { total: 20, perDay: 5, perRun: 0.05 }, // total stops; perDay RESTS until spend ages out; perRun caps each tick
  maxTicks: 10_000,
  pace: 60_000,                              // ms between tick starts
  maxStreak: 5,                              // stop after this many failed ticks in a row
  window: 20,                                // ticks the vitals look back over
  run: { stepTimeout: 120_000 },             // any RunOptions except budget/signal/onEvent
  watch: { every: 10, runner: watcher, goal: "…", run: { … } },
  journal: ".ensemble/live",                 // journal.jsonl, checkpoint.json, pulse.json, lock; resumes on restart
  resume: true,                              // default
  signals: true,                             // default: SIGTERM/SIGINT stop after the tick in flight; twice aborts
  signal,
  onEvent: (e) => {},                        // start · tick · rest · watch · alert · stop
  onRunEvent: (e, tick) => {},               // each tick's node events, e.g. reporter()
  onAlert: async ({ tick, reason, vitals }) => {}, // your effect: page someone
});
// → { status: "exhausted" | "maxTicks" | "budget" | "failing" | "stopped" | "cancelled", ticks, spent, memory, vitals }
```

**Memory** is the runner's declared `memory` keys. The supervisor injects them
into every tick's inputs (they win over anything `next()` sets) and, after a
completed tick, keeps what the graph wrote to them. A tick that fails leaves
memory untouched. Keep it small: a tally or the last few results, not a
transcript. Jev gets worse on padded state.

**Vitals** are numbers over the last `window` ticks: `tick, ticks, failed,
waiting, failureRate, gateRate, confidence, sameness, streak, cost, spent,
spentToday, msPerTick, costPerCompleted`. `waiting` counts the ticks that paused
for a person and have not been resumed; they are not failures. `sameness` is the share of ticks that took the most
common path. `costPerCompleted` is the window's spend divided by the ticks that
completed — what a finished task really costs, with its failed attempts charged
to it (`null` when nothing completed). Watch that, not the price per call.

**Restarting after a crash.** If the process stopped in the middle of a tick,
the first `next()` after the restart receives
`interrupted: { tick, steps, finished }`: the tick that was running (the same
number `next()` is now being asked for), every step that finished before the
stop as the journal recorded it, and `finished: true` when the run completed but
its checkpoint was lost. A `work` step in that list may already have sent the
email or written the row. **Check before repeating it** — `next()` is the only
place that knows what "already done" means for your system. It is handed over
once, and journalled as an `interrupted` line.

**The watcher** is an ordinary runner that declares
`inputs: ["goal", "vitals", "recent"]` and has a `result` of `"continue"`,
`"alert"` or `"stop"`. `vitals` is the object above, for `when:` edges.
`recent` is plain text, one line per tick, for decide nodes. Check the numbers
first in code, and ask Jev only about meaning. Any other result, or a watcher
that throws, becomes an alert. Watcher cost counts toward the budget. See
`examples/06-watch/watch.mts`.

**The watched work does not author the evidence.** By default `recent` carries
only what the supervisor wrote — `tick 7 · completed · look → assess · 412ms`.
`watch: { evidence: "facts+text" }` appends what each tick returned, which is
richer and is also the tick's own words: use it where the work's output is
trusted, never where a tick handles a support message, a web page, a file or
anything else from outside. A conscience the work can talk to is not a
conscience.

**The journal** is `journal.jsonl`, appended as things happen. It holds `step`
lines as each node finishes (with `lane` and `asked`), a `run` line per tick with
the whole run.json, `watched` lines with the watcher's run, and the supervisor's
own events, including `interrupted` after a restart that found an unfinished
tick. `checkpoint.json` holds tick, spend, memory and the window, and is
replaced atomically after every tick. `pulse.json` is rewritten on every node
event: if its `at` goes stale, the process is stuck or dead. `lock` holds the
pid of the one supervisor allowed on this journal; a second one is refused
while the first is alive, and a stale lock is taken over. Run lines hold the
whole state, so keep images as URLs, not data: URLs.

## 11. A person in the loop

**A person is just another decider.** A `decide` node with `by: "human"` asks a
person the same closed questions — choice, noul, score — so their answer is
typed, their options are wired, and `validate` proves every answer has an edge,
exactly as for Jev. No new node kind, and `graph.json` marks where the people
are (`decide.by: "human"`, `model: "human"`, `cost: "free"`).

```ts
approve: {
  decide: {
    ok:   noul("Should this refund be issued as drafted?"),
    tier: choice("Which approval tier applies?", { standard: …, senior: … }),
  },
  reads: ["goal", "draft", "amount"],   // what the person is SHOWN
  by: "human",
  comment: "reason",                    // optional: where their free-text note lands
},
edges: [
  { from: "approve", to: "pay",    on: "ok" },     // a yes lands as 1, so on: works unchanged
  { from: "approve", to: "refuse" },
],
```

**Answers.** One value per question: an option name for a choice; yes/no for a
noul (`true`/`false` or `"yes"`/`"no"`), which lands on state as **1 or 0**; a
0-based level for a score. A person's answer carries no confidence, so a `gate`
on a human node is refused. An answer that doesn't fit the questions fails the
run with `HumanAnswerError` naming the fix — and never takes the `fallback`,
because it's a bug, not an outage.

**Short runs — wait for them.** Pass a `human` handler and the run waits for it:

```ts
const { result } = await approvals(inputs, {
  human: async ({ node, questions, asked, comment, signal }) => {
    const reply = await slack.askWithButtons(questions, asked, { signal });  // your UI
    return { answers: reply.answers, by: reply.user, comment: reply.note };
  },
});
```

A person's wait is **not** subject to `stepTimeout` — that exists for machines
that hang. Return `undefined` to pause instead.

**Long waits — pause, and resume later.** With no handler (or one that returns
`undefined`) the run stops cleanly: `run.json` has `status: "paused"` and a
`pending` block (`{ node, questions, asked, comment? }`, the questions in
graph.json's readable form), and the outcome carries `paused` — a plain-JSON
snapshot. Store it anywhere. Later, in any process:

```ts
const { result, run } = await approvals.resume(paused, { answers: { ok: "no", tier: "standard" }, comment: "over the limit", by: "dana" });
```

The resumed run is **one continuous record** — same id, the earlier steps, the
person's answer, what followed — and it can pause again at a later human node.
Loop budgets are carried through the pause. `resume` refuses with `ResumeError`
if the graph changed since (its node, edges and loop budgets might mean
something else now) or if it's the wrong runner.

Rules `validate` enforces: no `gate` on a human node; `comment` only on one,
naming an identifier that isn't also a question key; and **no human node inside
a fork lane** — a run can only pause on one lane, so ask after the join.

**Under `supervise`**, a tick that pauses doesn't block the loop and doesn't
count as a failure: it's counted in `vitals.waiting`, saved under
`paused/<tick>.json` in the journal, and handed to `onPaused(paused, tick)` — or
raised as an alert if there's no `onPaused`, so it's never silent.

**From the CLI**, `ensemble run` asks at the terminal when there is one. With no
terminal (a script, CI) it pauses, writes `paused.json` next to `run.json`,
prints the exact resume command, and exits **3**:

```sh
npx ensemble resume runners/refund.mts .ensemble/runs/<id>/paused.json --answer ok=no --answer tier=standard --comment "duplicate" --by dana
```
