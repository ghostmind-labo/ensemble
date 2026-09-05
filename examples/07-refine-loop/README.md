# 07 — Refine Loop

**Improve something until the score stops rising — and end with the best version,
not the last one.**

This is [02 — Score Gate](../02-score-gate) with the flaw fixed. That example's own
run log shows the problem: the judge never scored above the bar, the budget ran out,
and the run ended *cleanly* — with the **last** attempt (`score: 6.5`), not the best
one it had seen. And every revision there builds on the previous attempt, even when
the previous attempt was a regression.

The fix is the discipline research mode already uses for files, applied to a state
key: snapshot the incumbent, keep a candidate only if it beats it, restore it
otherwise. That is `runtime: "refine"`.

---

## What it does

```
   ┌──────────┐  tagline   ┌─────────┐  score, feedback  ┌────────────┐
   │  writer  │ ─────────► │  judge  │ ────────────────► │  keep  ⬆   │ ──► exit
   │  haiku   │            │ sonnet  │                   │ keep/revert│
   └──────────┘            └─────────┘                   └─────┬──────┘
        ▲                                                      │
        │      tagline (the INCUMBENT), best, verdict, reason  │ !converged
        └──────────────────────────────────────────────────────┘ (⟲ max 6)
```

Three nodes, and the third one is free:

```ts
keep: {
  runtime: "refine",
  candidate: "tagline",   // the state key under refinement
  patience: 2,            // two straight non-improvements → converged
  target: 9,              // or stop the moment best reaches 9
  outputs: ["tagline", "best", "verdict", "reason", "converged", "history"],
},
```

Each round, `keep` compares the judge's `score` with the best so far:

| verdict | what happens |
|---|---|
| `baseline` | first round: the candidate becomes the incumbent, nothing to beat |
| `keep` | the score beat `best` (by more than `threshold`, default 0): the candidate is the new incumbent |
| `revert` | it did not: the **incumbent is written back over `tagline`**, so the writer's next revision starts from the best version — never from the regression it just produced |

`converged` turns true after `patience` consecutive non-improvements, or as soon as
`best` reaches `target`. The edge `when: (s) => !s.converged` stops looping; `maxLoops`
is still there as the hard budget.

The four ideas this example exists to show:

1. **The run always ends with the best version in `tagline`.** Converged, target hit,
   or `maxLoops` spent — the refine node just wrote the incumbent there. A plain
   `score < N` gate cannot promise this.
2. **Every attempt is scored against the incumbent it was asked to improve.** A score
   that moves is attributable to the change that moved it. Drift is impossible.
3. **The writer is told the truth about what it sees.** On a revert, `tagline` is the
   best so far and `feedback` is about the attempt that was *discarded* — the prompt
   says so, and `verdict` / `reason` carry the numbers.
4. **Selection is free.** The refine node makes no model call. Money goes to the
   writer and the judge; deciding what survives costs nothing.

The asymmetric casting from 02 is kept on purpose: a cheap model (haiku) does the
work, a strong model (sonnet) holds the bar.

---

## Improve an input instead of generating one

"We have an input, and the output should be something improved." Declare the
candidate as a scene **input**, seed it at launch, and make the **judge** the entry so
the seed is scored as the baseline:

```ts
inputs: ["tagline"],   // arrives from outside
entry: "judge",        // score the seed first — that is the baseline
```

```bash
ensemble run examples/07-refine-loop/refine.mts "tighten it" --answer tagline="Run AI agent graphs from one file."
```

Because everything the refine node remembers lives on the blackboard (`incumbent`,
`best`, `stalled`, `history`), a loop survives `ensemble resume`, and a later run can be
seeded with an earlier run's winner — signal passing between runs, with no new
machinery.

---

## How to test it

```bash
# from the repo root — both free
ensemble validate examples/07-refine-loop/refine.mts
ensemble view examples/07-refine-loop/refine.mts        # the ⬆ node shows in ← tagline, score

# then, for real (see Cost)
ensemble run examples/07-refine-loop/refine.mts \
  "a CLI tool that runs multi-model AI agent graphs from one TypeScript file" --budget 0.10
```

`validate` proves the wiring before anything spends: `tagline` must be produced by a
node *other* than `keep` (the refine node only writes it back), `score` must be
produced by some node, and both appear on the data graph as `keep`'s reads —
`ensemble serve` draws them dotted. A judge that emits `"7/10"` instead of a number
is caught by the `state` schema and retried; if it still is not a number, the round
fails naming the one-line fix.

The mechanics are also exercised end-to-end, model-free, in
[`test/refine.test.mts`](../../test/refine.test.mts) — scripted scores through the real
engine, including the plateau, the target, `maxLoops` running out, a seeded input,
and a stop/resume.

---

## What actually happened when I ran it

Goal: *"a CLI tool that runs multi-model AI agent graphs from one TypeScript file"*.
Six rounds, then convergence — condensed to the lines that matter:

```
▶ writer   "Orchestrate complex AI workflows with multiple models in a single TypeScript file."
▶ judge    score 6.5  — "reads more like a feature description than a tagline"
▶ keep     baseline · 6.5

▶ writer   "Multi-model agent graphs, one TypeScript file."
▶ judge    score 7    — "clean and rhythmic … but a noun phrase with no verb"
▶ keep     keep · 7 beat the incumbent's 6.5

▶ writer   "Run multi-model agent graphs from one TypeScript file."
▶ judge    score 6    — "a restatement of the goal with zero added value"
▶ keep     revert · 6 did not beat the incumbent's 7          ← tagline restored

▶ writer   "Orchestrate multi-model AI agents in one TypeScript file, no boilerplate."
▶ judge    score 7.5  — "'no boilerplate' is slightly generic SaaS filler"
▶ keep     keep · 7.5 beat the incumbent's 7

▶ writer   "Orchestrate multi-model AI agent graphs from the command line, all in one TypeScript file."
▶ judge    score 7    — "two clauses stapled together with a comma"
▶ keep     revert · 7 did not beat the incumbent's 7.5        ← restored again

▶ writer   "Define AI agent workflows in TypeScript, run them anywhere."
▶ judge    score 5    — "loses the two things that make this tool distinctive"
▶ keep     revert · 5 did not beat the incumbent's 7.5 — converged: no improvement in 2 rounds

done 18 node run(s) · $0.05 of $0.1 budget

cost by node
  judge     $0.04   84%  6 run(s)
  writer  $0.0075   16%  6 run(s)
  keep         $0    0%  6 run(s)

Result
Orchestrate multi-model AI agents in one TypeScript file, no boilerplate.
```

Final state: `best: 7.5`, `tagline` = the round-4 version, `history` = six entries with
verdicts `baseline, keep, revert, keep, revert, revert`.

Three things worth noticing:

- **The run ended with the best attempt, not the last.** The last thing the writer
  produced scored **5** — the worst of the run. A `score < 8, maxLoops` gate would have
  shipped it. Here `keep` restored the 7.5 version before the exit.
- **Reverts are visible and reasoned.** Every restore printed why (`7 did not beat the
  incumbent's 7.5`), and on the next round the writer's context held the incumbent
  plus the critique of the discarded attempt — you can see it reasoning from both.
- **`patience: 2` was the right setting against real judge noise.** Sonnet's scores
  for near-equivalent taglines wandered by ±0.5; one bad round (round 3) was not
  enough to stop, and the loop found its best on round 4. Two in a row was.

One thing to tune: the writer (haiku) narrates before its json block on every round —
the `! kept only 59 of 649 chars` warnings. Harmless here (the tagline is short), but
the skill's advice applies: restate the output contract at the END of the prompt.

## Cost

$0.05 for six rounds; the judge (sonnet) is 84% of it, the refine node is $0. A loop
that converges earlier costs proportionally less; `maxLoops: 6` caps it around $0.06.
