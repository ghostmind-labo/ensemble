# Examples

One folder per example. Each is self-contained: a scene, a README explaining how it
works, and instructions for testing it. Every README documents a **real run** —
actual output, actual timings, actual cost — not an illustration of what one might
look like.

| # | Example | Demonstrates | ~Cost |
|---|---|---|---|
| [01](./01-model-jury) | **Model Jury** — three vendors answer the same question, a foreman synthesises | Parallel groups · cross-vendor routing · fan-in | $0.08 |
| [02](./02-score-gate) | **Score Gate** — a judge scores the work; the graph only advances past a threshold | Conditional edges · typed state · feedback loops · `maxLoops` budget | $0.03 |
| [03](./03-full-stack) | **Full Stack** — model node plans, agent node reads files via MCP, agent node applies a skill | Both runtimes · MCP setup · skills · where config lives · measured agent overhead | $0.04 |
| [04](./04-decision-council) | **Decision Council** — orchestrator, four teams, an adjudicating gate | Composition at scale · 15 nodes | — |
| [05](./05-autoresearch) | **Autoresearch** — an agent improves one file against a code-graded metric; keep or revert, logged | `research` block · `runtime: "experiment"` · scoped write tools · time budget · `results.tsv` | ~$0.03/iter |

## Before running any of them

```bash
ensemble skills     # confirm your skill registry is visible
ensemble mcp        # confirm which MCP servers actually connected (often none)
ensemble models     # 300+ models reachable through OpenRouter
```

You need `opencode` on PATH with an OpenRouter provider configured, and
`OPENROUTER_API_KEY` set. See the [root README](../README.md).

## The habit worth forming

```bash
ensemble validate <scene>.mts      # free, instant, catches typos and broken wiring
ensemble view <scene>.mts          # see the topology before you trust it
ensemble run <scene>.mts "…"       # only now does it cost anything
```

`validate` catches unknown skills, edges to nonexistent nodes, unreachable exits,
parallel state-key collisions, and skills declared on model nodes — before any spend.

## Run them from the repo root

```bash
ensemble run examples/01-model-jury/jury.mts "your question"
```

Not from inside the example folder. opencode treats your **working directory** as the
project root and installs ~61 MB of its own `node_modules` there — `cd`-ing into each
example gives every one of them a separate copy. From the root, they share one.

Generated agents land in `.opencode/agents/ensemble-<scene>-<node>.md` and run artifacts
in `.ensemble/runs/<timestamp>-<scene>/`, both at the root, both gitignored. Nothing is
written into the example folder itself, so `examples/` stays exactly what you see in
git.

## Adding an example

```
examples/NN-short-name/
├── README.md      what it does, how it works, how to test, a real run
└── <name>.mts      the scene (TypeScript, default-exports scene({ … }))
```

Keep each one focused on demonstrating **one** idea clearly. If a README claims a
behaviour, it should show the output that proves it.
