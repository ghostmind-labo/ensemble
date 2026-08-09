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
ensemble run <scene.mts> "<goal>"     # execute a scene
ensemble serve [scenes-dir]          # live viewer + editor in the browser
ensemble view <scene.mts>             # draw it (--mermaid, --html[=file])
ensemble validate <scene.mts>         # check it without spending tokens
ensemble skills                      # list the skill + MCP registry (from config)
ensemble mcp                         # connect MCP servers and list their tools
ensemble models [filter]             # list models available through OpenRouter
```

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
| Per-edge loops | unlimited | `maxLoops:` on the edge |
| Agent tool-calling turns | 12 | `maxTurns:` on the node |
| Filesystem writes | **impossible** — no write tool exists | use an MCP server |

A `when` predicate that throws fails the run naming the edge. Two JSON-contract
failures in a row fail the node loudly. An extraction that keeps <25% of a long
reply raises a `node:lossy` warning — the model probably summarised its real answer
away.

## Run artifacts

`.ensemble/runs/<timestamp>-<scene>/` — `state.json` (checkpointed blackboard) and
`result.md` (every key rendered).

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

## Status

v0.2 — **fully self-contained**; the opencode dependency is gone. Verified: per-node
cross-vendor routing, the agent loop calling built-in *and* MCP tools until done,
skills inlined from SKILL.md, function conditions, loop caps, parallel groups, token
streaming, validate-before-save editing. Not built yet: the orchestrator node (dynamic
routing) and drag-and-drop editing.
