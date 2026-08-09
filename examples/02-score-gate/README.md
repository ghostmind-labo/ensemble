# 02 — Score Gate

**Only move forward when a measured value in state crosses a threshold.**

This is the LangGraph conditional-edge pattern, and the direct answer to "can we do
yes/no conditions and only advance when we reach something?" — with the condition as
real TypeScript over typed state, not a string in a config.

It is also the skeleton of the **auto-research / self-improvement loop**: run →
measure → if below target, mutate using the feedback → run again, on a budget.

---

## What it does

```
             ┌──────────┐   tagline    ┌─────────┐
  goal ────► │  writer  │ ───────────► │  judge  │ ──► exit
             │  haiku   │              │ sonnet  │
             └──────────┘              └────┬────┘
                  ▲                         │  score, feedback
                  │    score < 8  (⟲ max 3) │
                  └─────────────────────────┘
```

Two nodes, one gate:

```ts
edges: [
  { from: "writer", to: "judge" },
  { from: "judge", to: "writer", when: (s) => Number(s["score"]) < TARGET, maxLoops: 3 },
],
```

The three ideas this example exists to show:

1. **The gate is typed state, not vibes.** The judge must emit `score` as a number
   (the `Number()` guard also survives a model emitting `"7"`). The edge fires only
   while `score < 8`. Nothing advances because a model *felt* done.
2. **State is the feedback channel.** `writer` declares `inputs: ["feedback", "score"]`,
   so each revision sees exactly the judge's critique of its last attempt — and
   nothing else. That's the scoped-state model: who reads what is declared per node.
3. **`maxLoops` is the budget.** Self-improvement loops must terminate. After 3
   revisions the edge stops matching and the run proceeds with the best it has.

The asymmetric casting is deliberate: a cheap model (haiku) does the work, a strong
model (sonnet) holds the bar. The gate is where quality is enforced, so that's where
the money goes.

---

## How to test it

```bash
# from the repo root
ensemble validate examples/02-score-gate/gate.mts
ensemble run examples/02-score-gate/gate.mts \
  "a CLI tool that runs multi-model AI agent graphs from one TypeScript file"
```

Or watch the loop happen live: `ensemble serve examples/02-score-gate`.

---

## What actually happened when I ran it

```
▶ writer  … ok                          $0.0004 · 3.6s
  → judge
▶ judge   … ok                          $0.0036 · 6.3s
  → writer (Number(s["score"]) < TARGET)        ← gate fires: revise
▶ writer  … ok                                  ← revision 1, using feedback
  → judge
  → writer (Number(s["score"]) < TARGET)        ← still below bar
  …
  → writer (Number(s["score"]) < TARGET)        ← third and final loop
▶ judge   … ok
  judge→writer exhausted maxLoops, skipping     ← budget spent: proceed

done 8 node run(s) · $0.03
```

Final state: `score: 6.5`, tagline *"Define and run multi-agent AI workflows in
TypeScript—no YAML, no extra config files."*

Two things worth noticing in that log:

- **The writer visibly reacts to state.** Mid-run it reasons: *"The feedback is
  clear: the previous attempt was bloated and buried the real differentiator…"* —
  that text arrived via `inputs: ["feedback"]`, nowhere else.
- **The judge never capitulated.** It kept scoring below 8, the budget ran out, and
  the run ended *cleanly* with its best attempt and the final critique preserved in
  state. That's the honest outcome: a gate that always eventually passes isn't a
  gate. Raise `maxLoops`, use a stronger writer, or lower `TARGET` — all one-line
  changes, all visible in the scene file.

---

## Adapting it into a real auto-research loop

Replace the nodes, keep the shape:

| This example | Auto-research version |
|---|---|
| `writer` produces a tagline | a node produces a config / hypothesis / plan |
| `judge` scores 0-10 | an evaluator node runs the experiment (`runtime: "agent"` with tools) and emits a metric |
| `score < 8` | `s.metric < 9.1` — your target |
| `feedback` | what to change next recursion |
| `maxLoops: 3` | your compute budget |

The evaluator being an `agent` node matters: it can actually execute things (run a
script, call an MCP server, read results) and report the *measured* number back into
state — the loop then improves against reality, not against a model's opinion.

## Cost

~$0.03 for a full 4-iteration run with this casting. The judge (sonnet) is ~85% of it.
