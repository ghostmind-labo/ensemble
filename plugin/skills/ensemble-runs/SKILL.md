---
name: ensemble-runs
description: Read, debug and tune ensemble runners from what they actually did. Covers reading run.json and graph.json, explaining why a run took a path, diagnosing a failed, budget or maxSteps run, summarising many runs (hot paths, gate fire rates, low-confidence decisions, cost), calibrating gate and threshold values against a labelled set with `ensemble calibrate`, and reading a supervised loop's journal (pulse, checkpoint, alerts, vitals). Use this whenever there is a .ensemble/runs directory, a run.json or graph.json to explain, a runner that misroutes or escalates too often, a cost or latency question about a runner, or a request to evaluate, calibrate, benchmark or improve an ensemble / Jev decision graph.
---

# Reading and tuning ensemble runs

A runner emits two documents, and together they record everything that happened:

- **`graph.json`** is what *could* happen: every node, every edge with a stable
  id, every declared option. Emit it with `npm run graph -- <file>`. It's free.
- **`run.json`** is what *did* happen: each step, the full answer distribution
  of every decision, cost, timing and the edge taken. `npx ensemble run` writes
  both to `.ensemble/runs/<id>/`.

**The join is one field.** `steps[].took` is an id from `graph.edges[].id`
(`"e3"`), or `"gate"` when a confidence gate diverted the run, or `null` at the
exit. `run.graph` is the graph's hash, so runs of different graph versions can
be told apart.

## What a step carries

Every `steps[]` entry has `lane` (`main`, a forking edge id, or a join node's
name), `started`/`ended`, `asked` (the state the node was given, per its
declared reads), `writes`, `took` (the edge it continued on, `"gate"`, or null)
and, on a fork step, `forked` (the edge ids that fired). `asked` is the field
that answers "what did it know at the time"; for a decide node it is exactly
what Jev saw. Parallel steps overlap in time, so sort by `started`, not `n`,
when laying out a timeline.

## Answering "why did it do that?"

```sh
R=.ensemble/runs/<id>/run.json
jq '.run | {status, cost: .cost.total, goal}' $R
jq -r '.steps[] | "\(.n) \(.node) [\(.kind)] took=\(.took) \(.ms)ms $\(.cost)"' $R
jq '.steps[] | select(.answers) | {node, answers, gate}' $R    # every decision, with its distribution
jq '.steps[] | select(.error) | {node, error}' $R
```

To explain a branch, read the answer and then the edge. Map `took` back to its
condition with
`jq '.edges[] | select(.id=="e3")' .ensemble/runs/<id>/graph.json`.
Then say it plainly: "`classify` answered `team=orders` at 0.62; the gate is at
0.7, so it escalated."

Edges from a node are tried **in declaration order**, and the first match wins.
When a run took an unexpected edge, check whether an earlier edge (a safety
noul, a `when:`) matched first. That's usually the explanation.

## Diagnosing a stopped run

`run.status` is one of:

| status | Meaning | Look at |
|---|---|---|
| `completed` | Reached a node with no matching outgoing edge | `result` should hold the answer. If it's `undefined`, the exit node never wrote the `result` key |
| `failed` | A node threw | the step with `error`. A handler bug, an HTTP error from Jev or OpenRouter, an mcp error, or a writes-shape mismatch (`returned no …`) |
| `budget` | Cost passed `--budget` | Which step was expensive. Usually a model node, and image models bill output as tokens |
| `maxSteps` | Hit the step cap (default 50) | A loop without `maxLoops`, or a `when:` that never flips |
| `cancelled` | The signal aborted | the caller |

Reproduce a failing path for $0 with the `ensemble-build` dry-run, forcing the
same answers:
`node <ensemble-build>/scripts/dryrun.mts <file> "<goal>" --answer node.key=value@conf`.

## Summarising many runs

```sh
node <this-skill-dir>/scripts/summarize.mts .ensemble/runs --runner <name>
```

This prints the hot paths, edge counts, each question's answer distribution and
mean confidence, how often each gate fires, the least confident decisions (with
their goals), failures, and the slowest nodes. Add `--graph sha256:…` to compare
only runs of one graph version, and `--json` for a machine-readable output.

What to do with what it shows:

- **A gate fires a lot** (say over 30%). Either the options are blurry (sharpen
  `not_for`, add boundary `examples`, or split the question), or the traffic
  really is ambiguous and the gate is doing its job. Read the goals in the
  least-confident list before lowering `min`.
- **One option almost never wins**, or always wins. It may be mis-described, or
  it may belong in a staged classification.
- **A noul sits near 0.5.** The question is unclear or asks two things, so split
  it.
- **An edge is never taken** across many real runs. It's either dead or shadowed
  by an earlier edge.
- **Cost is dominated by one node.** It's almost always a model node. Check
  whether a smaller model, a lower `maxTokens`, or a decide step in front of it
  (to skip it when it isn't needed) would do.

## Calibrating thresholds

Starting thresholds are guesses. Calibrate against a **labelled set**: 30–200
realistic inputs with the answer a good human would give. This costs money (a
decide step is about $0.00002 and a model node more), so do it only when asked,
and cap it.

Write the cases as JSONL, one per line. Each gives the state the decide node
reads and the right answer per question (`node.key` or a bare key; a choice
takes an option name, a noul `true`/`false`, a score its 0-based level):

```jsonl
{"inputs":{"goal":"I was charged twice"},"expect":{"route":"billing"}}
{"inputs":{"goal":"parcel is two weeks late","plan":"vip"},"expect":{"route":"orders","screen.urgent":true}}
```

```sh
npm run calibrate -- runners/triage.mts cases.jsonl --holdout held.jsonl --budget 0.05
```

Split them: `set: "dev"` cases (the default) are what you tune the wording
against, `set: "holdout"` cases are read once, after freezing. The report scores
them apart and prints the drop between them — 0.1 or more means the questions
have been fitted to the dev cases rather than to the job.

It tests each decide node in isolation (no handlers, no model calls), refuses a
malformed case set before spending anything, and prints per question: accuracy,
mean confidence, the calibration **gap** (near 0 means confidence can be
trusted), the misses, and a price for every gate:

```
  route.team  choice · n=120 · right 91.7% · confidence 0.88 · gap 0.031
    gate min 0.7 → keeps 93.3%, 96.4% of those right
    gate min 0.8 → keeps 85.0%, 98.0% of those right
```

`--json` gives the full report, and `calibrate()` is the same thing as a function.

Set `gate.min` at the lowest confidence where accuracy is acceptable for what a
wrong route costs. Every case below it goes to the safe path. Do the same for
noul thresholds (sweep the cut-off and count false positives against false
negatives) and for score cut-offs in `when:`.

To iterate on question wording without paying twice for the same inputs, wrap
the decider in a cache keyed on `JSON.stringify([state, questions])`. Pass it as
`{ decider }` and wrap the default `jev()`. Only changed questions cost anything.

After changing a question, re-emit `graph.json`. The hash changes, and
`summarize --graph` keeps old and new runs apart.

## Reading a supervised loop

A runner run by `supervise()` leaves a journal directory, not a single run.json:

- `pulse.json` is rewritten on every node event. If its `at` is old, the process
  is stuck or dead. Check this first.
- `checkpoint.json` holds `tick`, `spent`, `memory`, the last-24h `ledger` and
  the `recent` window. A restart resumes from it.
- `journal.jsonl` has one JSON object per line, by `type`: `step` (as each node
  finished), `run` (a whole run.json per tick), `watched` (the watcher's run),
  and `start`, `tick`, `rest`, `watch`, `alert`, `stop`, `error`.

```sh
jq -c 'select(.type=="alert" or .type=="stop")' .ensemble/live/journal.jsonl     # what went wrong
jq -c 'select(.type=="watch") | {tick, verdict, reason, f: .vitals.failureRate, g: .vitals.gateRate}' .ensemble/live/journal.jsonl
jq -c 'select(.type=="run") | .run' .ensemble/live/journal.jsonl > runs.jsonl    # feed to summarize.mts
```

A rising `gateRate` means the decider is unsure more often, because the inputs
drifted from what the questions were written for. Calibrate again on recent
inputs. `sameness` near 1 on work that should vary means it is stuck.

## Building on the event stream

For a live view, don't add one to the library. Consume the stream:
`await runner(inputs, { onEvent })`, which delivers `node:start`, `node:end`
(with the full step) and `run:end` (with the run document). The two JSON documents
and those three events are the whole integration surface, and every dashboard,
log shipper and TUI builds on them.
