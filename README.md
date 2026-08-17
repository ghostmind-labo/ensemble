# ensemble

Multi-model agent ensembles. You describe a **scene** — nodes wired by
edges, each node a model with scoped state access — in **one TypeScript file**, and
`ensemble` runs it: conditions, loops, parallel groups, live visualization.

Every node can use a **different model from a different vendor**, and every node can
be one of two kinds:

- **`runtime: "model"`** (default) — one direct OpenRouter call. Streams tokens live.
  Pure *think*.
- **`runtime: "agent"`** — our own tool-calling loop: read-only built-in tools plus any
  MCP servers the node allowlists, looping until the model stops asking for tools.
  Pure *do*.

**No subprocess, no external agent, nothing to install but this package.** The only
credential is `OPENROUTER_API_KEY`.

```
scenes/*.ts ──import──> Scene ──validate──> engine ──events──> terminal / browser
                                              │
                            ┌─────────────────┴────────────────┐
                    runtime: "model"                    runtime: "agent"
                    one OpenRouter call                 tool-calling loop
                    SSE streaming · usage.cost          built-ins + MCP servers
```

## A scene is one TypeScript file

```ts
import { scene } from "@ghostmind-dev/ensemble";

export default scene({
  name: "research-and-critique",
  defaults: { model: "openrouter/anthropic/claude-sonnet-5" },

  nodes: {
    researcher: {
      model: "openrouter/google/gemini-2.5-flash",
      prompt: "Research the goal. Be concrete.",
      outputs: ["findings"],
    },
    critic: {
      model: "openrouter/anthropic/claude-haiku-4.5",
      inputs: ["findings"],                      // sees ONLY this state
      outputs: ["verdict", "notes"],
    },
    inspector: {
      runtime: "agent",                          // gets tools, loops until done
      mcp: ["fs"],                               // MCP servers it may use
      skills: ["graphify"],                      // skills inlined into its prompt
      inputs: ["findings"],
      outputs: ["report"],
    },
    writer: {
      inputs: ["findings", "notes"],
      outputs: ["result"],
    },
  },

  groups: { review: ["critic", "inspector"] },   // run concurrently, merge on completion

  edges: [
    { from: "researcher", to: "review" },
    { from: "review", to: "writer",     when: (s) => s["verdict"] === "accept" },
    { from: "review", to: "researcher", when: (s) => s["verdict"] === "reject", maxLoops: 2 },
  ],

  entry: "researcher",
  exit: "writer",
});
```

## Typed state: pin the shape of the blackboard

`outputs` says *which* keys a node owes. `state` says what **shape** they must be —
and because the values arrive as JSON from a model, that check has to exist at run
time, which a TypeScript type alone cannot do:

```ts
import { scene, z } from "@ghostmind-dev/ensemble";   // z is re-exported for you

export default scene({
  name: "review",
  state: {
    findings: z.array(z.object({ file: z.string(), severity: z.enum(["low", "high"]) })),
    score:    z.number().min(0).max(10),
    verdict:  z.enum(["accept", "reject"]),
  },
  nodes: { scanner: { outputs: ["findings"] }, judge: { inputs: ["findings"], outputs: ["score", "verdict"] } },
  edges: [{ from: "judge", to: "writer", when: (s) => s.score >= 8 }],   // s is typed
  entry: "scanner", exit: "writer",
});
```

One declaration does three jobs:

- **The model is shown the shape.** The auto-generated output contract renders
  `"score": number (0-10)`, not `"score": ...` — compliance improves from that alone.
- **Wrong shapes self-correct.** A mismatch becomes the retry reason naming the exact
  path (`findings.0.severity: …`), so the existing free retry fixes it instead of a
  bad value poisoning state. What lands in state is zod's *parsed* value.
- **`when` predicates are typed.** `s.score >= 8` type-checks; no `Number()` guard, and
  a typo'd key is a compile error rather than a silent `undefined`.

Entirely **additive**: keys with no schema behave exactly as before, so existing scenes
are unaffected. Schema the keys gates depend on; leave prose keys as plain strings.

Three things carry the design:

- **`inputs` / `outputs` are the whole data-flow contract** — and the access-control
  model. A node sees exactly the state keys it declares, nothing else. State lives on
  a shared blackboard, checkpointed after every node.
- **Conditions are real code.** `when: (s) => s["verdict"] === "reject"` — typed,
  autocompleted, no expression mini-language to learn.
- **`scene()` is an identity function carrying types.** A model authoring a scene
  gets its mistakes flagged by the type checker before a single token is spent —
  which is the point: this format is designed to be *generated*.

## Getting started from scratch

**Two things: the CLI and an API key.** No `package.json`, no `npm install`, no
project scaffolding.

```bash
npm i -g @ghostmind-dev/ensemble
export OPENROUTER_API_KEY=sk-or-...          # https://openrouter.ai/keys
```

Now write **one `.mts` file** anywhere:

```ts
// ask.mts
import { scene } from "@ghostmind-dev/ensemble";

export default scene({
  name: "ask",
  nodes: {
    a: {
      model: "openrouter/anthropic/claude-haiku-4.5",
      prompt: "Answer briefly.",
      outputs: ["answer"],
    },
  },
  entry: "a",
  exit: "a",
});
```

```bash
ensemble validate ask.mts        # free — catches every wiring mistake
ensemble run ask.mts "your goal" # costs money
ensemble serve .                 # watch it live in a browser
```

That directory can contain **nothing but `ask.mts`** and it works — verified. The
`.mts` extension marks the file as an ES module without a `package.json`, and the
import resolves against the global install.

> Prefer `.ts`? That works too, but then the nearest `package.json` needs
> `"type": "module"`. `.mts` avoids the question entirely, which is why every
> example here uses it.

Before spending anything, see what you already have — both are free and instant:

```bash
ensemble skills        # skills found (yours + Claude Code's)
ensemble mcp           # MCP servers, CONNECTED, with their tools
ensemble models gpt    # models you can reach
```

## Two ways to drive it — pick one, or use both

Ensemble is one engine with two front doors. **Same scenes, same runs, same run
directory** — they differ only in who is holding the wheel.

| | **CLI** | **MCP tools** |
|---|---|---|
| For | you, at a terminal | an AI agent, with or without a shell |
| Start a run | `ensemble run …` — **blocks** until done | `run_scene` — returns a runId **instantly** |
| Watch it | terminal output, or `ensemble serve` | `run_status` / `peek_state`, polled |
| Stop it | ctrl-C | `stop_run` |
| Continue | `ensemble resume <dir>` | `resume_run` |

The rule of thumb: **if a human is watching, use the CLI; if an agent is deciding,
use the MCP.** The CLI blocks, which is fine when you are sitting there and wrong
when an agent needs to do other work meanwhile.

### Installing it once, for every project

The MCP server is **global, not per-project**. You register it a single time:

```bash
npm i -g @ghostmind-dev/ensemble
claude mcp add ensemble -s user -- ensemble mcp serve   # -s user = all projects
```

`-s user` is what makes it global. There is **no daemon to start and no port** —
your MCP host launches `ensemble mcp serve` on stdio when it needs it and shuts it
down after. Nothing runs in the background between sessions.

### Then per-folder, nothing to set up

Runs are **cwd-relative**, and everything a project owns lives under one folder — no
per-project install and no init step:

```
my-project/
└── .ensemble/
    ├── scenes/review.mts    ← your workflows
    ├── ensemble.json        ← OPTIONAL: MCP servers for agent nodes
    ├── .env                 ← OPTIONAL: secrets for that config (gitignore it)
    └── runs/                ← run artifacts, created on first run
```

So "a workflow per project" is simply: **put a `.mts` file in `.ensemble/scenes/`.**
`ensemble serve` then finds it with no arguments, and `ensemble run <path>` accepts any
path. A legacy `./ensemble.json` or `./scenes/` still loads, so older projects keep
working — but new work goes under `.ensemble/`.

### Getting the plugin — the lowest-friction path

The plugin bundles the **skill** (the operating manual that teaches your agent the
scene format, the patterns, casting, and the budget/resume discipline) **and the MCP
server**, wired up automatically. Two lines, and there is nothing else to configure:

```
/plugin marketplace add ghostmind-labo/ensemble
/plugin install ensemble@ghostmind-ensemble
```

**No separate `npm i -g`, no `claude mcp add`.** The bundled server prefers an
`ensemble` already on your PATH and otherwise falls back to `npx`, so it works on a
machine with nothing installed — the first launch just pays a download.

Then you skip the syntax entirely and ask for what you want:

> *"Build me a scene where three models answer independently and a fourth picks the
> best, then run it on this question with a $0.50 cap."*

> Already ran `claude mcp add ensemble` by hand? Drop it with
> `claude mcp remove ensemble -s user` once the plugin is installed, or you will have
> the same tools twice.

**Skill and MCP are complements, not alternatives.** The skill is *knowledge* (how
to write a good scene, what to do when a gate never passes); the MCP is *hands* (start,
watch, stop, resume). The skill even tells the agent to prefer the MCP tools when
they are present. Use both — that is the intended setup.

Rough guide to what you need:

- **Just you, terminal** → global install + API key. Done.
- **Agent writes and runs scenes for you** → add the plugin (skill + MCP).
- **Agent in another host / no shell** → `claude mcp add …` (or point any MCP host at
  `ensemble mcp serve`).

## Where skills and MCP servers live

**You probably don't need to configure anything.** Both registries are inherited from
Claude Code if you already use it.

### Skills

Same `SKILL.md` format and the same six directories Claude Code reads, project first:

```
.claude/skills/<name>/SKILL.md          ← project   (Claude Code's own location)
.opencode/skills/<name>/SKILL.md        ← project
.agents/skills/<name>/SKILL.md          ← project
~/.claude/skills/<name>/SKILL.md        ← global    (Claude Code's own location)
~/.config/opencode/skills/<name>/       ← global
~/.agents/skills/<name>/SKILL.md        ← global
```

Every skill you already wrote for Claude Code works here unchanged. A node opts in
with `skills: ["name"]`; the file's body is inlined into that node's system prompt.

### MCP servers

Four sources, first definition wins:

| Order | File | Format |
|---|---|---|
| 1 | `./ensemble.json` → `mcp` | ours |
| 2 | `./.mcp.json` → `mcpServers` | **Claude Code's** |
| 3 | `~/.config/ensemble/ensemble.json` → `mcp` | ours |
| 4 | `~/.claude.json` → `mcpServers` | **Claude Code's** |

So **your existing Claude Code MCP servers just work.** Verified on a real machine:

```
$ ensemble mcp
  github  connected  44 tool(s)  global:claude
  tmux    connected  13 tool(s)  global:claude
```

The formats differ slightly — Claude splits `command`/`args` and calls remote servers
`"http"` — and ensemble normalises both. Declare your own only when you want something
Claude Code doesn't have, or want to override a name:

```json
{
  "mcp": {
    "fs": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

`ensemble mcp` shows the source of every server, so you always know which file a
definition came from.

### Transports — all of them

| Kind | Support |
|---|---|
| **stdio** (local process) | ✅ |
| **Streamable HTTP** (current spec) | ✅ including **stateless** servers |
| **SSE** (earlier spec) | ✅ automatic fallback |

Remote servers try Streamable HTTP first and fall back to SSE, so a server built
against either spec connects without you declaring which.

### Authentication — including OAuth

| Method | How |
|---|---|
| **No auth** | nothing to do |
| **Token in a header** | `"headers": { "Authorization": "Bearer ..." }` |
| **OAuth (browser redirect)** | `ensemble login <server>` |

Many hosted servers issue no static token at all — the only way in is an
authorization-code flow. `ensemble login` opens your browser, catches the redirect on
a loopback port, and stores the tokens in `~/.config/ensemble/auth.json` (mode `0600`).
Once per server, not once per run; refresh is automatic.

```bash
ensemble mcp                   # status — OAuth servers show `needs auth`
ensemble mcp login notion      # authorize (opens a browser)
ensemble mcp logout notion     # forget its tokens
```

The command authorizes **that MCP server**, not ensemble — there is no ensemble
account. Set `ENSEMBLE_NO_BROWSER=1` on a headless box and it prints the URL instead
of opening one. `ENSEMBLE_OAUTH_PORT` moves the loopback port if 8976 is taken.

Dynamic client registration is handled for you: against Linear's server this
registers a client, generates a PKCE `S256` challenge, and negotiates `read write`
scopes with no configuration at all.

A server needing auth shows as `needs_auth` in `ensemble mcp`, with the exact command
to fix it. Nothing forces a bearer token.

### Keeping tokens out of the config

`ensemble.json` is meant to be committed, so never put a secret in it. Reference the
environment instead — `${VAR}` and `${VAR:-fallback}` are expanded anywhere in the
config:

```json
{
  "mcp": {
    "gh": {
      "type": "remote",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GH_MCP_TOKEN}" }
    }
  }
}
```

The value can come from a real environment variable, or from a **`.env` beside the
config** — loaded automatically, so the usual pattern is:

```bash
echo "GH_MCP_TOKEN=ghp_..." >> .env
echo ".env" >> .gitignore          # commit ensemble.json, never the token
```

Exported variables win over `.env`, so CI can override without editing files.

A variable that is referenced but unset is reported by name **before** connecting:

```
! config references ${GH_MCP_TOKEN} but GH_MCP_TOKEN is not set — export it or add it to .env
```

That is deliberate: expanding to the literal string `${GH_MCP_TOKEN}` would send a
nonsense `Authorization` header and produce a baffling 401 instead of a fixable error.

> For servers that use **OAuth**, no token belongs in the config at all —
> `ensemble mcp login <server>` stores credentials outside the project entirely.

### Turning inheritance off

Inheriting is the default because it is usually what you want — but a repo that must
not depend on whatever is on the machine can say so, in `ensemble.json`:

```json
{
  "sources": {
    "claudeSkills": false,
    "opencodeSkills": false,
    "agentsSkills": false,
    "claudeMcp": false,
    "skillDirs": ["./team-skills"]
  }
}
```

Every flag defaults to `true`. `skillDirs` adds your own locations and is scanned
**first**, so an explicit skill always beats an inherited one of the same name. With
the config above, `ensemble skills` reports exactly one skill — yours — sourced
`custom:./team-skills`.

## Install

```bash
npm i -g @ghostmind-dev/ensemble      # CLI everywhere
# or, per project:
npm i @ghostmind-dev/ensemble
```

Requirements:

- **Node ≥ 22.6** — scenes are TypeScript, loaded via Node's native type stripping
- `OPENROUTER_API_KEY` in the environment — **that's the only credential**

Name scenes `.mts` and nothing else is needed. (`.ts` also works when the nearest
`package.json` has `"type": "module"` — `ensemble validate` says so if it doesn't.)

## Commands

```bash
ensemble run <scene.mts> "<goal>"     # execute a scene (--budget caps the spend)
ensemble resume <run-dir>            # continue a stopped run from its checkpoint
ensemble serve [scenes-dir]          # live viewer + editor in the browser
ensemble view <scene.mts>             # draw it (--mermaid, --html[=file])
ensemble validate <scene.mts>         # check it without spending tokens
ensemble skills                      # list the skill + MCP registry (from config)
ensemble mcp                         # connect MCP servers and list their tools
ensemble mcp serve                   # expose ensemble AS an MCP server (for agents)
ensemble models [filter]             # list models available through OpenRouter
ensemble version                     # installed version (also --version / -V)
```

`ensemble --help` prints a **First time** walkthrough and the one-line command that
wires ensemble into an AI agent — the tool explains itself, so this README is not
the only place the setup lives.

`validate` catches unknown skills, edges to missing nodes, unreachable exits,
parallel output collisions, and skills declared on model nodes — in milliseconds,
before any spend.

## ensemble serve — see it, run it, modify it

```bash
ensemble serve            # http://127.0.0.1:7777
```

- **Canvas** — the graph drawn in layers; parallel groups boxed; edges labeled with
  their actual predicates (`s["verdict"] === "accept"`); `⚡ model` / `⛭ agent` badge
  on every node.
- **Live run** — nodes pulse while running and **stream their tokens in real time**
  (model nodes); nodes whose inputs aren't ready show `⏳ waiting on: …`; each lands
  with tokens · cost · elapsed.
- **State tab** — the blackboard, updated after every node.
- **Source tab** — edit the scene and Save. The edit is validated *before* the file
  is written: a broken scene is rejected with the exact problems and the file on
  disk is never touched.

Scene files stay the source of truth; the server is a window onto them.

## Agent nodes: tools, MCP, skills

An agent node **loops** — call tools, read results, call more, until it can answer.
`maxTurns` (default 12) bounds it. Tool calls the model requests together run
concurrently.

**Built-in tools** are read-only by design: `read_file`, `list_files`, `glob`, `grep`,
`fetch_url`. There is deliberately **no `bash`, no `write`, no `edit`** — a shell tool
is the largest attack surface an agent can have, and anything that must mutate the
world should go through an MCP server whose author sandboxed it on purpose. Every path
is confined to the project root. Opt one out with `tools: { grep: false }`.

**MCP servers** live in `ensemble.json` (project) or `~/.config/ensemble/ensemble.json`
(global):

```json
{
  "mcp": {
    "fs": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

A node opts in by name: `mcp: ["fs"]`. Servers connect lazily — a scene naming none
never starts one. `ensemble mcp` connects them all and lists every tool they expose.

**Skills** use the same `SKILL.md` format and locations as Claude Code
(`~/.claude/skills/`, `.claude/skills/`, …), so skills you already have work unchanged.
A node's `skills: [...]` are inlined into its system prompt.

> **Scoping is by construction, not by policy.** We assemble each node's tool array
> ourselves, so a tool a node did not ask for isn't *denied* — it is absent. There is
> no deny-list to trust and nothing to misconfigure.

## Safety rails

| Rail | Default | Override |
|---|---|---|
| Total node executions | 50 | `--max-runs` |
| Wall clock | 20 min | `--timeout` (minutes) |
| **Run cost (USD)** | unlimited | `--budget 0.50`, or `ENSEMBLE_BUDGET` machine-wide (resumable) |
| Per-edge loops | unlimited | `maxLoops:` on the edge |
| Agent tool-calling turns | 12 | `maxTurns:` on the node |
| Filesystem writes | **impossible** — no write tool exists | use an MCP server |

**The budget is a hard stop, not a warning.** Between nodes, a run that has spent its
cap ends immediately with state checkpointed. Inside an agent node, the loop checks the
cap between turns: once crossed (or on the final `maxTurns` turn), tools are withheld
and the model is told to answer from what it already learned — a best-effort answer
instead of a hard failure. `ENSEMBLE_BUDGET=1` in your shell profile puts a $1 ceiling
under every run on the machine, including ones started from the `serve` UI, which also
takes a per-run cap in its toolbar.

Two more things keep agent loops cheap by construction: every tool result is clamped
to 8 KB before it enters the conversation, and once a result is more than six tool
calls old it is cleared down to a 200-char stub (the model can re-run the tool if it
truly needs it again). Without that second rule the loop pays for its early
exploration on every subsequent turn — cost quadratic in turns.

Every run writes `costs.json` next to `state.json` — an itemised per-node receipt —
and the terminal prints a `cost by node` breakdown at the end, failed runs included,
because "which node burned the budget" matters most exactly when a run died on it.

A `when` predicate that throws fails the run naming the edge. Two JSON-contract
failures in a row fail the node loudly. An extraction that keeps <25% of a long
reply raises a `node:lossy` warning — the model probably summarised its real answer
away.

## Human — or agent — in the loop

A node can **stop the run and wait for an answer**. It makes no model call:

```ts
approval: {
  runtime: "ask",
  question: "Ship this draft? Reply approve or reject, and say why.",
  inputs: ["draft"],              // context for whoever answers
  outputs: ["verdict", "why"],    // the keys their answer must fill
},
```

Then gate on the answer like any other state:
`{ from: "approval", to: "publish", when: (s) => s["verdict"] === "approve" }`.

The pause is **durable, not a held-open process**: the question goes into the
journal, so the run can wait minutes or days, survive a reboot, and be answered by
whoever is around —

```bash
ensemble resume .ensemble/runs/<id> --answer verdict=approve --answer why="reads well"
```

— or by the operating agent, with `resume_run { runId, answers: { … } }`. Whether a
human or an agent answers is not the engine's concern; both just supply the missing
state keys. `run_status` reports `waiting` with the question and the exact keys
expected.

**A gate cannot be bypassed by retrying.** Resuming without the answers parks again
on the same question rather than falling through, and the ask node itself costs
nothing — it is pure wait.

## Resumable runs

A run that stops early — budget spent, node failed, ctrl-C, timeout — is not a dead
end. Alongside the blackboard, every checkpoint records **where in the graph the run
was**, so it can be picked back up:

```bash
ensemble run council.mts "the goal" --budget 0.25   # stops mid-graph, cheap
cat .ensemble/runs/<id>/state.json                  # look at what you bought
ensemble resume .ensemble/runs/<id> --budget 1.00   # continue, don't restart
```

**This is what makes `--budget` a pause button rather than a kill switch.** Spend a
little, read the partial state, then decide whether it is worth more.

The continuation skips everything already paid for and lands in the *same* run
directory, so `costs.json` keeps one cumulative receipt. `journal.json` carries the
position: the target still owed, the `maxLoops` counters already consumed (so a
resumed run cannot quietly award itself a fresh loop budget), cumulative spend, and
why it stopped. A budget applies to the running total — resuming without raising it
says so immediately instead of burning a node first.

Editing the scene between attempts is allowed, and often the point: a resume warns
when the file's hash changed, because loop counters are keyed by edge order.

## Seeing every run: one viewer, all projects

Runs land in the project they belong to, but each one also appends a pointer line to
`~/.ensemble/index.jsonl`. `ensemble serve`'s **Runs** tab reads that, so a viewer
started in *any* project lists every run on the machine — grouped project → scene →
run, with status, spend, and whatever a paused run is waiting for. Click one to read
its journal and state.

That closes the gap where a run an agent started over MCP was invisible to the
browser: the viewer no longer shows only its own runs, it reads the journals, which
are written after every node. Append-only JSONL because several runners write at
once; the reader assembles the tree and drops entries whose directory is gone. The
index is pure discovery — delete it and it refills.

## Run artifacts

`.ensemble/runs/<timestamp>-<scene>/` — `state.json` (checkpointed blackboard),
`costs.json` (per-node receipt), `journal.json` (graph position, for `resume`), and
`result.md` (every key rendered, on completion).

## Ensemble as an MCP server

The primary consumer of ensemble is often another agent. `ensemble mcp serve`
exposes the whole run lifecycle as MCP tools over stdio, so any MCP host — Claude
Code, or an external agent framework — can operate runs without a shell:

| Tool | Behaviour |
|---|---|
| `validate_scene` | the free pre-flight check |
| `run_scene(file, goal, budget?)` | starts the run, returns the runId **immediately** |
| `run_status(runId)` | running/stopped/completed · graph position · spend · recent activity |
| `peek_state(runId, keys?)` | the blackboard mid-run, values clipped for context safety |
| `stop_run(runId)` | abort — safe, because the position is journalled and resumable |
| `resume_run(runId, budget?)` | continue from the checkpoint, budget cumulative |
| `list_runs()` | newest first, with resumability |

Installing the plugin wires this up for you. To register it by hand instead — in
Claude Code, or any other MCP host:

```bash
claude mcp add ensemble -s user -- ensemble mcp serve    # -s user = every project
```

```json
{ "mcpServers": { "ensemble": { "command": "ensemble", "args": ["mcp", "serve"] } } }
```

There is **no daemon and no port**: the host spawns `ensemble mcp serve` on stdio
when it needs it and reaps it afterwards.

### The two servers are not the same shape

`ensemble serve` (the browser viewer) and `ensemble mcp serve` (the agent interface)
have deliberately opposite concurrency rules:

| | `serve` — browser | `mcp serve` — agents |
|---|---|---|
| Transport | HTTP on a port (default 7777) | stdio, no port |
| How many can run | **one per port** — a second is `EADDRINUSE` | **one per client session**, many is normal |
| Concurrent runs | **one**; a second start gets `409 a run is already in progress` | **unlimited** — `run_scene` returns a runId and moves on |

The viewer shows one canvas, so it runs one scene at a time. An agent wants to fan
out, so nothing serializes it. Register the MCP server twice (say, the plugin *and* a
hand-rolled `claude mcp add`) and you simply get two independent processes with
duplicate tools — no election, no conflict.

The only tool that is instance-bound is **`stop_run`**, which needs the in-memory
abort handle of whichever process started the run; `run_status`, `peek_state`,
`list_runs`, and `resume_run` all read the run directory, so any instance can answer
for any run. That is worth knowing before you keep duplicate registrations: a run
started on one server cannot be stopped from the other.

Peek and status are reads of the checkpoint files, and stop is safe because resume
exists — so the server holds nothing but an AbortController per live run. If it
dies, in-flight runs die *resumably*: the same failure story as everywhere else.
Programmatic embedding gets the same thing via `buildEnsembleServer()`.

## Using it as a library

```ts
import { loadScene, loadRegistry, runScene } from "@ghostmind-dev/ensemble";

const scene = await loadScene("scenes/example.mts", loadRegistry());
const result = await runScene(scene, "compare Bun and Deno", {
  onEvent: (e) => {
    if (e.type === "node:delta") process.stdout.write(e.delta);   // live tokens
    if (e.type === "node:end") console.log(`\n${e.node}: $${e.cost}`);
  },
});
```

Everything the terminal and browser show comes from this one typed `RunEvent`
stream — your consumer sees exactly what they see.

## Examples

[`examples/`](./examples) — one folder per example, each README documenting a
**real run** with actual output, timings, and cost. Start with
[01 — Model Jury](./examples/01-model-jury).

## Tuning the agent scaffolding

Every `runtime: "agent"` node receives a short block of operating instructions —
batch independent calls, don't repeat failing ones, quote evidence, stop when done.
That block is **measurable and swappable**.

```bash
ENSEMBLE_AGENT_PROMPT=my-prompt.md ensemble run scene.mts "goal"   # try one
npm run bench                                                      # score it
npm run bench:optimize -- --iterations=5 --repeat=3                # improve it
```

[`bench/`](./bench) is a [Karpathy autoresearch](https://github.com/karpathy/autoresearch)
loop — propose, measure, **keep or revert**, repeat, with an audit trail in
`bench/log.jsonl`. Twelve tasks, all graded by code (never a model judge), against a
fixture project with known ground truth. Objective: `passes × 100 − turns`, so
correctness dominates and efficiency breaks ties.

Two things keep it honest, both learned the hard way:

- **The metric must not punish correct answers.** An early checker failed a right
  answer because the model wrote "does not *actually* mention". There are now unit
  tests over the exact strings that were misgraded.
- **Nothing is believed without clearing the noise floor.** The same prompt scored
  9/12 and 12/12 on consecutive sweeps, so every measurement averages N sweeps and a
  candidate must win by more than ~1 point. Ties revert.

`optimize.mts` never edits source — a winner lands in `bench/prompts/best.md` and
promotion is a deliberate step.

## Status

v0.7 — **fully self-contained**; the opencode dependency is gone. Verified: per-node
cross-vendor routing, the agent loop calling built-in *and* MCP tools until done,
skills inlined from SKILL.md, function conditions, loop caps, parallel groups, token
streaming, validate-before-save editing, hard cost budgets, resumable runs, and
ensemble driving itself over MCP.

Not built yet: the orchestrator node (dynamic routing), drag-and-drop editing, and a
machine-level run index with a single global viewer across projects.
