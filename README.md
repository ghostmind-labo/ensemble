# ensemble

**Typed decisions, wired to your code.**

You have a request, some code that can act on it, and a judgement call in
between. `ensemble` is the judgement call — and only that. It asks
[Jev](https://docs.typesafe.ai) one calibrated question, routes to a function
**you** wrote, and writes down what it decided and why.

It calls generative models only where you put one — to write, to draw, or to
*look*, since Jev takes text and cannot see. Everything else is your code: it
ships no prompts of its own, no tools, and no agent loop.

```ts
import { runner, choice } from "@ghostmind-dev/ensemble";

export default runner({
  name: "triage",
  work: {                                    // ← your code. Anything.
    billing: ({ goal }) => myQueue.push("billing", goal),
    orders:  ({ goal }) => myAgent.run("order-lookup", goal),
    human:   ({ goal }) => pageSomeone(goal),
  },
  nodes: {
    classify: {
      decide: {
        team: choice("Which team should handle this?", {
          billing: { what: "Charges, invoices, refunds", not_for: "Where a parcel is" },
          orders:  { what: "Delivery, cancellation, returns", not_for: "Money questions" },
        }),
      },
      reads: ["goal"],
      gate: { on: "team", min: 0.7, to: "escalate" },   // unsure? a person reads it
    },
    to_billing: { work: "billing", writes: ["reply"] },
    to_orders:  { work: "orders",  writes: ["reply"] },
    escalate:   { work: "human",   writes: ["reply"] },
  },
  edges: [
    { from: "classify", to: "to_billing", on: "team=billing" },
    { from: "classify", to: "to_orders",  on: "team=orders" },
  ],
  entry: "classify",
  result: "reply",
});
```

```ts
const { result, run } = await triage({ goal: "I was charged twice for A-104" });
```

Zero runtime dependencies. Two credentials, and the second only if you call a
model: `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`.

---

## Why this shape

A decision used to cost a full model call — seconds, cents, and a string you had
to coax into a shape. So you minimised decisions, which meant each one carried
too much judgement, which meant it was unreliable, which meant you needed a
judge to check the judge.

Jev answers in three closed shapes — yes/no, one-of-N, a rubric position — in
about 100 ms, at $0.042 per **million** input tokens with output free. A
thousand decisions over a 500-token state costs about two cents.

But the price is not the interesting part. This is:

> **With a generative router you cannot enumerate the branches. With a
> classifier you can.**

Every option is declared before anything runs. That one fact is what makes the
rest possible: a **complete** graph you can emit and draw, a validator that
proves nothing falls through, and a run record that says *photo at p=0.91* rather
than *the model said photo*.

---

## Install

```sh
npm install @ghostmind-dev/ensemble
export TYPESAFE_API_KEY=...       # https://console.typesafe.ai/settings/keys
export OPENROUTER_API_KEY=...     # https://openrouter.ai/keys — only for model nodes
```

Node 22.18 or newer. Runner files are `.mts`, loaded by Node's own type
stripping — no build step to write one.

### Let an agent build it

This repo is also a Claude Code plugin marketplace. The plugin gives an agent
everything it needs to take a use case from one sentence to a runner that
validates and has been dry-run down every branch, with no human filling gaps:

```sh
/plugin marketplace add ghostmind-labo/ensemble
/plugin install ensemble@ghostmind-ensemble
```

| Skill | For |
|---|---|
| `ensemble-build` | Breaks the use case down, writes the graph, runs validate → graph → a $0 dry run of every branch → check |
| `ensemble-questions` | Writing `choice` / `score` / `noul` that Jev answers well, plus gates and thresholds |
| `ensemble-runs` | Reading `run.json` and supervised journals, explaining a path, summarising many runs, calibrating thresholds |

The plugin is not part of the npm package; the library itself still ships no
skills.

---

## The three questions

Jev answers in exactly three shapes, and refuses everything else. That is the
feature.

```ts
import { choice, score, noul } from "@ghostmind-dev/ensemble";
```

| Builder | Answer space | Lands on state as | Also returns |
|---|---|---|---|
| `choice(instructions, options)` | one of N, max 255 | the option name | `probabilities`, `confidence` |
| `score(instructions, levels)` | a 2–10 level rubric | a **fractional** number | `probabilities`, `confidence`, `legend` |
| `noul(instructions, criteria?)` | yes / no | P(yes), 0–1 | — the number *is* the certainty |

A score is the expected value across levels, not the winner: `1.3` means mostly
level 1 with some level 2. That is what makes it useful in a threshold.

**Ask several at once.** Questions in one node are sent in a single request and
answered independently — one answer never becomes hidden context for another. A
speculative extra question is close to free, so ask it and let your code decide
whether it mattered.

**Describe the boundary, not just the option.** The `not_for` field is the one
that earns its keep: it says what belongs in the *neighbouring* option, which is
exactly where classifiers fail.

```ts
choice("What kind of picture?", {
  photo:   { what: "Photoreal image of a scene", not_for: "Explanatory figures" },
  diagram: { what: "Boxes, arrows, labels",      not_for: "Photoreal scenes" },
})
```

---

## The five node kinds

A node is exactly one of these, told apart by which key it has. There is no
`runtime:` string.

```ts
// decide — one Jev call. The only thing this library does itself.
classify: {
  decide: { team: choice(…), urgent: noul(…) },
  reads: ["goal", "customer_plan"],        // the ONLY state sent. Required.
  gate: { on: "team", min: 0.7, to: "escalate" },
}

// work — one of YOUR handlers, by name.
send: { work: "billing", reads: ["goal"], writes: ["reply"] }

// code — deterministic, free, instant. Where arithmetic belongs.
tally: { code: (s) => Number(s.rounds ?? 0) + 1, writes: ["rounds"] }

// model — one generative call, through OpenRouter. Write, draw, or LOOK.
look: {
  model: "google/gemini-2.5-flash",
  prompt: (s) => `What is in front of the robot? Its task: ${s.goal}`,
  sees: ["frame"],                         // ← vision
  skills: { from: "skill" },               // ← instructions, inlined
  writes: ["scene"],
}

// mcp — ONE tool call. Not a loop.
read: {
  mcp: { server: "fs", tool: "read_text_file" },
  args: (s) => ({ path: s.path }),
  writes: ["file_text"],
}
```

`reads` on a decide node is **required and load-bearing**. Jev's accuracy is
documented to fall as irrelevant detail grows, so the filter is the feature, not
documentation — only those keys are sent.

`writes` decides what lands on the blackboard: **one key takes the return value
whole**, several destructure it, none means the node only had an effect. Watch
that first rule — returning `{ rounds: 1 }` for `writes: ["rounds"]` nests it as
`rounds.rounds`. Return the bare value.

### Your handlers

```ts
work: {
  photo: async ({ goal, state, signal, report }) => {
    report({ cost: 0.021, meta: { provider: "gemini", model: "nano-banana-pro" } });
    return await myImageApi(goal, { signal });
  },
}
```

`report()` is how the run record stays honest about money the runner did not
spend. `signal` aborts on budget, cancellation or your own signal — pass it
through to your fetch.

---

## Calling models

A `model` node is one OpenRouter call. Every vendor, one key, one billing line —
and `usage.cost` comes back in USD on every call, which is what makes `--budget`
mean anything.

```ts
// write
draft: { model: "anthropic/claude-sonnet-4.5", prompt: "…", writes: ["text"] }

// look — the only way a graph can perceive, because Jev cannot see
look: { model: "google/gemini-2.5-flash", prompt: "what is here?",
        sees: ["frame"], writes: ["scene"] }

// draw — [text, images] is positional, and only a model node writes this way
make: { model: "google/gemini-2.5-flash-image", prompt: "a hero image",
        writes: ["caption", "picture"] }
```

`sees` takes state keys holding image URLs or `data:` URLs. Generated images come
back as `data:` URLs in the *same shape*, so what one node draws the next can
look at with no conversion in between.

### Jev cannot see, and `validate` enforces it

This is the constraint that shapes every perception graph. Send an image key to a
decide node and it refuses by name:

```
node "assess" sends "frame" to the decider, but that key holds image data and Jev
takes text only. Have a model node look at it and write down what it saw, then
decide on that.
```

Which is also the cheap architecture: look once with a model, then ask four
narrow questions about the *sentence* for a fraction of a cent.

### Choosing a model at run time

There are 445 models on OpenRouter against Choice's limit of 255, and the list
changes weekly. So the decision is split — and the split is the whole thesis in
miniature:

```ts
// Code filters on numbers and booleans. `draws` is a fact; a price cap is arithmetic.
const generators = shortlist(await catalog(), { draws: true, maxPromptUsdPerM: 10 });

// Jev answers the question that will still make sense next year.
fidelity: choice("How much does image quality matter here?", {
  draft: { what: "A rough look, to be iterated on" },
  final: { what: "Going in front of users as-is" },
})
```

Then a `code` node turns the durable answer into today's model id, and the model
node takes it from state:

```ts
draw: { model: { from: "generator" }, prompt: …, writes: ["caption", "picture"] }
```

**Never let a `choice` enumerate a live catalogue.** Its options would stop being
knowable at authoring time, and `graph.json` could no longer say what the
branches are — which is the one property worth protecting. Ask the stable
question; resolve the volatile detail in code.

`catalog()` reads OpenRouter's live list (cached ten minutes) and gives each
model as capability data: `vision`, `draws`, `tools`, `promptUsd`,
`completionUsd`, `imageUsd`, `contextLength`. `shortlist()` filters it,
`modelOptions()` turns the survivors into `choice` criteria.

### Why no vendor SDKs

No `openai`, no `@anthropic-ai/sdk`, no `@google/genai` — on purpose. Three SDKs
means three dependencies, three keys, three billing dashboards and three cost
formats to reconcile; OpenRouter is one of each, and reports what every call
cost in USD. If you need something only a vendor SDK exposes, that is a `work`
handler using your own client — which is exactly what that seam is for, and it
still shows up in the run record if you `report({ cost })`.

---

## Skills and MCP

Both are here, and neither is an agent loop.

### Skills

A skill is a folder with a `SKILL.md` — the [Agent Skills open standard](https://agentskills.io),
opened by Anthropic in December 2025 and since adopted by ~40 agent products.
`loadSkills()` reads them from where they already are: `.claude/skills` and
`.ensemble/skills` in the project, then `~/.claude/skills`, then installed
plugins. Nearest definition wins, so a project can override what it inherited.

```ts
const skills = loadSkills();      // sync, local, free — safe at module scope

nodes: {
  triage: {
    decide: { skill: choice("Which skill fits?", skillOptions(skills)) },
    reads: ["goal"],
  },
  answer: { model: "…", skills: { from: "skill" }, prompt: …, writes: ["reply"] },
}
```

**Choosing a skill is a classification, so a classifier should do it.** TypeSafe
measured the case at 182 skills: an agent working from truncated index entries
loaded the wrong one 16.8% of the time, against 7.3% when a System One model
ranked them first. `skillOptions()` trims each description and adds a `none`
option by default — suggesting nothing beats suggesting wrong.

And unlike a model catalogue, **skills are local files**, so the options can be
enumerated offline. The graph stays complete and `validate` stays free.

`ensemble skills` lists what is visible and checks each against the spec —
names must be lowercase, hyphenated, ≤64 chars and match their folder.

### MCP

One server, one tool, one call. No loop.

```ts
mcpServers: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] } },
nodes: {
  read: { mcp: { server: "fs", tool: "read_text_file" }, args: (s) => ({ path: s.path }), writes: ["text"] },
}
```

Because the server and tool are named in the node, **`graph.json` says exactly
what a workflow can reach before it runs** — the thing a tool-calling agent can
never tell you. Choosing *which* tool is a `choice` over `listTools()`, the same
shape as choosing a skill. Servers start lazily and shut down with the run, so a
branch never taken never spawns a process.

The client is hand-rolled JSON-RPC over stdio — the whole of what stdio MCP is —
so the package still has no dependencies.

### Every model gets every tool

This is the part worth saying plainly. **A model node never needs tool-calling
support.** The `mcp` node makes the call itself and puts the result on the
blackboard, so a model that cannot call tools at all — or a small local one, or
one that is simply very good at one narrow thing — still sits downstream of
every tool and every skill you own. Skills are inlined as text; a model only
needs to read.

Capability constrains just one thing: what a model must do *itself*. Vision is
the real case, and `ensemble check` catches it against the live catalogue:

```
✗ node "look" looks at frame but "openai/gpt-4o-mini-text" does not accept images.
  Pick a model whose card says vision — shortlist(await catalog(), { vision: true }).
```

---

## Discovery

What exists, and what you would have to set up to use it.

```sh
ensemble skills              # skills visible here, spec-checked
ensemble skills --remote pdf # search a public index (unofficial)
ensemble servers github      # the official MCP registry
ensemble check <file>        # can this graph run HERE?
```

`ensemble servers` reads the [official MCP registry](https://registry.modelcontextprotocol.io),
whose entries declare their `environmentVariables` — required or optional,
secret or not. So the answer to *"what do I need for this?"* is a real one:

```
com.scanner/github@1.0.0
  Scan GitHub orgs.
  npx -y @scanner/github@1.0.0  ⚠ needs APIFY_TOKEN
    APIFY_TOKEN (secret) — From the Apify console.
```

`toServerSpec()` turns an entry straight into an `mcpServers` value. A
remote-only server says so rather than claiming to be ready — this client speaks
stdio.

`ensemble check` is the other half of `validate`: that one proves what is true
offline and forever, this one asks whether the models you named can do what the
nodes ask of them, and whether your keys are set.

---

## Parallel lanes

Edges marked `fork: true` fire together, each on its own lane; a node marked
`join: "all"` runs once after every lane has arrived. That is the whole of
parallelism here, and it stays provable: `validate` refuses lanes that share a
node or touch the same state key, so the merge can never depend on timing.

```ts
edges: [
  { from: "sense", to: "look",   fork: true },   // a vision model
  { from: "sense", to: "listen", fork: true },   // your handler
  { from: "sense", to: "recall", fork: true },   // code
  { from: "look", to: "assess" }, { from: "listen", to: "assess" }, { from: "recall", to: "assess" },
],
nodes: { assess: { join: "all", decide: {…}, reads: ["scene", "heard"] } }
```

Forks may carry `on:` or `when:`, so a decision can fan out to only the lanes it
chose. One shared controller covers every lane: a failing lane cancels its
siblings, and budget, timeout and cancellation apply to all of them. Each step
in `run.json` says which lane it ran on.

## Memory

A runner is one tick. Keys declared in `memory` arrive like inputs and are
carried to the next tick by `supervise`, as the last completed tick left them.
They are declared, so `graph.json` says what the system remembers and
`validate` proves something writes it. Keep it small: a tally, the last few
results, never a transcript. Jev gets worse on padded state.

## Branching

Two forms, and the split is the whole design:

```ts
edges: [
  // MEANING — a declared option. Static, enumerable, drawable, provable.
  { from: "classify", to: "gen_photo", on: "picture_kind=photo" },
  { from: "classify", to: "lettering", on: "needs_text>=0.7" },

  // ARITHMETIC — ordinary TypeScript.
  { from: "classify", to: "hand_off", when: (s) => Number(s.complexity) >= 1.8 },

  // No condition: the default branch. Also satisfies the exhaustiveness check.
  { from: "review", to: "ship" },
]
```

**Code decides on numbers, Jev decides on meaning.** This is not style — Jev is
documented as unreliable at counting and at comparing dates, so every judgement
about a quantity belongs in `when` or in a `code` node.

The `on:` grammar, in full:

| Form | Means |
|---|---|
| `"kind=photo"` | a choice answered with that option |
| `"needs_text"` | a noul at or above 0.5 |
| `"!needs_text"` | a noul below 0.5 |
| `"needs_text>=0.7"` | an explicit threshold — `>=`, `>`, `<=`, `<` |

A score has no `on:` form on purpose: a score is a number. Edges are tried in
declaration order, first match wins, and `maxLoops` on an edge is a loop budget
that, once spent, lets the next edge take over.

### The confidence gate

```ts
gate: { on: "team", min: 0.7, to: "escalate" }
```

Below `min`, the run diverts to `to` whatever the edges say, and the step
records `took: "gate"`. An unsure classifier should not act — and only `choice`
and `score` have a confidence to gate on, because a noul's value already is one.

---

## What it emits

**This library draws nothing.** It emits two JSON documents and leaves rendering
to whatever you already use. A renderer is opinionated and goes stale; a schema
is neither.

Both are flat `nodes[]` / `edges[]` with stable ids — what dagre, elk, graphviz,
cytoscape and d3 all already eat. No coordinates, no colours, no theme.

### `graph.json` — what *could* happen

```sh
ensemble graph triage.mts | jq .edges
```

```jsonc
{
  "$schema": "https://ghostmind.dev/ensemble/graph-v1.json",
  "version": 1,
  "runner": { "name": "triage", "hash": "sha256:9c92f2f1a59ff24d", "entry": "classify", "inputs": ["goal"] },
  "nodes": [
    { "id": "classify", "kind": "decide", "cost": "cheap",
      "reads": ["goal"], "writes": ["team"],
      "decide": { "model": "jev-latest", "questions": [ /* every option, in full */ ],
                  "gate": { "on": "team", "min": 0.7, "to": "escalate" } } },
    { "id": "to_billing", "kind": "work", "cost": "metered",
      "reads": ["goal"], "writes": ["reply"], "work": { "handler": "billing" } }
  ],
  "edges": [
    { "id": "e0", "from": "classify", "to": "to_billing", "on": { "question": "team", "option": "billing" } },
    { "id": "e2", "from": "review", "to": "redo",
      "when": { "source": "(s) => Number(s[\"quality\"]) < 1.5", "reads": ["quality"] } }
  ],
  "data": [
    { "key": "goal", "producedBy": ["$input"],  "readBy": ["classify", "to_billing"] },
    { "key": "team", "producedBy": ["classify"], "readBy": ["e0", "e1"] }
  ]
}
```

Three things make it reproducible rather than merely readable:

- **`edges[].on`** names the question *and* the option, so a branch is labelled
  without guessing.
- **`edges[].when`** carries the predicate's own source text and the keys it
  touches. A code branch cannot be enumerated, so instead of pretending, the
  document tells the truth. Nothing is executed to produce it.
- **`nodes[].cost`** is a class, not a number: `cheap` is a Jev call, `metered`
  is your handler, `free` is plain code. Colour by it and the money is visible.

### `run.json` — what *did* happen

```jsonc
{
  "$schema": "https://ghostmind.dev/ensemble/run-v1.json",
  "run": { "id": "20260918T003102-triage", "graph": "sha256:9c92f2f1a59ff24d",
           "status": "completed", "cost": { "total": 0.0213, "currency": "USD" } },
  "steps": [
    { "n": 1, "node": "classify", "kind": "decide", "ms": 96, "cost": 0.000021,
      "answers": {
        "team": { "type": "choice", "value": "billing", "confidence": 0.91,
                  "probabilities": { "billing": 0.91, "orders": 0.06, "account": 0.03 } }
      },
      "gate": { "on": "team", "passed": true, "min": 0.7, "measured": 0.91 },
      "took": "e0" },
    { "n": 2, "node": "to_billing", "kind": "work", "ms": 17400, "cost": 0.0213,
      "handler": "billing", "meta": { "provider": "gemini", "model": "nano-banana-pro" },
      "writes": { "reply": "…" }, "took": null }
  ],
  "state": { "goal": "…", "team": "billing", "reply": "…" }
}
```

**The join is one field.** `steps[].took` is an edge id from `graph.json`, and
`run.graph` is that document's hash. Highlighting the path taken is a
set-membership test; finding the hot path across fifty runs is a `groupBy`.

Every decision keeps its whole distribution, not just the winner — which is what
makes a run auditable, and what lets an optimiser tell *it improved* apart from
*the judge felt different today*.

---

## Live output

While a run is in flight, `ensemble run` shows which node is working and what it
said:

```
make-a-picture — a hero image for the launch page
  ? classify            96ms   $0.000021  picture_kind=photo 0.91  needs_text=0.08  complexity=1.20 0.64
  ⚙ gen_photo        17400ms     $0.0213  wrote image
  ✓ completed · $0.0213 · 2 steps
  .ensemble/runs/20260918T003102-make-a-picture/run.json
```

A spinner marks the node currently working and is rewritten in place when it
finishes. When stderr is not a TTY the spinner disappears on its own and each
node prints one line, so piping and CI logs stay clean.

There is deliberately **no full-screen TUI**. It would take over the terminal,
break `| jq`, and become another renderer to maintain. The seam is the event
stream instead — three events, and anyone can build a TUI, a web view or a
progress bar on top without this library owning it:

```ts
await pipeline({ goal }, {
  onEvent: (e) => {
    if (e.type === "node:start") console.log(`${e.node} — ${e.waiting}`);
    if (e.type === "node:end")   console.log(`${e.step.node} took ${e.step.ms}ms`);
    if (e.type === "run:end")    console.log(e.run.run.status);
  },
});
```

The bundled terminal reporter is just one consumer: `import { reporter } from
"@ghostmind-dev/ensemble"`.

---

## The CLI

The library is the product — a runner belongs inside your server, called as an
ordinary function. The CLI is for the development loop, and it is not meant to be
installed globally: add it to `package.json` scripts and pin it with the project.

```json
"scripts": {
  "validate":  "ensemble validate",
  "graph":     "ensemble graph",
  "check":     "ensemble check",
  "calibrate": "ensemble calibrate",
  "start":     "node run.mts"
}
```

```ts
// run.mts — the way a runner actually runs: imported, not shelled out to
import triage from "./runners/triage.mts";
const { result } = await triage({ goal: process.argv[2] ?? "" }, { budget: 0.05 });
console.log(result);
```

```sh
npm run validate  -- <file>              # prove the graph        — free, offline
npm run graph     -- <file> | jq         # emit graph.json        — free, offline
npm run calibrate -- <file> cases.jsonl  # score its decisions    — ~$0.00002 a case
npx ensemble run <file> "goal"           # one paid run from the terminal, when you must
```

Data goes to stdout so it can be piped; commentary goes to stderr.
`ensemble graph x.mts | jq` is the point.

| Option | |
|---|---|
| `-o, --out <path>` | write here instead of stdout / the default run directory |
| `--json` | `run`: print `run.json` to stdout instead of writing a file |
| `--input k=v` | seed a state key (repeatable) |
| `--budget <usd>` | `run`, `calibrate`: stop once it costs more than this |
| `--max-steps <n>` | cap node executions (default 50) |

`run` writes `run.json` and `graph.json` into `.ensemble/runs/<id>/`.

---

## What `validate` proves

Free, offline, and the reason the closed answer space was worth having. Every
check exists because the alternative is a workflow that runs and looks fine.

- **Every declared option has an edge** — or an explicit default. An unhandled
  branch is named: `node "classify" asks "team" but nothing handles "account"`.
- **Every edge names a real option** of a question the node it leaves actually
  asks.
- **The branch form fits the question type** — no thresholds on a choice, no
  `=` on a noul, and a score is sent to `when:` with the replacement written out
  for you.
- **Every key read has an origin** — a node's `reads`, and the keys a `when()`
  touches, discovered by running it against a recording proxy. The error names
  the one-line fix.
- **Gates are gateable** — a choice or a score, a real target, a threshold in
  range.
- **Handlers exist**, nodes are exactly one kind, entry is real, nothing is
  unreachable.

`execute` refuses to start a runner that does not validate. `graph()` and
`validate()` keep working on one that doesn't — they are exactly what you reach
for when something is wrong.

---

## Swapping the decider

Everything depends on the `Decider` function type, never on Jev. That is the
mitigation for betting a design on one young vendor, and it is what makes the
test suite free:

```ts
import { execute, type Decider } from "@ghostmind-dev/ensemble";

const cached: Decider = async (state, questions) => { /* … */ };
await pipeline({ goal }, { decider: cached });
```

Point it at a different endpoint or pin a model version without touching a node:

```ts
runner({ …, jev: { model: "jev-1.13.0", baseUrl: "https://proxy.internal", retries: 3 } })
```

---

## Jagged edges

TypeSafe [publishes Jev's known failure modes](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
They are design constraints, not warnings, and several are already enforced here:

| Weakness | What this library does about it |
|---|---|
| Counting and arithmetic are unreliable | `when:` and `code` nodes exist. Never gate on a Jev-computed number |
| Dates are read as text, not ordered quantities | Extract with a model, compare in code |
| Accuracy falls as irrelevant state grows | `reads` is required on every decide node, and is a hard filter |
| Multi-hop questions lose accuracy | One question, one property. Ask several instead — they are parallel |
| State is not treated as hostile | Guard before routing on unvetted user text |
| No structural invariants (`P(x)` and `1 − P(¬x)` need not agree) | Calibrate each question on your own data; don't derive one threshold from another |
| Literal reading | Use `not_for` on every option. State boundaries, don't imply them |
| It does not generate | Generation is your handler's job, never a node's |

Scores from rubrics of different lengths are not comparable — normalise by
`levels − 1` before combining them.

---

## Does it work? Calibrate it

`validate` proves the wiring and a dry run proves the plumbing. Neither says
whether a decision is *right*. `calibrate` does: give it labelled cases and it
asks each decide node in isolation (no handlers, no models), then reports
accuracy, how honest the confidence is, and what every gate would cost you.

```jsonl
{"inputs":{"goal":"I was charged twice"},"expect":{"team":"billing"}}
{"inputs":{"goal":"where is my parcel"},"expect":{"team":"orders"}}
```

```sh
ensemble calibrate triage.mts cases.jsonl --budget 0.05
#   classify.team  choice · n=120 · right 91.7% · confidence 0.88 · gap 0.031
#     gate min 0.7 → keeps 93.3%, 96.4% of those right
#     gate min 0.8 → keeps 85.0%, 98.0% of those right
```

`gap` is the distance between how sure Jev was and how often it was right. Near 0
means a gate on that question can be trusted. A malformed case set is refused
before anything is spent.

---

## Running for days

A runner is one tick. `supervise()` keeps one alive: memory between ticks, a
total and a daily budget (a spent day *rests* until spend ages out, it doesn't
die), a stop after repeated failures, a per-step timeout, and a journal that a
restart resumes from.

```ts
import { supervise } from "@ghostmind-dev/ensemble";

await supervise(worker, {                      // worker declares memory: ["seen"]
  next: async () => ({ goal: await inbox.next() }),
  memory: { seen: 0 },                         // starting values, until the first checkpoint
  budget: { total: 20, perDay: 5, perRun: 0.05 },
  run: { stepTimeout: 120_000 },
  watch: { every: 10, runner: watcher },
  journal: ".ensemble/live",
  onAlert: ({ reason }) => pager.send(reason),
});
```

The **watcher** is where the decider fits best. It is an ordinary runner that
gets the loop's vitals as numbers (failure rate, gate rate, sameness, spend) for
its `when:` edges, and the recent ticks as text for Jev. It answers "continue",
"alert" or "stop". At about $0.00002 a question, a system can check whether it
is still on track every few ticks, forever. The work being watched can be
anything, including a free-running agent inside one `work` handler.
[`06-watch`](examples/06-watch/watch.mts) is a complete one.

---

## What this deliberately does not do

No prompts of its own, no built-in agent loop, no vendor SDKs *in the package*.
Your handlers can use any of them. Skills and MCP are here, but as *choices and
single calls*, never a model deciding its own next tool. No server, no browser
viewer, no mermaid, no markdown reports. No variable-width fan-out (a handler's
job), no replay.

Those are not oversights — they were removed. Keeping them would have made this
a framework you live inside rather than a function you call, and the whole point
is that **your code owns the control flow**.

---

## Examples

```sh
ensemble validate examples/01-triage/triage.mts       # free
ensemble graph    examples/02-picture/picture.mts | jq
ensemble run      examples/03-refine/refine.mts "explain calibrated confidence"
ensemble run      examples/04-robot/brain.mts --input frame=https://… "keep the corridor clear"
```

| | |
|---|---|
| [`01-triage`](examples/01-triage/triage.mts) | The smallest thing that is still the whole idea: one choice, three branches, a gate |
| [`02-picture`](examples/02-picture/picture.mts) | Real image generation: ask the durable question, resolve today's model in code, draw |
| [`03-refine`](examples/03-refine/refine.mts) | A loop that knows when to stop — a score gate, a loop budget, counting in code |
| [`04-robot`](examples/04-robot/brain.mts) | A little brain: a vision model looks, Jev decides, your handler acts — one tick of a perception loop |
| [`05-assistant`](examples/05-assistant/assistant.mts) | Skills and MCP, chosen rather than looped over: pick a skill, read a file, answer |
| [`06-watch`](examples/06-watch/watch.mts) | A conscience for a loop that runs for days: numbers checked in code, drift judged by Jev, supervised end to end |
| [`07-senses`](examples/07-senses/senses.mts) | Look, listen and count at once: three forked lanes, one join, and a memory key that survives the tick |

---

## API

```ts
import {
  runner,                          // define one
  choice, score, noul,             // ask
  validate, toGraph, execute,      // prove, emit, run
  jev, openrouter, reporter,       // the decider, the caller, the terminal view
  catalog, shortlist, modelOptions,// the live model list, filtered in code
  loadSkills, skillOptions,        // agent skills, from disk
  searchServers, missingEnv, preflight, // the MCP registry, and what it needs
} from "@ghostmind-dev/ensemble";

const pipeline = runner({ … });
pipeline.validate();               // string[] — empty means sound
pipeline.graph();                  // GraphDoc
await pipeline(inputs, options);   // { result, state, run }
```

Throws `RunnerError` (with `.problems`) if the spec does not validate, and
`RunFailed` (with `.run`, the partial record) if a node does.

Both vendors are seams, so a test never touches the network:

```ts
await pipeline(inputs, { decider: myStub, caller: myStub });
```

MIT.
