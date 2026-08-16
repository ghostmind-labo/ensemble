# 04 — Decision Council

**Everything the engine can do, in one scene that holds together.** One orchestrator,
four teams, a quality gate, and a shared memory — turning a single hard question into
a decision-ready brief.

Where 01 shows parallelism, 02 shows a gate, and 03 shows the two runtimes, this one
is the composition: all four control features at once, on nothing but an API key.

```
                         ┌──────────────── STATE (shared blackboard) ────────────────┐
                         │  frame · constraints · unknowns · recon_* · option_* ·    │
                         │  crit_* · score · winner · feedback · brief_*             │
                         └───────────────────────────────────────────────────────────┘

  goal ─► orchestrator ─► ┏recon┓ ─► ┏options┓ ─► ┏redteam┓ ─► adjudicator ─► ┏production┓ ─► publisher ─► brief
          sonnet-5        ┃market┃   ┃ bold  ┃    ┃feasib.┃    sonnet-5 gate   ┃ summary ┃    sonnet-5
          frames it       ┃ tech ┃   ┃ safe  ┃    ┃ cost  ┃    scores 0-10     ┃  body   ┃    assembles
                          ┃human ┃   ┃contra.┃    ┃ risk  ┃         │          ┃appendix ┃
                          ┗━━━━━┛    ┗━━━┳━━━┛    ┗━━━━━━━┛         │          ┗━━━━━━━━━┛
                                        └──────────────────────────┘
                                          score < 8  (⟲ max 2, feedback in state)
```

15 nodes. Every one is `runtime: "model"` — a direct OpenRouter call — because this
example is about **topology, not tools**. It runs on `OPENROUTER_API_KEY` alone, no
`ensemble.json`, no skills, no MCP. (On "why call a model node an *agent*": in an
ensemble every node is a participant; `runtime` is just where it executes. See 03 for
the `agent` runtime that actually calls tools.)

---

## The four things it demonstrates

### 1 · One orchestrator

The `orchestrator` node runs first and **does not answer the question**. It writes
`frame`, `constraints`, and `unknowns` — the definition of an acceptable answer. That
framing is the single point of control: nothing downstream re-litigates the scope,
they all read it from state.

### 2 · Four teams (parallel groups)

```ts
groups: {
  recon:      ["recon_market", "recon_tech", "recon_human"],     // survey the problem
  options:    ["option_a", "option_b", "option_c"],              // three rival proposals
  redteam:    ["crit_feasibility", "crit_cost", "crit_risk"],    // attack all three
  production: ["prod_summary", "prod_body", "prod_appendix"],    // write the brief
},
```

Each team's members run **concurrently with a fan-in barrier** — the graph waits for
all three before moving on. Because parallel members writing the same state key is a
silent data race, the validator makes it a hard error: every member here owns a
distinct output key (`recon_market`, `recon_tech`, …).

### 3 · A condition (the gate)

The `adjudicator` scores the option set `0-10` **after** reading the red team's
critiques, and the graph only advances to production when it clears the bar:

```ts
edges: [
  // ...
  { from: "adjudicator", to: "options",    when: (s) => Number(s["score"]) < TARGET, maxLoops: 2 },
  { from: "adjudicator", to: "production" },
]
```

Order is load-bearing. The engine takes the **first matching edge**, so the
conditional loop-back is listed before the unconditional advance:

- `score < 8` and budget left → back to the **options** team to revise.
- `score >= 8` → the `when` is false, fall through to **production**.
- loop taken twice already → `maxLoops` skips it, fall through to **production**.

`Number()` is not decoration: it survives a model emitting `"7"` as a string, and it
means the gate is a measured value, not a vibe.

### 4 · State memory

State is one shared blackboard, checkpointed after every node. Two ways this scene
leans on it:

- **The long carry.** `frame` is written by node 1 and read by `publisher`, the last
  node, unchanged the whole run. Fifteen nodes of memory.
- **The feedback channel.** On a REVISE loop, every options node reads
  `inputs: [..., "feedback", "score"]` — so each rival proposal sees exactly the
  adjudicator's critique of the last round, and revises against it. That is the
  self-improvement loop from example 02, now feeding a whole team.

---

## Run it

```bash
# from the repo root — no config, no install beyond the tool itself
ensemble validate examples/04-decision-council/council.mts
ensemble run examples/04-decision-council/council.mts \
  "Should a 5-person dev-tools startup build its own billing, or integrate Stripe?"
```

Watch the teams light up and the gate loop live:

```bash
ensemble serve examples/04-decision-council
```

Draw the graph without running it:

```bash
ensemble view examples/04-decision-council/council.mts            # terminal sketch
ensemble view examples/04-decision-council/council.mts --mermaid   # Mermaid source
```

---

## The casting

Money goes where judgement happens. The two **orchestration points** and the
**publisher** are `sonnet-5`; the parallel workers are the cheaper, faster models,
spread across three vendors so no single house style dominates a team.

| Role | Nodes | Model |
|---|---|---|
| Orchestrator / gate / publisher | `orchestrator`, `adjudicator`, `publisher` | `anthropic/claude-sonnet-5` |
| Bold / analysis writers | `option_a`, `prod_body` | `google/gemini-2.5-pro` |
| Market & feasibility recon | `recon_market`, `crit_feasibility` | `google/gemini-2.5-flash` |
| Safe / risk / technical | `option_b`, `crit_risk`, `recon_tech` | `deepseek/deepseek-v4-flash` |
| Everything else | recon/critic/production workers | `anthropic/claude-haiku-4.5` (default) |

---

## Cost & shape

One clean pass (gate passes first try) is **11 node runs**. Each REVISE loop adds the
three options nodes again plus the adjudicator, so a worst-case run — two full
loop-backs — is **19 node runs**. `maxLoops: 2` is the hard ceiling; the run always
terminates, either because the bar was cleared or the budget was spent, and proceeds
with the best option set it has. That's the same honest-gate behaviour as 02, scaled
from two nodes to four teams.
