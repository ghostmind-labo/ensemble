# Reading results.tsv

One row per iteration: score, verdict (`baseline` / `keep` / `revert`), and the
agent's note. This is what you read in the morning, and the shapes it makes are
diagnostic.

## Healthy

Early keeps, then keeps get rarer and smaller. That is search working: the cheap
wins go first. A run that is still finding large gains at iteration 40 usually
means the baseline was badly under-tuned, not that the loop is brilliant.

## Everything reverts

Nothing was kept after the baseline. In order of likelihood:

1. **Threshold too high** — real gains are below the noise floor you set.
2. **The instruction is too vague** — the agent has no idea what to try, so it
   tries scattered things.
3. **The metric is too coarse** — a pass/fail or a heavily rounded number cannot
   register incremental progress.
4. **The artefact is already near a local optimum** — a genuine, legitimate
   result. Say so rather than chasing it.

## Keep / revert / keep / revert on similar scores

Thrash. The loop is measuring noise, not change. Make the evaluator deterministic,
or raise `--threshold` above the measured noise floor. Establish that floor by
running the baseline unchanged a few times and looking at the spread.

## A large jump, then a flat line

The most important shape to recognise, because it is usually **not** a discovery.
Read the diff for that iteration before believing it. Typical causes:

- the artefact found and exploited the test data
- it special-cased the specific inputs
- it disabled or short-circuited the expensive part the metric never checked
- the metric had a degenerate maximum nobody noticed

If it is a cheat, the fix is the *instruction* — name the thing explicitly and
rerun. Do not patch the artefact by hand; that invalidates every row above it.

## Steady climb that ends worse than it started

The metric is wrong. The number went up and the thing got worse, which means you
measured a proxy that stopped tracking the goal. This is the hardest failure to
accept and the most common one worth catching.

## What a note is for

The agent's note records the *hypothesis*, not the outcome — which is what makes
the ledger readable later. A row that says "widened the urgency lexicon" and
reverted is a fact about the problem. A hundred such rows is a map of what does
not work, and that is a real result.

## After the run

The artefact on disk is always the best measured result — keep-or-revert
guarantees it. So:

1. Read the winning diff and decide whether you believe it.
2. Read the reverts for what they say about the problem.
3. If you are revising, revise the **instruction**, and start a fresh run. Never
   continue a run under a changed directive.
