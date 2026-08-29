---
name: autoresearch
description: >-
  The autoresearch philosophy — Karpathy's overnight experiment loop, and how it shapes
  ensemble. Explains WHAT a research loop is and WHY its constraints exist: one artefact
  may change, one command scores it, one instruction never varies, and every change is
  kept or reverted against a code-graded number. Use this skill to decide whether a goal
  is a research loop at all, to understand why the sealed mode refuses things, or when
  the user says "autoresearch", "Karpathy", "iterate until it's good", "keep trying until
  it improves", "optimize this overnight", "loop until the score goes up", or asks how
  ensemble thinks about self-improving workflows. This skill is the CONCEPT; to actually
  build and run one, use the `autoresearch-build` skill instead.
---

# The autoresearch philosophy

> "Give an AI agent a small but real LLM training setup and let it experiment
> autonomously overnight." — [karpathy/autoresearch](https://github.com/karpathy/autoresearch)

An agent edits one file, runs a fixed 5-minute training job, reads a single
validation number, and decides to keep the change or throw it away. Then it does
it again. About 12 experiments an hour, ~100 overnight. In the morning a human
reads the log.

That is the whole idea. Everything interesting about it is in what the agent is
**not** allowed to do.

## The three things

ensemble seals this as `research({ modify, evaluate, instruction })` — three keys,
and it refuses every other one by name.

| | Karpathy | ensemble | Who writes it |
|---|---|---|---|
| the artefact | `train.py` | `modify` | the **agent**, every iteration |
| the scorer | 5-min run → val BPB | `evaluate` | the **human**, once |
| the directive | `program.md` | `instruction` | the **human**, once |

And one thing nobody writes: **the loop itself**. `prepare.py` is fixed and never
modified; in ensemble the graph is generated, identical for every research file
in the world. That is deliberate — two people's results are comparable because
their scaffolding is not a variable.

## Why each constraint exists

Read this part. The constraints are the method; without them you have a chatbot
editing files.

**One artefact may change.** Karpathy: *"The agent only touches `train.py`. This
keeps the scope manageable and diffs reviewable."* If two things vary and the
number moves, you have learned nothing about either. Everything you could turn
into a knob is a confound, so the mode gives you exactly one.

**A fixed wall-clock budget.** *"A fixed 5-minute time budget (wall clock,
excluding startup/compilation), regardless of the details of your compute."* This
does two jobs at once. It bounds the loop so ~100 experiments fit in a night. And
it makes speed part of the score for free — a change that helps but halves
throughput shows up as worse, because it got less done in its 5 minutes. You do
not need a separate efficiency metric; the clock is one.

**One scalar, produced by code.** Karpathy picked validation BPB because it is
*"vocab-size-independent so architectural changes are fairly compared."* That
sentence is the whole craft. A metric that quietly changes meaning as the
artefact changes shape will reward the wrong thing, confidently. Code is chosen
over a model judge for the same reason: a judge drifts across versions,
temperature, and a prompt that reads differently once the artefact is longer.
Drift makes iteration 40's score incomparable to iteration 3's, and it does so
invisibly — the numbers still look like numbers.

**Keep or revert, never "improve a bit."** After every experiment the artefact
is either the new best or restored to the incumbent. There is no gradual drift
toward something nobody chose. The file on disk is always the best result you
have actually measured.

**The instruction never varies.** It is read identically on every iteration. It
is the human's only lever, and it is a *constant* precisely so that the agent's
proposals are the variable. Rewriting it mid-run does not tune the experiment —
it starts a different one, and silently invalidates the ledger above it.

## The division of labour

Humans do not edit the artefact. That is the inversion, and it takes some getting
used to: you are not writing `train.py` anymore, you are writing the *instruction*
that makes an agent write `train.py` well. When results disappoint, the fix is
almost never to reach into the file — it is to notice what the instruction failed
to forbid, or failed to ask for, and say it.

## What it costs you

Be honest about this up front:

- **Results are platform-specific.** A fixed wall clock means an H100's 5 minutes
  and a laptop's 5 minutes are different experiments. Comparable *within* a
  machine, not across. Karpathy accepts this trade deliberately.
- **The metric is the goal, and the agent will optimise the metric.** If the
  scorer can be gamed, it will be. Anything the agent can reach, it can cheat —
  which is why in ensemble research mode the write tools are scoped to the
  artefact and `bash` is withdrawn entirely.
- **A loop is not insight.** It finds what is reachable from where you started by
  small edits. It will not restructure your problem, and a hundred iterations of
  a bad instruction is a hundred wasted experiments.

## Is your goal actually a research loop?

**Yes, when all four hold:**

1. There is **one artefact** whose change you care about.
2. There is a **number** that says whether it got better — that code can compute.
3. The number is **comparable across iterations** (it means the same thing on
   iteration 1 and iteration 50).
4. Runs are **cheap and bounded** enough to do many of them.

**No, when:**

- *You cannot score it with code.* "Make this page nice", "write a good skill" —
  a real gap, tracked in issue #28. Do not fake it by having the evaluator call a
  model and print a number; that satisfies the parser and quietly destroys the
  ledger.
- *One run is expensive or slow.* Ten experiments is not a search, and if each
  costs an hour the fixed-budget logic stops paying for itself.
- *Several things must change together.* Then either it is one artefact spread
  across a few files (`modify` accepts an array), or it is not a loop yet.
- *You want a decision, not an optimisation.* Many models weighing one question is
  a **jury**; stages that each refine the last is a **pipeline**. Both are
  ordinary `scene()` graphs. Load the `ensemble` skill for those.

**Read `references/when-not-to.md`** before talking a user out of — or into — a
loop. It covers each of these cases in full, including what to build instead.

## Where this lives in ensemble

The philosophy is enforced, not suggested:

- `research()` accepts three keys and refuses ~14 others **by name, with the
  reason** — `nodes`, `edges`, `state`, `model`, `prompt`, `goal` and so on. The
  refusals are the interface: they teach the method while blocking the confound.
- Operational choices that do not shape the experiment are run-time flags, not
  file keys: `--iterations`, `--model`, `--threshold`. The file is the
  experiment; the flags are the session.
- Write tools are scoped to `modify`; `bash` is withdrawn. A proposer that can
  shell out can rewrite its own evaluator.
- Every iteration appends to `results.tsv` — the ledger you read in the morning.

**To build and run one, load the `autoresearch-build` skill.** This skill is the
why; that one is the how.
