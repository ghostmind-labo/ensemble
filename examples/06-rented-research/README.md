# 06 — A research loop with a rented proposer

A Karpathy-style experiment loop where the thing proposing changes is
**opencode**, a real coding-agent CLI, rather than ensemble's own agent loop.

```bash
# from the REPO ROOT, not this folder
ensemble run examples/06-rented-research/research.mts "Improve the CSV parser" --budget 0.25
```

Needs `opencode` on PATH (`brew install sst/tap/opencode`). It reads the same
`OPENROUTER_API_KEY` ensemble uses — there is nothing else to configure, and
`ensemble validate` says so for free if the binary is missing.

## The three files

| file | role |
|---|---|
| `parser.mjs` | **the artefact** — the one file the loop may change |
| `measure.mjs` | **the scorer** — code, not a model, and outside the artefact |
| `research.mts` | **the loop** — the scene that ties them together |

`parser.mjs` starts as `line.split(",")`. That is deliberate: it knows nothing
about quoting, so it scores **42.9%** and there is real room to improve.

`measure.mjs` runs 21 RFC-4180 cases the artefact cannot see — quoted fields,
commas inside quotes, doubled `""` escapes, empty fields, significant
whitespace — and prints `score: <percent>` last. It is deterministic, so
iteration 1 and iteration 20 are directly comparable. That comparability is the
whole reason the ledger means anything.

## Why this is a scene and not `research({...})`

Example 05 uses the **sealed mode**, which is the right default. But the sealed
mode always proposes with `runtime: "agent"` — our own loop — and here we want
opencode to do the editing. So this drops to the documented **escape hatch**: an
ordinary `scene()` with a scene-level `research:` block and
`runtime: "experiment"`. Same measure / keep-or-revert machinery, proposer left
open.

Use the sealed mode unless you need exactly this. The guardrails are the point.

## The safety boundary is `dir`

A backend node writes with **opencode's** tools, not ensemble's. Research mode's
artefact-scoped `write_file`/`edit_file` and its withdrawal of `bash` apply to
`runtime: "agent"` nodes — they do not reach inside a subprocess.

So the boundary here is `dir: HERE`, which becomes opencode's `--dir` and its
project root. Point it at the repo root and it could edit anything, including
its own scorer. If you rent a proposer, `dir` is the thing keeping it honest.

## What a real run looks like

An actual run of this example, verbatim from `results.tsv`:

```
iteration  score  best   verdict   note
1          42.9   42.9   baseline
2          100    100    keep      "replaced the naive split with a single-pass state machine…"
3          100    100    revert    "added CR/CRLF handling… should score strictly better"
4          100    100    revert    "behaviorally identical for all valid RFC-4180 input…"
5          100    100    revert    "added null/undefined and BOM guards…"
```

`done 9 node run(s) · $0.01` — four opencode calls at ~$0.0036 each, and five
experiment nodes at exactly $0, because measuring is code.

Two things worth noticing.

**Iteration 2 is the loop working.** opencode read the file, wrote a proper
RFC-4180 state machine, and the score went 42.9 → 100. The artefact on disk is
now that version, because keep-or-revert always leaves the best measured result
in place.

**Iterations 3-5 are the loop working too.** Each added something plausible —
CRLF handling, a refactor, null and BOM guards — and each predicted an
improvement. None moved the number, and **a tie always reverts**, so all three
were thrown away. Three confidently-worded claims, all unsupported, all caught.
That is precisely why a code-graded number sits between the proposal and the
artefact: an agent's belief about its own change is not evidence.

It also shows the honest limit of the method. Once the artefact saturates the
metric, the loop has nothing left to find and will keep spending to discover
that. A run that reverts everything after iteration 2 is telling you the
experiment is over, not that the agent is failing.

## What it costs

The propose node burned **79,511 input tokens across 4 calls** — about 20k per
call for a prompt of a few hundred words. That is opencode's own system prompt,
tool schemas and personality, paid on every iteration. It is the concrete reason
a rented proposer is a per-node choice: our own `runtime: "agent"` would have
done the same job for a fraction of the input, with the trade-off that it brings
a smaller editing loop.

## Resetting it

The loop leaves the winning version on disk, so a second run starts from 100 and
has nothing to do. To run it again from scratch:

```bash
git checkout examples/06-rented-research/parser.mjs
rm -f examples/06-rented-research/results.tsv
```
