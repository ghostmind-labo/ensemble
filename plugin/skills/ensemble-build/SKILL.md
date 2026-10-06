---
name: ensemble-build
description: Build a working @ghostmind-dev/ensemble runner for a use case, end to end and without a human in the loop. It covers breaking the use case down, drawing the graph, writing the .mts file, validating it, dry-running every branch for $0, and a preflight check. Use this whenever someone wants to automate a decision, route or triage requests, build a classifier-driven workflow, wire Jev / TypeSafe System One into code, make a perception loop (a model looks, something decides, code acts), or asks to "set up ensemble for X". Also use it for any runner(...) .mts file, any graph of decide / work / code / model / mcp / agent nodes, or an existing runner that needs new branches, questions or nodes, even when the word "ensemble" never appears. Also use it to make a runner run for days (supervise, memory between ticks, budgets, a watcher that monitors drift).
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

**In hosted ensemble too, with one more step.** There the runner is one source
text and there is no `package.json`, so the packages it imports are named next
to it: `check_runner` and `save_runner` take
`{ source, dependencies: { "zod": "^4.1.0", "date-fns": "latest" } }`. The host
installs them from the public npm registry (names and versions or ranges only:
no git, URL or file address), and the check answers with the exact version each
one resolved to. That set is saved with the runner's version: every later run,
and every later version saved with the same `dependencies`, uses the same
packages whatever is published since. Change a declared version to move. Send
`dependencies` again on every save (`get_runner` returns them); a save without
them fails with `Cannot find package`. A package runs under the sandbox's rules
like the runner's own code: no file reads, no child process, no worker, no
native addon, no secrets, and no install script ran, so a package that needs
any of those works locally only.

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
| **A step handed to an agent somebody else runs** | an `agent` node, naming an entry of the runner's `agents` | One message, one reply, over A2A (a hosted agent, by url), ACP (a local agent, launched as a command) or MCP (an agent offered as a tool). The graph names the agent and how it is reached; the run records what was asked, what came back and whether a cost was reported |
| **Several things at once** | `fork: true` edges meeting at a `join: "all"` node | Lanes run concurrently; `validate` proves they never touch the same key |
| **What survives between ticks** | `memory: [...]` on the runner, written by a node | Declared, so the graph says what the system remembers |
| **A person's judgement** | a `decide` node with `by: "human"` | The same closed questions, so it's wired and proven like Jev's. The run waits for a `human` handler, or pauses and resumes later |

There are six node kinds: `decide`, `work`, `code`, `model`, `mcp` and `agent`.
The library ships no agent loop, prompt library or parallel groups of its own. A
loop lives in an agent, and the graph holds what surrounds it.

### When a step is an agent

Pick the smallest thing that does the step:

| The step is | Use | Why |
|---|---|---|
| A closed question: which, whether, how good | a `decide` node | Calibrated, cheap, and every answer has an edge |
| One generative call: look at this, write that | a `model` node | One call, and the graph says which model and what it costs |
| One known tool call | an `mcp` node | The graph says what it reaches |
| An effect or an API call you write | a `work` handler | Any library |
| **An open-ended sub-task whose steps depend on what the last one returned**: research, investigate a codebase, work a ticket | **an agent** | The loop is the agent's. The graph routes to it, bounds it and judges its reply |

When the steps are known, write them as nodes: they show up in `graph.json` and
`run.json`, and each decision is calibrated. Reach for an agent when they are
not known in advance.

There are four ways to put an agent in a graph. Three are **declared** in the
runner's `agents` and used by an `agent` node (pattern 17), so `graph.json` names
the agent and how it is reached. The fourth is **in-process**, in a `work`
handler (pattern 16).

| Way | The agent is | Runs with the local library | Runs in hosted ensemble | Cost in `run.json` |
|---|---|---|---|---|
| `protocol: "a2a"` | Behind a URL, with an A2A card. Nothing to install | Yes | Yes, when it is public and takes no credentials | `"unknown"` always |
| `protocol: "acp"` | A command on this machine (`agento acp`, `opencode acp`) | Yes | Runs locally only: the hosted sandbox starts no process | `"reported"` when the agent sends a USD cost, else `"unknown"` |
| `protocol: "mcp"` | One tool of a declared MCP server (`agento mcp`, a remote server) | Yes | Yes, on a remote (`url`) server that takes no credentials | `"unknown"` always |
| In a `work` handler | A library you import (`@ghostmind-dev/agento`, any agent SDK), with your own tools, hooks and approvals | Yes | Yes for an SDK that only makes network calls and takes no secret, listed in `dependencies`. One that starts a process, reads files or needs a token (`@ghostmind-dev/agento`) runs locally only | What the handler `report()`s |

How to pick:

1. **Where will the runner run?** For hosted ensemble, the agent is `a2a` or
   `mcp` on a remote server, and one that takes no token (the sandbox holds no
   secrets yet, so `${NAME}` does not resolve there). With the local library,
   all four are open.
2. **Where does the agent live?** Behind a URL: `a2a`. A command on this
   machine: `acp`. Offered as an MCP tool: `mcp`. Yours to write, with its API in
   your hands: in-process.
3. **Which agents?** The ones supported out of the box are open source and use
   OpenRouter as their only model provider, so the one `OPENROUTER_API_KEY`
   covers them: `agento` (the Ghostmind agent engine, an independent package)
   and `opencode`. An approved, version-pinned catalog is planned; today the
   agent is installed by hand and declared. Any other agent can be declared too.

### The shape, and the safety rule

Every agent step has the same three parts, whatever the way in:

- **A `decide` node before it** routes to the agent only when one is needed.
  Most requests take the cheap, provable path.
- **The agent step**, bounded from outside: `stepTimeout` on the run, the
  agent's own limit, and `maxLoops` on the retry edge.
- **A `decide` node after it** judges the reply. The agent never grades its own
  work, and a refused or interrupted agent may stop short without saying so.

**Ensemble does not sandbox an agent.** For an `acp` agent, the `permissions`
policy (default `"reject"`) answers what the agent **asks**. An agent that acts
without asking is not stopped by it: `opencode acp`, as it ships, wrote a file
and ran a command without asking. So an `acp` declaration always carries:

1. **the agent's own configuration, set to ask or deny**, passed through `env`;
2. **a `cwd` you are willing to expose**: an empty or throwaway directory when
   the agent only needs to think;
3. and the `decide` node after it.

The declarations proven to hold are in pattern 17 and `references/api.md` §3.
Tell the user which directory the agent was given and what it may do there.

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
3. **One key, only for live runs.** `OPENROUTER_API_KEY` covers everything:
   Jev is served on OpenRouter's System One route, so decide nodes and model
   nodes share one account and one bill. There is no second key to ask for.
   Validating, emitting the graph and dry-running need none, so a missing key
   never blocks the build.

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
- **Delegation.** Is a step an open-ended sub-task (research, reading a
  codebase) rather than one call? That is an agent: pick the way in from "When
  a step is an agent" above, starting with where the runner will run. Give it
  a decide node before it (is it needed?), one after it (did the reply
  answer?), and one bounded retry.
- **Exits.** What happens at the end of each branch? Each is a `work` handler, or
  a `model` node whose output is the result. If the output comes from a closed
  set (a rejection reason, a status message), write it from a template in a
  `code` node. That is free, deterministic, and untrusted input can't steer it.
  Use a model only when the wording has to adapt to open-ended content.
- **The unsure path.** What should happen when the classifier is not confident?
  Almost always there should be a gate to a safe exit: a hold, a cheaper
  default, or a person — and a person is best as a `by: "human"` decide node
  asking the same question, so their answer is routed like Jev's instead of
  ending the run. Add `fallback:` to the same place for when the decider is
  down.

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
- **Model, mcp and agent writes are positional.** `[text]` or `[text, images]`
  for a model, `[text]` or `[text, data]` for mcp, `[text]` or `[text, detail]`
  for an agent.
- **An agent's cost is often unknown, and unknown is not free.** A2A and MCP
  define no cost field, so the step records `meta.cost: "unknown"` and adds 0 to
  the total. The run's `budget` can only count what is reported; bound such a
  step with `stepTimeout`, the agent's own `timeoutMs` and `maxLoops` on the
  retry edge.
- **An `acp` agent's `permissions` answer only what it asks.** `validate`
  passes a declaration with no `env` and no `cwd`, and the agent then runs in
  the current directory with its own defaults. Write both (the safety rule
  above).
- **An agent on an MCP server inherits the server's 30-second `timeoutMs`.**
  Raise it on the `mcpServers` entry (`timeoutMs: 300_000`), or the step fails
  with `tools/call timed out`.
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
library can't see inside them, so judge them by what the handler does. Agent
nodes are `metered` too: somebody's loop runs, on somebody's bill. Read each
one's `agent` block (`jq '.nodes[] | select(.kind=="agent") | .agent'`): it
names the protocol, the address or command, the auth mode and, for ACP, how
permission requests are answered.

### 6. Dry-run every branch (free, offline)

Validation proves the shape. Running proves the wiring: nested writes, handler
crashes, loops that never exit, results that come back `undefined`. The bundled
script stubs Jev, OpenRouter, MCP and every declared agent, and runs the user's
handlers for real:

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
- An `agent` node gets a stub reply that echoes the message it would have sent
  (`[dry agent <name> over <protocol>] …`), so a missing key in the prompt shows
  up. No agent is contacted and no process is launched.
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
needed keys are set. It also lists the MCP servers it would start. For each
declared agent it reads the A2A card (name, version, binding, streaming, the
skills it offers, the auth it declares), checks that an ACP command is on PATH
and says how its permission requests will be answered, and names the secrets
still unset. A model picked
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
  keys and servers are needed, and for each agent: where it is reached, what
  has to be installed, which secret or login it needs, whether its cost is
  reported or "not reported" (never "free"), and for an `acp` agent the
  directory it was given and the configuration it runs under
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
  them. A fixed set of lanes is `fork: true` + `join: "all"` (pattern 13); a
  variable number of them is a handler's job, never the graph's.

`references/patterns.md` has worked code for each of these.

## Reference files

- `references/api.md`: every field of the runner, node kinds, edges, handlers,
  run options and exports. Read it while writing the file.
- `references/patterns.md`: complete worked graphs for the common shapes,
  including an agent inside one `work` node (16) and a declared agent in an
  `agent` node (17). Read it when choosing the structure.
- `references/errors.md`: each `validate`, `check` and run-time message and its
  fix, with a section for agents. Read it when validation or a step fails.
- `references/discovery.md`: finding models, skills, MCP servers and agents to
  wire in. Read it when the use case needs a model, a skill, an external tool
  or an external agent.
- In the library's repository, the long form on agents:
  [the overview](../../../docs/agents.md) (the four ways compared, what works
  today) and [Build your own agent](../../../docs/agents-build.md).
- `scripts/dryrun.mts`: the $0 executor described in step 6.
- `assets/runner.template.mts`: the starting file.
