---
name: ensemble
description: "Build and operate multi-model agent scenes with @ghostmind-dev/ensemble — a workflow graph in one TypeScript file, where each node is a different model, a tool-using agent, or a pause for approval. Use when several models should work one goal together (jury, score-gated loop, research→critique→write pipeline), or to author, validate, run, watch, resume, or answer a scene. Trigger on: 'ensemble', 'scene', 'multi-model', 'jury', 'agent graph/workflow/team', or a .mts scene file."
---

# ensemble

`@ghostmind-dev/ensemble` runs **scenes**: multi-model agent graphs described in one
TypeScript file. Each node is either a direct OpenRouter model call (any vendor) or a
tool-using agent that loops over MCP and built-in tools. Nodes share a state
blackboard, wired by conditional edges that are plain TypeScript predicates.

You — the model reading this — are the intended operator AND the intended author.
The loop you own: **author a scene → `validate` (free) → `run` cheap → read the run
artifacts → revise the scene when the results say so.** Do not accept a weak result
when a one-line change to a prompt, model, or threshold would fix it.

## 0 · Route first: autoresearch, a scene, or neither?

**Ask before anything else: is the user trying to make ONE measurable thing
better?** If there is (or could be) a command that scores it, this is
**autoresearch**, not a scene — and two dedicated skills own it:

| skill | for |
|---|---|
| **`autoresearch`** | the *concept* — what the loop is, why its constraints exist, and whether this goal qualifies |
| **`autoresearch-build`** | the *implementation* — naming the three things, writing the evaluator, launching, reading `results.tsv` |

Load those instead of continuing here. Do not hand-author an ordinary
propose/evaluate scene: the sealed mode exists precisely so the scaffolding is not
a variable between experiments, and a hand-rolled one throws that away. The single
exception is §3's **escape hatch** — a jury of proposers, a human gate each round,
or two metrics — which the sealed mode cannot express.

If it is not that, ask whether it is a scene at all:

## 0.1 · Should this be a scene at all?

Every scene costs real money on every run, so build one only when the shape of the
work earns it. **One model answering one question is not a scene** — just answer it,
or make one API call. A scene earns its cost when the task needs at least one of:

- **independence** — several models answering blind, then compared (jury)
- **a measurable gate** — work loops until a scored bar passes, not until it "feels done"
- **parallel fan-out with a merge** — teams working concurrently, results synthesised
- **tool work + synthesis** — an agent node gathers evidence, other nodes reason on it
- **a durable pause** — a human or agent must approve mid-flow (`ask`)

Right-size it: every node must **produce, judge, gate, or merge** — a node doing none
of those is decoration; delete it. Prefer the smallest scene that exercises the
mechanism (2–4 nodes), prove it on a cheap run, and only then widen. A 15-node
council for a task a 2-node score-gate handles is inflation, not thoroughness.

## 0.5 · Check the setup (once per session)

```bash
which ensemble || npm ls @ghostmind-dev/ensemble   # global bin or local dep
ensemble validate <scene>                          # free, and now checks the key too
```

- Not installed → `npm i -g @ghostmind-dev/ensemble`.
- **`OPENROUTER_API_KEY` is the only credential, and BOTH runtimes need it** — there
  is no alternative provider path. `validate` (and `validate_scene`) report it as a
  certain failure before anything spends, so you never learn this at run time.
- It is read from the environment or, failing that, from `.ensemble/.env`,
  `./.env`, `~/.config/ensemble/.env`, `~/.env` — a real env var always wins.
  **Prefer a file when driving through MCP:** the server inherits the host's
  environment at spawn, so a key exported later in some other terminal never
  reaches it, while a file is re-read on every call.
- Node ≥ 22.18. No other install, no subprocess, no external agent.

### Where things go — everything under `.ensemble/`

**Write new scenes to `.ensemble/scenes/<name>.mts` at the project root.** Do not
scatter `.mts` files elsewhere; one folder is what makes a project's workflows
discoverable and lets `ensemble serve` find them with no arguments.

```
my-project/
└── .ensemble/
    ├── scenes/review.mts       ← the workflows you author
    ├── ensemble.json           ← MCP servers / sources (optional)
    ├── .env                    ← secrets for that config (optional, gitignore it)
    └── runs/                   ← run artifacts, created for you
```

**Run `ensemble init` in a new project** (instead of `mkdir`): it creates
`.ensemble/scenes/` *and* the editor shim — a `tsconfig.json`, a `deno.json`, and a
symlink to the package — so a language server resolves the import and your `state`
schemas type the `when` predicates instead of leaving `s` as `any`. It is
idempotent and never overwrites without `--force`; `--starter` also writes an
example scene. None of it affects how a run behaves.

**Name scenes `.mts`** — then no
package.json is needed and the `@ghostmind-dev/ensemble` import resolves against the
global install; use `.ts` only where the project already has `"type": "module"`.
`ensemble run <path>` accepts any path, and a legacy `./ensemble.json` or `./scenes/`
still works — but new work goes under `.ensemble/`.

## 1 · The scene format

```ts
// review.mts — one file is the whole workflow
import { scene } from "@ghostmind-dev/ensemble";

export default scene({
  name: "research-and-critique",            // kebab/snake; becomes the run id
  defaults: { model: "openrouter/anthropic/claude-sonnet-5" },

  nodes: {
    researcher: {
      model: "openrouter/google/gemini-2.5-flash",   // ANY vendor, per node
      prompt: "Research the goal. Be concrete.",
      outputs: ["findings"],                // state keys harvested from its reply
    },
    critic: {
      model: "openrouter/anthropic/claude-haiku-4.5",
      inputs: ["findings"],                 // sees the goal + ONLY these keys
      outputs: ["verdict", "notes"],
    },
    inspector: {
      runtime: "agent",                     // tool-calling loop: built-ins + MCP
      mcp: ["github"],                      // MCP servers this node may use
      skills: ["graphify"],                 // skill bodies inlined into its prompt
      maxTurns: 8,                          // tool-loop budget (default 12)
      inputs: ["findings"],
      outputs: ["report"],
    },
    writer: { inputs: ["findings", "notes", "report"], outputs: ["result"] },
  },

  groups: { review: ["critic", "inspector"] },  // run concurrently, fan-in barrier

  edges: [
    { from: "researcher", to: "review" },
    { from: "review", to: "writer",     when: (s) => s["verdict"] === "accept" },
    { from: "review", to: "researcher", when: (s) => s["verdict"] === "reject", maxLoops: 2 },
  ],

  entry: "researcher",
  exit: "writer",     // its first output is printed as the run's Result
});
```

**Everything is an object.** The system is composed of six kinds, and adding a
capability means adding an object — never editing the engine:

| Object | What it is | Mount point |
|---|---|---|
| node | a unit of work — the neuron | `nodes: {...}` in the scene |
| edge | a connector — the synapse (`from`/`to`/`when`/`maxLoops`) | `edges: [...]` |
| edge kind | how the NEXT edge is chosen | `registerEdgeKind({...})` |
| schema | the shape a state key must respect | `state: {...}` (zod) |
| runtime | how a node executes (fields + validation + park/call) | `registerRuntime({...})` |
| tool | a capability offered to agent nodes | `registerTool({...})` |
| agent | a coding-agent CLI, rented per node | `registerAgentBackend({...})` |
| capability | a scene-level block (`research: {...}`) | `registerCapability({...})` |
| store | where run artifacts go (files by default) | `runScene(..., { store })` |

Built-in runtimes: `model` (stochastic neuron) / `agent` (tool-using) / `ask`
(external input) / **`fn` (deterministic)** — a plain function over state:

```ts
counter: { runtime: "fn", fn: (s) => ({ round: Number(s.round) + 1 }),
           inputs: ["round"], outputs: ["round"] },
```

Free, instant, and held to the SAME `state` schema contract as model output —
use it for arithmetic, formatting, tallies, and anything a model should never be
paid to do. A throwing fn fails its node with the real message.

Edge *selection* is an object too: `sequential` (declaration order, first match
wins) is the default and the only built-in. `edgeKind: "..."` on the scene picks
another; mount one with `registerEdgeKind({ name, summary, fields, select })`.
The engine holds no edge branches — `maxLoops` counting, `when` evaluation and
first-match all live in the kind.

**Terminology — the condition on an edge is called `when`.** It is a
function-valued *property* of the edge object, not a separately mounted object:
in this paradigm, objects carry identity and composition, while functions are
the behaviour-carrying leaves on them (`edge.when`, `node.fn`, `runtime.call`,
`tool.run`, `store.writeState` — all the same pattern). A custom store should WRAP
`fileRunStore` rather than replace it, or its runs stop being resumable (resume
reads the journal from the run directory).

Every `NodeSpec` field: `model`, `runtime` ("model" | "agent" | "ask" | "fn"),
`prompt` (system-style instruction), `question` (ask only), `fn` (fn only),
`inputs`, `outputs`, `skills`, `mcp`, `tools`, `maxTurns` (agent only, default
12), `temperature`, `description`. Scene-level: `name`, `description`, `state`
(zod shapes — see below), `defaults`, `nodes`, `groups`, `edges`, `entry`, `exit`.

**`defaults` is how you say something once for the whole scene.** It carries
`model`, `runtime`, `temperature`, and three that reach every **agent** node:

```ts
defaults: {
  model: "openrouter/anthropic/claude-sonnet-5",
  skills: ["house-style"],      // GRANT: every agent node gets it, no re-listing
  mcp: ["postgres"],            // GRANT: same
  tools: { fetch_url: false },  // DISARM: scene-wide opt-out of a built-in
},
```

The two directions are deliberate and opposite. `skills` and `mcp` are **grants
and they union** — the scene list is a floor, a node adding its own widens it,
and a node can never silently lose a scene-wide grant. `tools` is a **disarm**,
because built-ins are all on already — so there the node-level map wins, and
`tools: { fetch_url: true }` on one node opts back in. An unknown skill or
server in `defaults` reports itself as `defaults (used by node "x")`, so you
look in the right place.

### Typed state — pin the SHAPE of the blackboard (`state`)

By default a node's `outputs` are checked for **presence only**: a node owing
`score` can emit `score: "banana"` and it lands in state, so `s.score < 8` silently
compares against a string. Declare `state` and the shape becomes enforced:

```ts
import { scene, z } from "@ghostmind-dev/ensemble";   // z is re-exported — do NOT import "zod"

export default scene({
  name: "review",
  state: {                                  // the contract for the whole blackboard
    findings: z.array(z.object({ file: z.string(), severity: z.enum(["low", "high"]) })),
    score:    z.number().min(0).max(10),
    verdict:  z.enum(["accept", "reject"]).describe("ship it or send it back"),
  },
  nodes: {
    scanner: { outputs: ["findings"] },
    judge:   { inputs: ["findings"], outputs: ["score", "verdict"] },
  },
  edges: [{ from: "judge", to: "writer", when: (s) => s.score >= 8 }],  // s is TYPED
  entry: "scanner", exit: "writer",
});
```

Three things you get, and they are why this is worth declaring:

1. **The shape is shown to the model.** The auto-appended output contract renders
   `"score": number (0-10)` and `"verdict": "accept" | "reject"` instead of `...`.
   Compliance improves markedly just from being shown the shape.
2. **Wrong shapes are rejected and self-correct.** A mismatch becomes the retry
   reason, naming the exact path (`findings.0.severity: Invalid enum value…`), so the
   model fixes it on the existing free retry instead of poisoning state. The value
   stored is zod's *parsed* output, so coercions and `.default()` apply.
3. **`when` predicates are typed.** `s.score >= 8` type-checks — no `Number(s["score"])`
   guard, and a typo'd key is a compile error. This is the one place types beat prose.

Rules: **use `z` from `@ghostmind-dev/ensemble`**, never `import { z } from "zod"` — a
scene folder has no `node_modules`, so only this package resolves. `state` is
**additive and optional**: keys with no schema behave exactly as before, so add it to
an existing scene freely. Add `.describe("…")` for intent the type cannot carry — it
is appended to the shape the model sees. Typed keys read as always-present for
ergonomics, so gate on keys the upstream node actually wrote.

**Schema the keys that gates and downstream nodes depend on** (scores, verdicts,
enums, structured records). Prose keys — `findings` as a long write-up, `answer`,
`notes` — are fine as plain strings; `z.string()` adds nothing there.

**Transition contracts.** To require that moving past a node needs specific fields
that also make sense together, combine `z.object({...})` (the required structure)
with `.refine()` (the cross-field logic) — a violation is rejected and self-corrects
on the free retry, with your refine message as the reason:

```ts
review: z.object({ verdict: z.enum(["pass","fail"]), score: z.number().min(0).max(10),
                   reason: z.string(), checked_by: z.string() })
  .refine((r) => r.verdict !== "pass" || r.score >= 7,
          { message: "a pass requires score >= 7" }),
// then the edge gates on the now-guaranteed-coherent value:
{ from: "review", to: "ship", when: (s) => s.review.verdict === "pass" },
```

### How data flows (know this before authoring)

Every node receives: the run's **goal**, plus the current value of each declared
`inputs` key — nothing else. The engine automatically appends an output contract to
each node's prompt telling it to end with a fenced json block containing exactly its
`outputs` keys; the engine parses that block into state (one automatic retry if the
model gets it wrong, then the run fails loudly). A node with no `outputs` is legal —
its reply is recorded but nothing is harvested.

### How the walk moves (edge semantics — load-bearing)

After a target completes, the engine scans `edges` **in array order and takes the
FIRST edge that matches** (its `from` matches, its `when` holds, its `maxLoops` has
budget left). Everything about gates follows from this:

```ts
edges: [
  // loop-back FIRST: while the bar isn't met (and budget remains), revise…
  { from: "judge", to: "writer",  when: (s) => Number(s["score"]) < 8, maxLoops: 3 },
  // …otherwise fall through to the unconditional advance.
  { from: "judge", to: "publish" },
]
```

Swap those two lines and the loop-back is dead code — the unconditional edge always
wins. When `maxLoops` is spent the conditional edge stops matching and the walk falls
through to the next edge: that is the "proceed with the best we have" behaviour, by
construction. Running out of matching edges at (or without) the `exit` is a clean
finish; anywhere else it fails naming the stuck node.

**Groups**: members run concurrently against the SAME state snapshot (none sees a
sibling's output), then merge at a barrier. Edges from the group name fire once, after
the merge.

### Rules that matter

- **`inputs`/`outputs` are the data-flow AND access-control model.** Independence is
  a feature: jury nodes get NO inputs so they can't anchor on each other.
- **`runtime: "model"` is the default** — one OpenRouter call, fast, streams. Model
  nodes may NOT declare `skills`/`mcp`/`tools`/`maxTurns` tooling (validation error).
- **`runtime: "agent"`** loops — calls tools, reads results, calls more, until it
  answers. Built-ins: `read_file`, `list_files`, `glob`, `grep`, `fetch_url`
  (read) and `write_file`, `edit_file`, `bash` (write). All are confined to the
  project root; `bash` also runs under a timeout with a process-group kill.
  **`bash` does not sandbox the command itself** — a command that reaches
  outside the root will do so, so disarm it where it has no business:
  `defaults: { tools: { bash: false } }` for the scene, `tools: { bash: false }`
  for one node. Use `bash` to VERIFY (run the tests you just changed), not just
  to act. Add MCP servers per node with `mcp: ["name"]`, or scene-wide with
  `defaults.mcp`.
- **`runtime: "opencode"`** rents a real coding-agent CLI for ONE node. Reach for
  it when a node must genuinely build something; stay on `"agent"` otherwise,
  because an external CLI injects thousands of tokens of its own scaffolding per
  call. Needs `opencode` on PATH (`brew install sst/tap/opencode`) — `ensemble
  validate` says so before anything spends — and nothing else: it reads the same
  `OPENROUTER_API_KEY`, and the scene's `defaults.skills`/`defaults.mcp` are
  injected into it per call, so one grant covers both agents. Fields: `model`,
  `prompt`, `skills`, `mcp`, `timeout` (seconds), `dir` (subdirectory of root).
  Mount another CLI with `registerAgentBackend({ name, bin, command, parse })` —
  the name becomes the runtime name. Never mount one that meters a first-party
  consumer subscription; that violates the upstream terms when automated.
- **`runtime: "ask"`** makes no model call at all — it **pauses the run** until
  someone supplies its `outputs`. Declares `question` (what to ask) and `outputs`
  (the state keys the answer must fill); never `model`/`prompt`/`mcp`/`skills`.
  Free, and durable: the question lives in the journal, so the run can wait days.
  Its `inputs` are rendered into the pause as **context** — this is how content
  generated DURING the run (a quiz question, a draft to approve) reaches the
  answerer; the static `question` cannot contain it. Add **`always: true`** for a
  node inside a loop that must collect a FRESH answer on every entry (a game
  round, an iterative review) — the default presence-based node asks once and
  then falls through forever. See §3 for how to answer one.
- **Agent nodes cost real money.** Recent tool results are resent each turn (results
  older than 6 calls are auto-pruned to stubs); a vague job ("audit everything") still
  compounds — a real example dropped $0.44 → $0.05 just by narrowing the prompt. Give
  agent nodes a narrow, bounded job. On its final turn — `maxTurns` reached or the
  cost cap crossed — an agent loses its tools and must answer from what it has: a
  best-effort answer lands in state instead of a hard failure.
- **Restate the output contract at the END of an agent node's prompt** ("after you
  finish using tools, your FINAL message must end with the required json block").
  Deep in a tool loop the model stays in "keep working" mode and will narrate instead.
- **Conditions are real code**: `when: (s) => Number(s["score"]) < 8`. Without a
  `state` schema, wrap numeric comparisons in `Number()` — models sometimes emit `"7"`
  as a string. **With `z.number()` on that key the guard is unnecessary** and `s.score`
  is typed. A throwing predicate fails the run naming the edge.
- **`maxLoops` on every cycle.** Global rails: 50 node runs, 20 min wall clock, and
  an optional hard cost cap (`--max-runs` / `--timeout` / `--budget 0.50`;
  `ENSEMBLE_BUDGET` caps every run on the machine). Running out of matching edges at
  (or without) the exit is a clean finish; anywhere else it is an error naming the
  stuck node.
- Two nodes in the same parallel group must not write the same output key
  (validation error — it would be a silent race).
- **Cast asymmetrically**: cheap/fast models for volume work, one strong model at
  the gate or synthesis step. `ensemble models [filter]` lists what's reachable.

## 2 · The operating loop: validate → run → read → revise

**Prefer the MCP tools when they are available.** This plugin bundles the `ensemble`
MCP server, so installing the plugin is all the setup there is — the tools may appear
prefixed (`mcp__plugin_ensemble_ensemble__run_scene`) or bare, depending on how the
server was registered. They exist precisely for an agent operating runs: `run_scene`
returns the runId **immediately** and the run continues in the background, so you keep
working instead of blocking on a shell.

| Tool | Use |
|---|---|
| `validate_scene` | free pre-flight — always before spending |
| `run_scene(file, goal, budget?)` | async start → runId |
| `run_status(runId)` | running/**waiting**/stopped/completed · position · spend · recent activity |
| `peek_state(runId, keys?)` | read the blackboard mid-run (clipped values) |
| `stop_run(runId)` | live run: abort resumably · parked run: CANCEL for good |
| `resume_run(runId, budget?, answers?)` | continue from the checkpoint; `answers` answers an ask node |
| `list_runs()` | what exists, what's resumable |

The loop: start with a low budget → poll `run_status` → `peek_state` at the partial
work → stop if it's going sideways, resume with a higher cap only if it earned it.
If status is **`waiting`**, the scene is asking a question — answer it (see §3).

How the server works, so its behaviour doesn't surprise you:

- **No daemon, no port.** The MCP host spawns `ensemble mcp serve` on stdio per
  session and reaps it after. Several instances coexisting is normal and harmless.
- **cwd-scoped — this is how it knows your project.** The host spawns it with your
  session's directory, so it reads that project's `.ensemble/` (runs, config, scenes)
  with nothing to configure. `list_runs` reports the bound `project.root` and the
  scenes it can see: check it when results look wrong, because `[]` usually means
  "different project than you think", not "no runs".
- **One project per server.** `run_scene` refuses a scene outside its project rather
  than running it against the wrong config — use the MCP server (or CLI) in that
  project instead.
- **Everything reads the run directory** (`state/costs/journal.json`, checkpointed
  after every node) — so status/peek/resume work across instances and survive
  crashes. The one exception is **`stop_run`**: it needs the in-memory abort handle,
  so only the instance that started a run can stop it.
- A run whose server process dies is not lost — it stops *resumably*, like every
  other early stop.

**Budget discipline** — the default posture, not an option:

1. **Never start a run without a budget.** Exploring a new scene: `0.10–0.25`.
   A proven scene doing real work: `0.50–1`. Let `ENSEMBLE_BUDGET` be the backstop.
2. The cap is a **pause button**, not a failure: read the partial state, resume with
   a higher total only if the work earned it. Never restart — resume.
3. After any run, read `costs.json` before revising: fix the node that burned the
   money (usually an agent node with too wide a job), not the one that's cheap.

The CLI does the same jobs when there is a shell and no MCP host:

```bash
ensemble validate review.mts                        # FREE — always run before spending
ensemble run review.mts "<the goal>" --budget 0.50  # hard cost cap — set one when iterating
ensemble resume .ensemble/runs/<id> --budget 1.00   # continue a stopped run, don't restart
ensemble cancel .ensemble/runs/<id> "reason"        # close a parked run for good (artifacts kept)
ensemble serve                         # browser: live canvas, streaming tokens, spend
                                       # ticker + Costs tab, state tab, source editor
```

A run prints a `cost by node` breakdown at the end (failed runs included). Read the
artifacts after every run — this is how you decide what to change:

```bash
cat .ensemble/runs/<timestamp>-<scene>/state.json   # the full blackboard
cat .ensemble/runs/<timestamp>-<scene>/result.md    # every key rendered
cat .ensemble/runs/<timestamp>-<scene>/costs.json   # per-node spend — who burned it
cat .ensemble/runs/<timestamp>-<scene>/journal.json # graph position — what resume uses
cat ~/.ensemble/index.jsonl                         # every run on this machine, any project
```

`ensemble serve` has a **Runs** tab that reads that index, so runs you started over
MCP — in this project or any other — are visible there, live, with status, spend, and
a pending question if one is waiting. Click a run for its journal and state.

**A stopped run is never a dead end.** Budget spent, node failed, ctrl-C, timeout —
`ensemble resume <run-dir>` continues from the checkpoint, skipping everything already
paid for and writing into the same run dir (one cumulative `costs.json`). Budgets
apply to the *cumulative* total, `maxLoops` counters survive the stop, and editing the
scene between attempts is allowed (resume warns that edge-keyed loop counters may
shift).

**Revise rather than accept.** Weak output → find the weak link in `state.json`
(thin findings? gate never passing? judge too lenient?) and change the scene: a
prompt, a model, a threshold, an extra node. Validation is free and most runs cost
cents — iterating is the intended use.

Warnings to act on:
- `node:lossy` — the node wrote its real answer as prose and put only a summary in
  its json block; strengthen that node's contract ("the value must contain the FULL
  content, not a summary").
- `exceeded maxNodeRuns` — a cycle has no working exit; check the gate's state key
  is actually written by the node you think writes it.
- `budget exhausted` — the run stopped at the cap, position journalled; read
  `costs.json` for the burner, then either narrow that node's job or continue with
  `ensemble resume <run-dir> --budget <higher>`. Never restart from scratch.

## 3 · Patterns to reach for

**Jury / second opinion** — N vendors answer independently (no `inputs`!), run as a
parallel group, one foreman synthesises with `consensus` / `dissent` / `strongest` /
`answer` outputs. Tell the foreman "do not invent conflict."

**Score gate (improve-until-good)** — worker → judge that emits a NUMBER `score` +
`feedback`; edge `when: (s) => Number(s["score"]) < TARGET, maxLoops: N` loops the
feedback back into the worker (`inputs: ["feedback", "score"]`).

**Autoresearch (improve ONE file against a code-graded metric) — NOT A SCENE.**
When the goal is "make X better" and a command can score X, do not author a scene.
Two dedicated skills own this, and they are the source of truth:

- **`autoresearch`** — the concept: the three things, why each constraint exists,
  and whether the goal qualifies at all.
- **`autoresearch-build`** — the implementation: seeding the artefact, writing the
  evaluator, the program file, `ensemble research`, reading `results.tsv`.

Load one of those rather than improvising a propose/evaluate graph here. The one
thing worth repeating: `ensemble research` takes **no goal argument** — the
directive lives in `instruction`, in the file.

**Escape hatch (only when the sealed mode genuinely cannot express the experiment** —
a jury of proposers, a human gate each round, two metrics): drop to `scene()` with a
scene-level `research` block and `runtime: "experiment"` — the same machinery
with the guardrails off:

```ts
research: {
  edit: "src/prompt.md",            // the ONLY file agents may write (string or array)
  measure: "node bench.mjs",        // prints the metric; killed at `budget`
  metric: "score",                  // parsed from output: `score: 12.5` / `score=` / JSON
  minimize: false,                  // true for a loss
  budget: "5m",                     // per try; overrun = crash, never a longer try
  threshold: 0,                     // raise to the metric's run-to-run noise
  log: "results.tsv",               // audit trail, root-relative
},
nodes: {
  propose:    { runtime: "agent", inputs: ["best", "verdict", "reason", "output"], outputs: ["hypothesis"] },
  experiment: { runtime: "experiment", note: "hypothesis",
                outputs: ["iteration", "score", "best", "verdict", "reason", "output"] },
},
edges: [
  { from: "experiment", to: "propose", when: (s) => Number(s.iteration) <= N },
  { from: "propose", to: "experiment" },
],
entry: "experiment", exit: "experiment",   // first pass = baseline, nothing to keep/revert
```

Both forms buy the same enforcement: agent nodes get `write_file`/`edit_file`
**narrowed** to the artefact — they override the general built-ins of the same name —
and `bash` is withdrawn entirely, since a proposer that can shell out can rewrite its
own evaluator. The experiment node snapshots the incumbent, measures under the budget,
keeps only a candidate that beats `best` by more than the threshold, restores the
incumbent on revert or crash, and logs every try.
[`examples/05-autoresearch`](https://github.com/ghostmind-labo/ensemble/tree/main/examples/05-autoresearch) in the ensemble repo is a
complete, cheap instance of the sealed mode. (Repo paths, not the user's project — do
not try to read them locally unless you are inside a checkout of ensemble.)

**Pipeline with rejection** — research → parallel review (critic + factchecker) →
write, with `verdict === "reject"` looping back, capped by `maxLoops`.

**Interactive loop (a game, an interview, an iterative review)** — an `always` ask
node inside a `maxLoops` cycle parks EVERY round; a generator node writes fresh
content each pass and the pause's context carries it to the answerer. Score or
history accumulates on the blackboard across pauses. See
[`dev/.ensemble/scenes/trivia.mts`](https://github.com/ghostmind-labo/ensemble/tree/main/dev/.ensemble/scenes/trivia.mts) in the ensemble
repo for a complete 5-round quiz.

**Human — or agent — in the loop (`runtime: "ask"`)** — a node that stops the run and
waits for an answer. The canonical shape is an approval gate:

```ts
approval: {
  runtime: "ask",
  question: "Ship this draft? Reply approve or reject, and say why.",
  inputs: ["draft"],              // context for whoever answers
  outputs: ["verdict", "why"],    // the keys their answer must fill
},
// then gate on it like any other state:
{ from: "approval", to: "publish", when: (s) => s["verdict"] === "approve" },
```

**How you answer one, as the operating agent:**

1. `run_status` reports `status: "waiting"` with `waitingFor: { node, question, answerKeys }`.
2. Decide who answers. **You may answer it yourself** — you are a legitimate
   answerer, so if the question is within your remit, answer it. If it needs the
   human (taste, money, risk, anything irreversible), relay the question to them
   verbatim and wait for their reply.
3. `resume_run { runId, answers: { <answerKeys> } }`. The run continues from the
   pause; nothing already paid for re-runs.

Resuming **without** the answers parks again on the same question rather than
skipping the gate — so a gate cannot be bypassed by retrying. CLI equivalent:
`ensemble resume <run-dir> --answer verdict=approve --answer why="…"`.

**Escalate-on-exception** — an ask node is an ordinary node, so route to it only when
the run warrants a human. The same scene then runs unattended when routine and asks
only when it matters:

```ts
{ from: "check", to: "approval", when: (s) => Number(s["risk"]) > 7 },
{ from: "check", to: "publish" },     // low risk → nobody is asked
{ from: "approval", to: "publish" },
```

**The pause test is presence, not usefulness.** An ask node parks only while its
`outputs` keys are ABSENT from state — so an earlier node writing those keys makes
the gate fall through silently, even with an empty value, and on a loop a key written
once satisfies the gate forever. Use that deliberately (pre-seed `answers` on
`run_scene` to run a gated scene non-interactively) — but for auto-approve-else-ask,
prefer explicit routing as above with the checker writing its OWN key
(`auto_verdict`), so skipping the human is visible in the graph, not a side effect of
key naming.

**Orchestrator + teams (council)** — composes the others at scale: one framing node
writes `frame`/`constraints` that every later node reads (never re-litigated);
parallel teams (recon → competing options → red-team) feed an adjudicator gate that
loops the options team with `feedback` until a scored bar passes; a production team
writes sections a publisher merges. Cast the money at the orchestration points
(framer, gate, publisher), cheap models on the teams.

Working examples with real run logs: `examples/` in the repo
(`ghostmind-labo/ensemble`) — 01 jury, 02 score gate, 03 full stack (MCP + skills),
04 decision council (orchestrator, 4 teams, gate, 15 nodes).

## 4 · Skills and MCP (mostly zero-config)

**Both registries are inherited.** Check before configuring anything:

```bash
ensemble skills    # skills found, tagged project:/global:/custom:
ensemble mcp       # servers CONNECTED (not just declared) + every tool they expose
```

- **Skills**: same `SKILL.md` format and directories as Claude Code
  (`.claude/skills/`, `~/.claude/skills/`, `.opencode/`, `.agents/` variants). A
  node's `skills: ["name"]` inlines those files into its system prompt — that node's
  only, by construction.
- **MCP servers**: five sources, first definition wins —
  `.ensemble/ensemble.json` (**put yours here**) → `./ensemble.json` (legacy) →
  `./.mcp.json` (Claude Code's) → `~/.config/ensemble/ensemble.json` →
  `~/.claude.json` (Claude Code's). Servers the user already wired into Claude Code
  work with no reconfiguration.
- **Transports**: stdio, Streamable HTTP (incl. stateless), SSE auto-fallback.
- **Auth**: none, header token, or **OAuth**: `ensemble mcp login <server>` opens the
  browser, catches the redirect, stores tokens in `~/.config/ensemble/auth.json`.
  Once per server. `ensemble mcp logout <server>` forgets. A server needing it shows
  `needs auth` in `ensemble mcp` with the exact command. Headless: set
  `ENSEMBLE_NO_BROWSER=1` and give the user the printed URL.
- **Never hardcode a secret in ensemble.json** — it is meant to be committed. Use
  `"Authorization": "Bearer ${MY_TOKEN}"`; `${VAR}` / `${VAR:-default}` expand from
  the environment or a gitignored `.env` beside the config (auto-loaded; exported
  vars win). An unset variable is reported by name before connecting.
- Declaring a server: `{ "mcp": { "fs": { "type": "local", "command": ["npx", "-y",
  "@modelcontextprotocol/server-filesystem", "."] } } }` — then `mcp: ["fs"]` on the
  node. Config is cwd-relative: run from the directory that holds it.
- **Isolation**: a `sources` block (`claudeSkills`/`opencodeSkills`/`agentsSkills`/
  `claudeMcp`: false, `skillDirs: ["./team-skills"]`) turns inheritance off for repos
  that must not depend on the machine. Custom dirs are scanned first.

## 5 · Tuning agent behaviour (advanced)

The operating instructions every agent node receives can be replaced per project:

```bash
ENSEMBLE_AGENT_PROMPT=/path/to/block.md ensemble run scene.mts "goal"
```

The file replaces the built-in "how to use your tools" block (keep the literal
`{toolCount}` placeholder). The ensemble repo's [`bench/`](https://github.com/ghostmind-labo/ensemble/tree/main/bench) is an autoresearch loop that
measures candidates against 12 code-graded tasks and keeps only variants that beat
the incumbent by more than the measured noise floor. Reach for this only if a user
has a specific, repeated complaint about agent-node behaviour — the default is tuned.

## 6 · Library use (embedding in code)

Everything is a mountable object: `registerRuntime` (new node kind),
`registerTool` (new agent tool), `registerCapability` (new scene-level block —
`research:` is the first; a capability owns its schema, checks, contributed
tools, and guard tuning), `store` (artifact destination), `onEvent` (sink).


```ts
import { loadScene, loadRegistry, runScene, readJournal } from "@ghostmind-dev/ensemble";

const scn = await loadScene("review.mts", loadRegistry());
const result = await runScene(scn, goal, {
  budget: 0.5,                 // optional hard cost cap (USD)
  // resumeFrom: readJournal(".ensemble/runs/<id>"),   // continue a stopped run
  onEvent: (e) => {
    if (e.type === "node:delta") process.stdout.write(e.delta);  // live tokens
    if (e.type === "node:tool")  console.log("⚒", e.tool);       // agent tool calls
    if (e.type === "node:end")   console.log(e.node, e.cost);
  },
});
if (result.ok) console.log(result.state);   // the blackboard
```

The terminal and browser render this same typed `RunEvent` stream — an embedding
sees exactly what they see.
