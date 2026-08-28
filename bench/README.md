# bench — autoresearch for the agent scaffolding

> Since 0.20 this loop is a built-in scene pattern: a `research` block plus
> `runtime: "experiment"` (see the root README, "Research mode", and
> `examples/05-autoresearch`). This directory predates it and stays as the
> hand-rolled reference — it optimises ensemble's own agent prompt, with its own
> code-graded benchmark — but a new loop should be written as a scene.

An implementation of [Karpathy's autoresearch](https://github.com/karpathy/autoresearch)
pattern — propose, measure, **keep or revert**, repeat, with an audit trail —
pointed at the one part of ensemble that is prompt-engineering rather than code:
**the operating instructions every `runtime: "agent"` node receives.**

```
                 ┌──────────────────────────────────────┐
                 ▼                                      │
   propose a variant ──► measure (N sweeps) ──► beat incumbent
   (strong model, sees          │                by > noise floor?
    failures + stats)           │                   │        │
                                │                  yes      no
                                │                   │        │
                                └───────────────────┘   revert, tell
                                    new incumbent       proposer why
```

| Piece | What it is |
|---|---|
| `tasks.mts` | 12 benchmark tasks, **all graded programmatically** |
| `fixture/` | A tiny fake project with known ground truth |
| `run.mts` | Scores one candidate prompt |
| `optimize.mts` | The loop |
| `prompts/baseline.md` | The incumbent (mirrors the block in `src/runtimes/agent.ts`) |
| `prompts/best.md` | Written only when something genuinely wins |
| `checker.test.mts` | Unit tests for the graders — run before trusting any result |
| `log.jsonl` | Audit trail — every proposal, its score, and the keep/revert decision |

## Running it

```bash
node bench/checker.test.mts                 # FIRST — is the metric itself sound?
node bench/run.mts                          # score the built-in prompt
node bench/run.mts bench/prompts/best.md    # score a candidate
node bench/run.mts --repeat=3               # average 3 sweeps (recommended)

node bench/optimize.mts --iterations=5 --repeat=3
```

Cost: one sweep is ~$0.06. An optimize run is roughly
`(iterations + 1) × repeat × $0.06` — about **$1 for the default 5×3**.

`BENCH_MODEL` sets the model under test (default `claude-haiku-4.5` — deliberately
mid-tier, so the scaffolding has to do real work). `OPTIMIZER_MODEL` sets the
proposer (default `claude-sonnet-5`).

## The objective

```
objective = passes × 100 − total turns
```

Correctness dominates; efficiency breaks ties. A prompt that trades a correct
answer for speed always loses; among equally-correct prompts, the one that gets
there in fewer turns wins. That matters because turns are the real cost driver —
every prior tool result is resent on each one.

## Two design decisions that make this trustworthy

**Every task is graded by code, never by a model judge.** A judge adds its own
variance to the metric, and an optimiser cannot tell "the prompt improved" from
"the judge felt different today".

Getting this right took three attempts, and the failures are instructive. An early
checker marked a *correct* answer wrong because the model wrote "does not
**actually** mention" and the needle was `"does not mention"`. The fix — a regex —
then failed on "the file … does not exist" because it only looked for negation
*before* the subject. The working version is a proximity check: find the subject,
look for any negation word within 90 characters either side. There are unit tests
over the exact strings that were misgraded, because **a metric that punishes
correct answers teaches the optimiser to fix things that were never broken.**

**Nothing is believed without clearing the noise floor.** The same prompt scored
9/12 and 12/12 on consecutive sweeps. So every measurement averages N sweeps, and
a candidate must beat the incumbent by **more than ~1 score point (100 objective)**
to be accepted. Ties revert. Without this the loop reliably "discovers"
improvements that are pure sampling luck.

## Promoting a winner

`optimize.mts` never edits source. If a variant wins it lands in
`prompts/best.md`, and promotion is a deliberate human step: replace the block in
`buildSystem()` in `src/runtimes/agent.ts`, then re-run the benchmark against the
built-in to confirm parity.

For testing a candidate without touching source at all:

```bash
ENSEMBLE_AGENT_PROMPT=bench/prompts/best.md ensemble run my.mts "goal"
```

That env var is also the supported way for a user to specialise agent behaviour
per project.

## First run: the baseline held

Four iterations, `--repeat=3`, proposer `claude-sonnet-5`:

```
baseline         score 12.00/12   obj 1167.3   spread 0
iter 1  revert   score 11.67/12   obj 1132.0   Δ-35.3
iter 2  revert   score 11.33/12   obj 1098.7   Δ-68.7
iter 3  revert   score 12.00/12   obj 1168.3   Δ+1.0     ← inside the noise floor
iter 4  revert   score 12.00/12   obj 1166.3   Δ-1.0

done — 0 accepted of 4
```

**Zero accepted is a real result, not a broken loop.** Two candidates measurably
*hurt* correctness (the loop caught it and reverted). Iteration 3 came in one turn
ahead — which looks like a win and is exactly the trap the threshold exists for:
+1.0 objective is noise, and accepting it would have replaced a known-good prompt
with a coin flip.

The honest reading is that **the benchmark has saturated at 12/12** and the
remaining signal (turns) is smaller than the run-to-run variance. To get further:
add harder tasks, raise `--repeat` to shrink the noise floor, or point
`BENCH_MODEL` at a weaker model to open correctness headroom.

## Adding tasks

Add to `TASKS` in `tasks.mts`. A good task is **programmatically checkable** and
probes a behaviour rather than a fact — error recovery, refusing to fabricate,
chaining two reads, restraint when no tool is needed. If correctness saturates at
12/12, the objective still has room via turns; add harder tasks when it stops
discriminating.
