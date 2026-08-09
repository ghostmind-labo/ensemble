# 01 — Model Jury

**Ask three vendors the same question independently, then have a foreman synthesise one answer.**

This is the first example because it does the one thing no other agent runner can:
run **three different vendors' models inside a single graph**, concurrently, and
combine their answers. LangGraph, CrewAI, and Claude Code's own workflow tools all
assume one provider.

---

## What it does

```
                    goal
                      │
        ┌─────────────┼─────────────┐        all three run at once,
        ▼             ▼             ▼        none can see the others
   ┌─────────┐  ┌──────────┐  ┌──────────┐
   │anthropic│  │  google  │  │ deepseek │
   │sonnet-5 │  │gemini-2.5│  │ v4-flash │
   └────┬────┘  └────┬─────┘  └────┬─────┘
        └────────────┼─────────────┘
                     ▼
              ┌─────────────┐
              │   foreman   │  consensus · dissent · strongest · answer
              └─────────────┘
```

The jurors deliberately have **no `inputs`**. They see only the goal, so none can be
anchored by another's reasoning — that independence is what makes the comparison
worth anything. The foreman is the only node that sees all three.

## Files

| File | What it is |
|---|---|
| `jury.ts` | The scene — 4 nodes, 1 parallel group, 1 edge. Every node is `runtime: "model"` (a direct OpenRouter call), so **no opencode server is spawned at all** — and every juror streams its tokens live in `ensemble serve` |

---

## How to test it

Run it **from the repo root**, not from inside this folder:

```bash
# from the graph repo root
ensemble validate examples/01-model-jury/jury.ts   # free — catches typos first
ensemble view     examples/01-model-jury/jury.ts   # draw the topology
ensemble run      examples/01-model-jury/jury.ts \
  "Should a two-person startup write their own auth, or use a hosted provider?"
```

Prefer to watch it happen:

```bash
ensemble serve examples/01-model-jury    # opens a browser; nodes light up as they run
```

> **Why from the root?** opencode treats your working directory as the project root
> and installs ~61 MB of its own `node_modules` there. `cd`-ing into each example
> gives every one of them its own copy. Running from the root keeps a single shared
> one. Both work — this is disk, not correctness. (opencode gitignores it itself.)

### First, check your setup

```bash
ensemble skills     # should list your skills; this example needs none
ensemble models openrouter/deepseek   # confirm the models resolve
```

If a model 404s, swap it in `jury.ts` for anything from `ensemble models`.

---

## What actually happened when I ran it

Goal: *"Should a two-person startup write their own auth, or use a hosted provider like Clerk or Auth0?"*

```
┏ group jury (3 in parallel)
└─ ok openrouter/anthropic/claude-sonnet-5   ·   2→511 tok · $0.02  · 10.1s
└─ ok openrouter/deepseek/deepseek-v4-flash  · 410→261 tok · $0.0003 · 18.2s
└─ ok openrouter/google/gemini-2.5-pro       ·1531→418 tok · $0.01  · 28.4s
  → foreman
└─ ok openrouter/anthropic/claude-sonnet-5   ·   2→1958 tok · $0.04 · 23.2s

done 4 node run(s) · $0.08
```

**Total wall clock: 52.8s.** Note what that proves — the three jurors took 10.1s,
18.2s and 28.4s, summing to 56.7s if they had run one after another. The group
finished in ~28s, the time of the *slowest* juror. They genuinely ran concurrently.

### The interesting part

The foreman picked **`strongest: "deepseek"`** — the cheapest juror on the panel, at
`$0.0003`, roughly **1/60th** the cost of the Anthropic juror that lost to it. On this
question it contributed the most new material: the compliance angle (SOC 2, GDPR,
breach notification) and a concrete cost anchor that neither of the others raised.

That is the argument for this tool in one line: **the best model for a given question
is not knowable in advance, and it is often not the expensive one.**

The foreman also declined to manufacture a fight:

> *"No genuine disagreement — all three jurors reached the identical recommendation
> and flagged the identical primary risk. Differences are only in depth and framing."*

That's the `dissent` prompt doing its job. A panel that always reports conflict is
useless; the instruction says explicitly *do not invent conflict*.

### A retry happened, and that's fine

```
warn juror_deepseek: no JSON block found. … — reprompting once
```

DeepSeek answered in prose and skipped the required JSON block. The engine reprompted
it **once, in the same session**, so the model saw its own failed attempt, and it
complied. This is the `outputs` contract enforcing itself — worth seeing in the wild.
Two failures in a row would fail the run loudly rather than silently continuing.

---

## Reading the output

The run writes `.ensemble/runs/<timestamp>-model-jury/`:

- **`state.json`** — every key: the three raw answers plus the foreman's four outputs
- **`result.md`** — the same, rendered as markdown

```bash
cat .ensemble/runs/*/result.md
python3 -c "import json,glob;print(json.load(open(sorted(glob.glob('.ensemble/runs/*/state.json'))[-1]))['strongest'])"
```

The terminal prints `answer` at the end because it's the exit node's first declared
output. The other three keys are there when you want to audit *how* it got there.

---

## Things worth trying

| Change | What it shows |
|---|---|
| Add a fourth juror on another vendor | Groups scale — wall clock stays at the slowest member |
| Give one juror a skill: `skills: [ytx]` | Per-node scoping; the others still can't touch it |
| Swap `foreman` to `openrouter/anthropic/claude-opus-5` | Better synthesis, ~3× the foreman cost |
| Make every juror the *same* model | A control run — how much of the value is model diversity vs. just sampling three times? |
| Ask something genuinely contested | "Is TDD worth it for a solo dev?" — `dissent` gets far more interesting than it does here |

To make the jurors cheaper across the board, set `defaults.model` to a small model
and only override `foreman`.

---

## Cost

**~$0.08 per run** with the models as shipped. Roughly half of that is the foreman,
because it reads all three answers and writes the longest output.

Cheap variant — swap the two expensive jurors for flash-tier models and it drops to
around a cent. `ensemble validate` is always free, so iterate on structure before you
ever spend anything.

---

## Why this shape

A single model answering alone has no way to tell you which of its claims are
load-bearing and which are habit. Three models from different labs, trained on
different data with different tuning, disagreeing in the open, gives you something a
single answer cannot: **a signal about which parts are actually robust.**

When all three converge — as they did here — that agreement means something.
When they split, the `dissent` field is where the real information is.
