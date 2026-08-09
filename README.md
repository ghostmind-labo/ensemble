# ensemble

Multi-model agent ensembles. You describe a **scene** — nodes wired by
edges, each node a model with scoped state access — in **one TypeScript file**, and
`ensemble` runs it: conditions, loops, parallel groups, live visualization.

Every node can use a **different model from a different vendor**, and every node can
be one of two kinds:

- **`runtime: "model"`** (default) — a direct OpenRouter call. Fast, streams tokens
  live, costs come from OpenRouter's own usage accounting. Pure *think*.
- **`runtime: "agent"`** — a full [opencode](https://opencode.ai) agent with tools,
  skills, and MCP, scoped per node by allowlist. Pure *do*.

A scene of pure model nodes never spawns opencode at all.

```
scenes/*.ts ──import──> Scene ──validate──> engine ──events──> terminal / browser
                                              │
                            ┌─────────────────┴────────────────┐
                    runtime: "model"                    runtime: "agent"
                    direct OpenRouter fetch             opencode serve (lazy)
                    SSE streaming · usage.cost          skills · MCP · tools
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
      runtime: "agent",                          // the only kind that touches opencode
      skills: ["graphify"],                      // allowlist from the central registry
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

## Requirements

- Node ≥ 22.6 (runs TypeScript directly — no build step)
- `OPENROUTER_API_KEY` in the environment
- [`opencode`](https://opencode.ai) on `PATH` — **only if you use agent nodes**

```bash
npm install
node src/cli.ts skills     # see your skill/MCP registry
```

## Commands

```bash
ensemble run <scene.ts> "<goal>"     # execute a scene
ensemble serve [scenes-dir]          # live viewer + editor in the browser
ensemble view <scene.ts>             # draw it (--mermaid, --html[=file])
ensemble validate <scene.ts>         # check it without spending tokens
ensemble skills                      # list the skill + MCP registry (from config)
ensemble mcp                         # verify which MCP servers actually connected
ensemble models [filter]             # list models opencode can reach
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

## Skill & MCP scoping (agent nodes)

The skill store is opencode's, not this project's — `ensemble skills` shows it. An agent
node names its allowlist and gets a generated opencode agent that starts deny-all:

```yaml
permission:
  skill:
    "*": deny
    graphify: allow
```

Verified behavior: a node with `skills: ["graphify"]` sees graphify and nothing
else; a model node has no tools at all ("no tools", in its own words).

> MCP servers configured in Claude Code are **not** visible to graph nodes — opencode
> keeps its own registry in `opencode.json`. Run `ensemble mcp` to see what actually
> connected before writing a scene that depends on one.

## Safety rails

| Rail | Default | Override |
|---|---|---|
| Total node executions | 50 | `--max-runs` |
| Wall clock | 20 min | `--timeout` (minutes) |
| Per-edge loops | unlimited | `maxLoops:` on the edge |
| Filesystem writes (agent nodes) | denied | `tools: { write: true }` |

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

const scene = await loadScene("scenes/example.ts", loadRegistry());
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

v2. Verified: per-node cross-vendor routing, skill scoping, function conditions,
loop caps, parallel groups, token streaming, lazy opencode, validate-before-save
editing. Not built yet: the orchestrator node (dynamic routing), drag-and-drop
editing, the Claude Code plugin.
