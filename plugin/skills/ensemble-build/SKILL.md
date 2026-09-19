---
name: ensemble-build
description: Build a working @ghostmind-dev/ensemble runner for a use case, end to end and without a human in the loop. It covers breaking the use case down, drawing the graph, writing the .mts file, validating it, dry-running every branch for $0, and a preflight check. Use this whenever someone wants to automate a decision, route or triage requests, build a classifier-driven workflow, wire Jev / TypeSafe System One into code, make a perception loop (a model looks, something decides, code acts), or asks to "set up ensemble for X". Also use it for any runner(...) .mts file, any graph of decide / work / code / model / mcp nodes, or an existing runner that needs new branches, questions or nodes, even when the word "ensemble" never appears. Also use it to make a runner run for days (supervise, memory between ticks, budgets, a watcher that monitors drift).
---

# Building an ensemble runner

`@ghostmind-dev/ensemble` gives you **a structure to build on**: a graph of
steps, a shared state that every step reads from and writes to (with the data
flow proven before anything runs), and a record of each run as JSON. Its
specialty is the calibrated decision (Jev) that picks which way to go. The
steps themselves are ordinary TypeScript. A runner is a TypeScript file that
default-exports `runner({...})`: a flat set of nodes, edges between them, and a
map of handlers.

**Nothing is off limits inside a step.** A `work` handler or a `code` node can
import any npm package: a vendor SDK (OpenAI, Anthropic, Google), an agent
framework, a database client, a scraper, a local model. The built-in `model` and
`mcp` nodes are conveniences, not the only way in. If the library doesn't do
something, write it in a handler with whatever library does. The zero-dependency
rule applies to the ensemble package itself, not to the runners people build
with it.

**A runner is just a script, and the library is a dependency, not a tool.**
Install it in the project (`npm i @ghostmind-dev/ensemble`) and never globally.
The way a runner runs is a script that imports it: `await r({ goal })` from a
`run.mts`, a server, a cron job or another runner (`references/api.md` §7).
The CLI exists for the development loop only, reached through `package.json`
scripts so the version is the project's:

```json
"scripts": {
  "validate":  "ensemble validate",
  "graph":     "ensemble graph",
  "check":     "ensemble check",
  "calibrate": "ensemble calibrate",
  "start":     "node run.mts"
}
```

Then `npm run validate -- runners/triage.mts`. Add these scripts if the project
lacks them; do not tell the user to install `ensemble` on their machine.

You are expected to take a use case from a sentence to a runner that validates,
dry-runs down every branch and is ready to go live, without asking a human to
fill in the gaps you can fill yourself.

The design rests on one division of labour. Internalise it before you write
anything, because the rules below fall out of it:

| Kind of judgement | Who does it | Why |
|---|---|---|
| **Meaning**: which category, is this X, how good is it | Jev, via a `decide` node | Calibrated, ~100 ms, ~$0.00002. The options are declared up front, so every branch is known before anything runs |
| **Arithmetic**: counts, thresholds, dates, prices, loop limits | `code` nodes and `when:` edges | Jev is documented as unreliable at counting, arithmetic and date ordering |
| **Perception and generation**: looking at an image, writing text, drawing | a `model` node (OpenRouter), or any SDK in a `work` handler | Jev takes text only and does not generate. The `model` node puts the model and its cost in the graph; a handler gives you any vendor-specific feature |
| **Effects**: send, store, call an API, page a person | a `work` handler | Any library, any API. That seam belongs to the user |
| **One tool call** | an `mcp` node | A single named call, so the graph says what it can reach |
| **Several things at once** | `fork: true` edges meeting at a `join: "all"` node | Lanes run concurrently; `validate` proves they never touch the same key |
| **What survives between ticks** | `memory: [...]` on the runner, written by a node | Declared, so the graph says what the system remembers |

The library doesn't ship an agent loop, a prompt library or parallel groups, but
nothing stops a handler from containing one. An agent that picks its own tools
until it is done can be a single `work` step, with any agent SDK. The graph
shows it as one opaque step, and the decisions around it stay calibrated and
provable. Prefer explicit nodes where the steps are known, because those show up
in `graph.json` and `run.json`. Use a handler where they aren't known.

## Before you start: the environment

1. **Node ≥ 22.18.** Runner files are `.mts` and load by Node's own type
   stripping, so there is no build step. Check with `node -v`.
2. **The v2 library, installed locally.** Versions below 0.26 on npm are an
   older, unrelated product (scenes, a viewer) with a different API. Confirm
   what's installed in this project:
   `node -e "import('@ghostmind-dev/ensemble').then(m=>console.log(typeof m.choice))"`
   must print `function`. If it doesn't, run `npm view @ghostmind-dev/ensemble version`.
   If the registry is below 0.26, install from a local checkout
   (`npm run build` there, then `npm install /path/to/ensemble`) and tell the user.
3. **Keys, only for live runs.** `TYPESAFE_API_KEY` for decide nodes and
   `OPENROUTER_API_KEY` for model nodes. Validating, emitting the graph and
   dry-running need neither, so a missing key never blocks the build.

Put runners where the project keeps them. If there is no convention, use
`runners/<name>.mts`.

## The workflow

Work through these in order. Each step is cheap, and each one catches a class of
mistake the next one can't.

### 1. Break the use case down

Write this table (in your head or in the file header) before any code. It is the
design:

- **Inputs.** What arrives from outside? `goal` always does. It is the free-text
  request, and the CLI's positional argument. When the real input is structured
  (a title and a photo, a ticket record), put a short human-readable summary of
  the job in `goal` and the data in named inputs. Nothing sees `goal` unless a
  node `reads` it. Structured facts the
  caller already knows (`customer_plan` from a CRM, `frame`, `path`) go in
  `inputs: [...]`. Don't make Jev guess what a database can tell you. Callers
  pass them as `await r({ goal, customer_plan })`, the CLI and dry-run as
  `--input customer_plan=vip`.
- **Decisions.** Every judgement about *meaning*. Each becomes one question. If a
  sentence has "and" in it, it is two questions.
- **Numbers.** Every threshold, count, retry limit, date comparison or price
  filter. These become `code` nodes and `when:` edges, never questions.
- **Perception and writing.** Does anything need to *look* at an image or
  *produce* text or images? That is a `model` node, and only then.
- **Exits.** What happens at the end of each branch? Each is a `work` handler, or
  a `model` node whose output is the result. If the output comes from a closed
  set (a rejection reason, a status message), write it from a template in a
  `code` node. That is free, deterministic, and untrusted input can't steer it.
  Use a model only when the wording has to adapt to open-ended content.
- **The unsure path.** What should happen when the classifier is not confident?
  Almost always there should be a gate to a safe exit: a human, a hold, a
  cheaper default.

When the use case is vague, pick sensible defaults and write them into the file
header as assumptions, rather than stopping to ask. Stop and ask only when a choice
changes who gets hurt or what gets spent: a real side effect, money, a message to a
real person.

### 2. Design the questions

This is where quality is won or lost. Load the **`ensemble-questions`** skill now if
it's available. The short version:

- `choice` for one of N (2–255 options), `noul` for yes/no (a probability),
  `score` for a 2–10 level rubric (a *fractional* expected level).
- One property per question. Five narrow questions in one node cost one round
  trip, because they are asked together and answered independently.
- Give every option `what` **and** `not_for`, where `not_for` names what belongs
  in the *neighbouring* option. Boundaries are where classifiers fail.
- `reads` is a hard filter on what Jev sees. Send only the keys the question is
  about.

### 3. Write the runner

Start from `assets/runner.template.mts` and replace every `__PLACEHOLDER__`. Read
`references/api.md` for every field of every node kind, and
`references/patterns.md` for the shape that fits: triage, confidence gate,
refine loop, perception tick, model chosen at run time, skill or tool routing,
staged classification, composed runners, or specs generated from data.

The mistakes that validation *cannot* catch, so avoid them as you write:

- **One write key takes the return value whole.** `writes: ["rounds"]` with
  `return { rounds: n }` stores `rounds.rounds`. Return the bare value. Several
  write keys destructure an object that must have every key.
- **Model and mcp writes are positional.** `[text]` or `[text, images]` for a
  model, `[text]` or `[text, data]` for mcp.
- **Edges are tried in declaration order, and the first match wins.** Put safety
  overrides (a hazard noul, a refusal) *before* the ordinary routing. A bare edge
  (no `on`/`when`) is the catch-all, so put it last.
- **A `gate` fires before any edge.** When a gated question comes back below
  `min`, the run goes to `gate.to` and the node's edges are never looked at, safety
  overrides included. If a node has both a gate and edges that must win (legal
  threat, hazard, refusal), split it: a **screen** node asks the safety questions
  and routes on them, and only its default edge leads to a **route** node that
  holds the gated choice. Otherwise, point the gate at the same safe exit the
  overrides use.
- **In a `when:`, read every key before combining them.** Validation finds a
  predicate's reads by running it once with every key `undefined`, so
  `s.plan === "vip" && Number(s.anger) >= 1.4` short-circuits and `anger` is never
  seen. A typo in it would pass validation. Write
  `(s) => { const plan = s.plan, anger = Number(s.anger); return plan === "vip" && anger >= 1.4; }`.
- **`when:` must be pure** and must use `Number(s.key)`. State values are
  `unknown`, and a throw fails the run.
- **Loops need `maxLoops` on the back-edge**, plus a following edge that takes
  over once the budget is spent.
- **Lanes own their keys.** When edges fork, each lane writes keys no other lane
  writes or reads, and they meet at a `join: "all"` node. Combine after the
  join. `validate` names the offending key, so this is caught, but design for
  it up front.
- **Memory is written by a node.** A key in `memory: [...]` must have a writer,
  usually a `code` node that appends and trims. It is what the next tick starts
  with, so keep it small.

Never hardcode a model id from memory. Ids retire and prices move weekly. Look it
up live
(`curl -s https://openrouter.ai/api/v1/models | jq -r '.data[] | select(.architecture.input_modalities|index("image")) | .id'`)
or resolve it at run time in a `code` node with `shortlist(await catalog(), {...})`
and `model: { from: "key" }`. See the model-selection pattern.

### 4. Validate (free, offline)

```sh
npm run validate -- runners/<name>.mts
```

Repeat until it prints `✓ <name> is sound`. Every message names its own fix, and
`references/errors.md` maps each one to the change to make. Don't silence a check
by adding a bare default edge unless a default really is the intended behaviour.
The exhaustiveness check is the point.

### 5. Inspect the graph (free, offline)

```sh
npm run graph -- runners/<name>.mts | jq '{nodes: [.nodes[] | {id, kind, cost, reads, writes}], edges, data}'
```

Read it as a stranger would. Does every question have the options you intended?
Does `data[]` list every key with a producer, and does every key a `when:`
depends on show that edge in its `readBy`? A key with an empty `readBy` that
you know is used means validation can't see that read. Model nodes are the ones
marked `metered` that spend money through this library (decide nodes are
`cheap`, code and mcp are `free`). Work nodes are always `metered` because the
library can't see inside them, so judge them by what the handler does.

### 6. Dry-run every branch (free, offline)

Validation proves the shape. Running proves the wiring: nested writes, handler
crashes, loops that never exit, results that come back `undefined`. The bundled
script stubs Jev, OpenRouter and MCP and runs the user's handlers for real:

```sh
node <this-skill-dir>/scripts/dryrun.mts runners/<name>.mts "a realistic goal" --explore
```

- `--explore` runs once per declared answer: every choice option, noul low/high,
  score bottom/top, and every gate tripped. It varies **one answer at a time** from the defaults, prints
  the path each took, then lists **the edges no run ever took**. An untaken edge is
  dead wiring, a `when:` nothing exercised, an edge that needs a combination of
  answers, or one that depends on what a handler returned. Cover each with
  `--answer` or an input that makes the handler return that value (a stub that
  returns `null` for a known test id, say), or else fix it.
- `--answer node.key=value[@confidence]` forces one path,
  e.g. `--answer classify.route=b@0.4`. It combines with `--explore`: the forced
  answers become the baseline that every explored case varies from. Use it for
  edges that need two answers at once (e.g. `--answer screen.wismo=0.9
  --answer route.queue=shipping --explore`).
- `--stub-work` also replaces handlers, for when they have real side effects.
  **Use it whenever a handler would send, write, charge or page something.**
- `--input k=v` seeds inputs, e.g. `--input frame=https://…`.

Every case must end `✓`. Read the `wrote` lines of a default run and check that
each value has the shape the next node expects.

### 7. Preflight (free, reads the live catalogue)

```sh
npm run check -- runners/<name>.mts
```

This checks that each named model id exists and can do what its node asks
(`sees:` needs vision, a second write key needs image output) and that the
needed keys are set. It also lists the MCP servers it would start. A model picked
at run time (`{ from }`) can't be checked here. A missing key makes it exit
non-zero, which is expected on a machine without keys, so report it rather than
treating it as a broken runner. **A model that passes prints nothing.** Only problems are listed, so "✓ … can
run here", or only key problems, means every fixed model id was found and is
capable. It does **not** check tool-calling support, and
it shouldn't: an `mcp` node makes the call itself, so any model can sit
downstream of any tool.

### 8. Calibrate the decisions: only when asked

Validation proves the wiring and dry runs prove the plumbing, but neither says
whether the decisions are right. When the user wants to know if it works, or
before trusting a gate, write 20–200 labelled cases and run
`npm run calibrate -- runners/<name>.mts cases.jsonl --budget 0.05`. It costs about
$0.00002 a case. Use the `gates` table to set each `gate.min`. See
`references/api.md` §9 and the `ensemble-runs` skill.

### 9. A live run: only when asked

A decide step costs about $0.00002 and model calls cost more. Don't launch a paid
run unless the user asked for one. When they do, always cap it:

```ts
// run.mts — node run.mts "goal"
import r from "./runners/<name>.mts";
const { result, run } = await r({ goal: process.argv[2] ?? "" }, { budget: 0.05 });
console.log(result);
```

Prefer this over the CLI's `run`: it is how the runner will be called in
production, and it is where `supervise` goes when the runner is one tick of
something longer. From the terminal, `npx ensemble run runners/<name>.mts "goal" --budget 0.05`
writes `.ensemble/runs/<id>/run.json` and `graph.json`. To read one, debug
a path or tune thresholds from real answers, use the **`ensemble-runs`** skill.

### 10. Hand over

Report back briefly with:

- the file path, and one line on what the graph does
- the questions asked and the gates, meaning where the classifier can say "unsure"
- what's still a stub: which `work` handlers need the user's real code, which
  keys and servers are needed
- the validate, dry-run and check results, stated plainly: "validates clean, 9/9
  dry runs, all edges taken, check needs OPENROUTER_API_KEY"

## Going bigger

A runner is plain data, so it can be as large as the use case needs without
becoming a framework:

- **Generate the spec in code.** Build `nodes` and `edges` with
  `Object.fromEntries` over a list of categories, policies or tools. The graph
  stays complete because the list is known when the module loads.
- **Stage large classifications.** 40 categories in 6 families work better as a
  family `choice` followed by a per-family `choice` than as one 40-way question.
  Each boundary stays narrow.
- **Compose runners.** A `work` handler can call another runner
  (`await sub({ goal }, { signal })`) and `report()` its cost. Each runner stays
  small, provable and separately testable.
- **Run for days.** When the runner is one tick of something that keeps going
  (a queue, a camera, a schedule, an agent doing long work), wrap it in
  `supervise()`: memory between ticks, a total and daily budget, a journal it
  resumes from after a crash, a stop after repeated failures, and a watcher
  runner that asks Jev every few ticks whether the work is still on track.
  Pattern 12.
- **Fan out by asking, not by branching.** Five independent yes/no checks are
  five `noul`s in one node, then ordered edges or a `code` node that combines
  them. There are no parallel node groups.

`references/patterns.md` has worked code for each of these.

## Reference files

- `references/api.md`: every field of the runner, node kinds, edges, handlers,
  run options and exports. Read it while writing the file.
- `references/patterns.md`: complete worked graphs for the common shapes. Read it
  when choosing the structure.
- `references/errors.md`: each `validate` message and its fix. Read it when
  validation fails.
- `references/discovery.md`: finding models, skills and MCP servers to wire in.
  Read it when the use case needs a model, a skill or an external tool.
- `scripts/dryrun.mts`: the $0 executor described in step 6.
- `assets/runner.template.mts`: the starting file.
