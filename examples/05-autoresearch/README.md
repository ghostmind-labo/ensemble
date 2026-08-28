# 05 — Autoresearch

**Propose → measure → keep or revert → repeat, with an audit trail.**

[Karpathy's autoresearch](https://github.com/karpathy/autoresearch) as a sealed mode.
The human sets up the environment — *what may change, how it is scored, what to aim
for* — and the agent runs experiments inside those walls.

**The program is three keys and nothing else.** No nodes, no edges, no entry, no
model, no prompts: `research()` refuses them all by name. The loop only means
something if the artefact is the only thing that varies, so every other knob is a
confound and the mode removes it rather than trusting you not to turn it.

```ts
export default research({
  modify:      "heuristic.mjs",                    // 1 · what may change
  evaluate:    { command: "node measure.mjs",      // 2 · how it is scored
                 metric: "score", budget: "30s" },
  instruction: "Raise accuracy. Generalisable signals only…",   // 3 · the directive
});
```

The generated loop, identical for every program:

```
            ┌───────────────────────────────────────────────┐
            ▼                                               │
   ┌──────────────┐  hypothesis   ┌────────────────┐        │
   │   propose    │ ────────────► │    evaluate    │ ── keep or revert ──┘
   │  agent node  │               │  🔬 experiment │      --iterations
   │ edits ONE    │ ◄──────────── │  under budget  │
   │ file         │  best, verdict│                │
   └──────────────┘  reason, log  └────────────────┘
                                         │
                                         ▼
                                   results.tsv
```

Entry is **evaluate**, not propose: the first pass measures whatever is already on
disk, and that baseline is what every later candidate is compared against.

| Rule | Where it is enforced |
|---|---|
| **One mutable artefact** | `modify` — the proposer's write tools refuse every other path. Outside research mode agents have no write tools at all. |
| **Fixed budget per try** | `evaluate.budget` — the command is killed (whole process group) at the limit; an overrun is a *crash*, not a longer experiment. |
| **Code-graded metric** | `evaluate.metric` is parsed from the command's output. No model judges anything, and the proposer cannot edit the scorer. |
| **A constant directive** | `instruction` is inlined verbatim on every iteration, and `ensemble research` takes no goal argument — there is nowhere for it to drift. |
| **Keep or revert, written down** | The evaluate node snapshots the incumbent, keeps a candidate only if it beats it by more than `--threshold`, restores it otherwise, and appends a line to `results.tsv` either way. |

## The pieces

- `heuristic.mjs` — the artefact. A spam classifier that starts at two keywords.
- `measure.mjs` — the scorer. 24 labelled messages; prints `score: <accuracy>`.
- `research.mts` — the program. Three keys.
- `results.tsv` — written by the loop: `iteration  score  best  verdict  ms  note`.

## Run it

```bash
ensemble validate examples/05-autoresearch/research.mts        # free
ensemble research examples/05-autoresearch/research.mts --iterations 6
cat examples/05-autoresearch/results.tsv
```

From the repo root (the paths in the program are root-relative). **`research` takes no
goal** — the directive is in the file. Each iteration is one agent call, a few cents
with Sonnet; `--model` picks a different proposer, `--threshold` raises the bar a
change must clear. `git checkout examples/05-autoresearch/heuristic.mjs` resets the
artefact between sessions.

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

```ts
export default research({
  modify:      "train.py",
  evaluate:    { command: "python train.py", metric: "val_bpb", minimize: true, budget: "5m" },
  instruction: "Lower validation bits-per-byte. Do not change the data or the eval.",
});
```

That is the original autoresearch, unchanged. Raise `--threshold` once you have seen
your metric's run-to-run spread — with a noisy metric and a zero threshold the loop
will "discover" sampling luck and keep it.

## When you need more than three things

`research()` is deliberately sealed. If your loop genuinely needs a different shape —
a jury of proposers, a human `ask` gate before each experiment, a second metric — drop
to an ordinary `scene()` with a `research:` block and `runtime: "experiment"`, which is
the same machinery with the guardrails off. Reach for it when the sealed mode cannot
express the experiment, not to avoid the constraint.
