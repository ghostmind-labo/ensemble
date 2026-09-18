---
name: ensemble-runs
description: Read, debug and tune ensemble runners from what they actually did. Covers reading run.json and graph.json, explaining why a run took a path, diagnosing a failed, budget or maxSteps run, summarising many runs (hot paths, gate fire rates, low-confidence decisions, cost), and calibrating gate and threshold values against a labelled set. Use this whenever there is a .ensemble/runs directory, a run.json or graph.json to explain, a runner that misroutes or escalates too often, a cost or latency question about a runner, or a request to evaluate, calibrate, benchmark or improve an ensemble / Jev decision graph.
---

# Reading and tuning ensemble runs

A runner emits two documents, and together they record everything that happened:

- **`graph.json`** is what *could* happen: every node, every edge with a stable
  id, every declared option. Emit it with `npx ensemble graph <file>`. It's free.
- **`run.json`** is what *did* happen: each step, the full answer distribution
  of every decision, cost, timing and the edge taken. `npx ensemble run` writes
  both to `.ensemble/runs/<id>/`.

**The join is one field.** `steps[].took` is an id from `graph.edges[].id`
(`"e3"`), or `"gate"` when a confidence gate diverted the run, or `null` at the
exit. `run.graph` is the graph's hash, so runs of different graph versions can
be told apart.

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

Write a small harness next to the runner that calls the runner as a function:

```ts
// calibrate.mts — node calibrate.mts
import triage from "./triage.mts";
import cases from "./labelled.json" with { type: "json" };  // [{ goal, expected }]

const rows = [];
for (const c of cases) {
  const { run } = await triage({ goal: c.goal }, { budget: 0.01 });
  const step = run.steps.find((s) => s.node === "classify")!;
  const a = step.answers!.team!;
  rows.push({ goal: c.goal, expected: c.expected, got: a.value, confidence: a.confidence, ok: a.value === c.expected });
}
// Accuracy by confidence bucket: where does being wrong become rare?
for (const lo of [0, 0.5, 0.6, 0.7, 0.8, 0.9]) {
  const b = rows.filter((r) => r.confidence! >= lo);
  console.log(`conf ≥ ${lo}: ${b.length} cases, ${(100 * b.filter((r) => r.ok).length / (b.length || 1)).toFixed(1)}% right`);
}
```

Set `gate.min` at the lowest confidence where accuracy is acceptable for what a
wrong route costs. Every case below it goes to the safe path. Do the same for
noul thresholds (sweep the cut-off and count false positives against false
negatives) and for score cut-offs in `when:`.

To iterate on question wording without paying twice for the same inputs, wrap
the decider in a cache keyed on `JSON.stringify([state, questions])`. Pass it as
`{ decider }` and wrap the default `jev()`. Only changed questions cost anything.

After changing a question, re-emit `graph.json`. The hash changes, and
`summarize --graph` keeps old and new runs apart.

## Building on the event stream

For a live view, don't add one to the library. Consume the stream:
`await runner(inputs, { onEvent })`, which delivers `node:start`, `node:end`
(with the full step) and `run:end` (with the run document). The two JSON documents
and those three events are the whole integration surface, and every dashboard,
log shipper and TUI builds on them.
