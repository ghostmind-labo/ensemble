# When the loop is the wrong tool

The autoresearch loop is narrow on purpose. Reaching for it when the shape does
not fit wastes a night and produces a ledger that looks legitimate.

## No code can score it

"Make this page nice." "Write a good skill." "Improve the tone."

There is no scalar, so there is no keep-or-revert, so there is no loop. The
tempting workaround — have the evaluator call a model and print its verdict —
satisfies the parser and destroys the thing the ledger is for. A judge drifts
across model versions, temperature, and a prompt that reads differently once the
artefact is longer, so iteration 40 stops being comparable to iteration 3, and
nothing tells you it happened.

Tracked as [ensemble issue #28](https://github.com/ghostmind-labo/ensemble/issues/28). Doing it properly means a pinned rubric, a pinned judge
model, temperature 0, median-of-N, and active drift detection — a real design,
not a config flag.

**What to do instead:** find a proxy code *can* measure; or score a narrow
sub-property honestly rather than the whole quality; or build an ordinary
`scene()` with a critique node and accept that it is a pipeline, not an
experiment.

## Runs are expensive or slow

The method's power comes from volume — Karpathy's 5-minute budget buys ~100
experiments overnight. At an hour per run you get eight, which is not a search,
and the fixed-budget reasoning stops paying for itself.

## Several independent things must change

If two things vary and the number moves, you have learned nothing about either.
`modify` accepts an array, but only for paths that **must move together** — a file
and its header. Genuinely independent knobs mean you have not decided what the
experiment is yet.

Note the distinction: several *artefacts* is usually a confused experiment,
whereas several *proposers*, a human gate, or two metrics are legitimate shapes
the sealed mode simply cannot express — those get the escape hatch
(`runtime: "experiment"`), documented in `autoresearch-build`.

## You want a decision, not an optimisation

- Many models weighing one question → a **jury**
- Stages that each refine the last → a **pipeline**
- A gate that sends work back until it passes → a **score gate**

All are ordinary `scene()` graphs. Load the `ensemble` skill.

## The baseline is broken

A loop optimises from where it starts. If the artefact does not run, or the
evaluator crashes, the baseline scores nothing and every iteration is compared
against nothing. Fix the baseline first — `ensemble validate` and running the
evaluator by hand cost nothing.

## You are hoping it will restructure the problem

It will not. It finds what is reachable by small edits from where you started.
Rethinking the approach is still yours.
