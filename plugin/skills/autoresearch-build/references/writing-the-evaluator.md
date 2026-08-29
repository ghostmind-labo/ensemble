# Writing the evaluator

The evaluator is the part people hand-wave and the part that decides whether the
run means anything. Karpathy did not pick validation BPB casually — he picked it
because it is *"vocab-size-independent so architectural changes are fairly
compared."* That choice **is** the research design.

## The one question

> If the agent maximises this number as hard as it possibly can, do I get what I
> actually wanted?

If there is any answer other than yes, fix the metric before you run anything.
The loop is very good at finding the gap between what you measured and what you
meant.

## Comparability is the property that matters

A metric must mean the same thing on iteration 1 and iteration 50, *even as the
artefact changes shape*. This is subtler than it sounds:

- **Raw loss across architectures** is not comparable if the vocabulary changed —
  hence BPB.
- **Accuracy on a test set the agent can read** is not comparable, because it
  stops measuring generalisation the moment the agent memorises it.
- **Anything with a model in it** is not comparable, because the judge drifts.
- **Wall-clock-dependent throughput** is comparable only on one machine.

If comparability breaks halfway through, nothing announces it. The numbers keep
looking like numbers and the ledger silently becomes fiction.

## The budget is part of the metric

`budget` is not just a safety valve. A fixed wall clock folds *efficiency* into
the score for free: a change that helps quality but halves throughput gets less
done in its window and scores worse. You rarely need a separate speed metric.

Pick a budget where a normal run finishes comfortably. Over budget is **killed
and scores nothing** — that is deliberate (a partial run's output describes an
unfinished experiment), but it means a too-tight budget turns every iteration
into a no-op.

## Determinism

Seed everything. An unseeded evaluator makes the loop measure noise, and with
`--threshold 0` it will happily "keep" jitter. Two ways out:

1. Make it deterministic (preferred).
2. Raise `--threshold` above the noise floor, and know what that floor is —
   measure it by running the baseline three times unchanged.

## Keep it out of reach

The evaluator must live outside `modify`. Research mode already scopes the write
tools to the artefact and withdraws `bash` for exactly this reason, but defence
in depth is cheap: if the agent *could* reach the scorer, treat any surprising
improvement as suspect until you have read the diff.

Related smells:

- the artefact reading the test data
- the artefact special-casing inputs it has seen
- a jump to a suspiciously round number
- a large gain from a small, strange diff

## Printing the number

The parser is deliberately forgiving. With `metric: "score"` all of these work:

```
score: 91.7
score=91.7
{"score": 91.7}
```

Without `metric`, it takes **the last number printed**. Either way **last
occurrence wins**, so a progress log that prints numbers is fine as long as the
real score comes last — but naming the metric is more robust and worth doing.

Exit code decides nothing. A non-zero exit that still printed a number counts.

## When code genuinely cannot score it

Do **not** have the evaluator call a model and print its verdict. It satisfies
the parser and destroys the ledger — see [ensemble issue #28](https://github.com/ghostmind-labo/ensemble/issues/28), which tracks doing this
properly with a pinned rubric, a pinned judge, and drift detection.

Until then, the honest options are: find a proxy that code *can* measure, score a
narrow sub-property rather than the whole quality, or accept that this goal is a
`scene()` graph with a critique node rather than a research loop.
