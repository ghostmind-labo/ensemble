# 05 — Autoresearch

**Propose → measure → keep or revert → repeat, with an audit trail.**

[Karpathy's autoresearch](https://github.com/karpathy/autoresearch) as a scene. The
human sets up the environment — *what may change, how it is measured, how long a
try may take* — and the agent runs experiments inside those walls. Nothing here is a
special mode: it is a two-node loop, but the `research` block makes the engine enforce
the four rules that make such a loop trustworthy.

```
            ┌───────────────────────────────────────────────┐
            ▼                                               │
   ┌──────────────┐  hypothesis   ┌────────────────┐        │
   │   propose    │ ────────────► │   experiment   │ ── keep or revert ──┘
   │  agent node  │               │  🔬 runtime    │       iteration ≤ 6
   │ edits ONE    │ ◄──────────── │  measure.mjs   │
   │ file         │  best, verdict│  under budget  │
   └──────────────┘  reason, log  └────────────────┘
                                         │
                                         ▼
                                   results.tsv
```

| Rule | Where it is enforced |
|---|---|
| **One mutable artefact** | `research.edit` — agent nodes get `write_file` / `edit_file` that refuse every other path. Outside research mode agents have no write tools at all. |
| **Fixed budget per try** | `research.budget` — the measure command is killed (whole process group) at the limit; an overrun is a *crash*, not a longer experiment. |
| **Code-graded metric** | `research.metric` is parsed from the command's output. No model judges anything. |
| **Keep or revert, written down** | `runtime: "experiment"` snapshots the incumbent, keeps a candidate only if it beats it by more than `threshold`, restores it otherwise, and appends a line to `results.tsv` either way. |

## The pieces

- `heuristic.mjs` — the artefact. A spam classifier that starts at two keywords.
- `measure.mjs` — the metric. 24 labelled messages; prints `score: <accuracy>`.
- `research.mts` — the scene. The `research` block plus two nodes.
- `results.tsv` — written by the loop: `iteration  score  best  verdict  ms  note`.

## Run it

```bash
ensemble validate examples/05-autoresearch/research.mts
ensemble run examples/05-autoresearch/research.mts "maximise the score without overfitting to the data"
cat examples/05-autoresearch/results.tsv
```

From the repo root (the `edit`/`measure` paths are root-relative). Each iteration is
one agent call — a few cents with Sonnet. `git checkout examples/05-autoresearch/heuristic.mjs`
resets the artefact.

## What to look at in the output

Each experiment node prints its `summary`. The baseline is deterministic — the
starting heuristic scores **54.2** — and every later line has one of three shapes:

```
baseline 54.2 (0s)
keep · score 87.5 vs best 54.2
revert · score 83.3 vs best 87.5 — 83.3 did not beat 87.5 by more than 0
crash · score — vs best 87.5 — no "score" in the output (exit 1)
```

(The keep/revert/crash lines above show the format; the exact scores depend on what
the proposer tries. The loop itself is exercised end-to-end, offline, by
`test/research.test.mts` — baseline, keep, revert-on-worse, revert-on-tie, crash,
and the budget kill.)

**A revert is a result, not a failure.** The proposer sees `verdict`, `reason`, and
the measure output on its next turn, so a bad idea informs the next one instead of
being silently retried.

## Adapting it

Point `edit` at your `train.py`, `measure` at your training command, `metric` at
`val_bpb` with `minimize: true`, and `budget` at `"5m"` — that is the original
autoresearch, unchanged. Set `threshold` once you have seen your metric's run-to-run
spread; with a noisy metric and `threshold: 0` the loop will "discover" sampling luck.
