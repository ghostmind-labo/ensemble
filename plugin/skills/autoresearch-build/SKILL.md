---
name: autoresearch-build
description: >-
  Build and run an autoresearch loop with ensemble. Takes a goal from "I want X to get
  better" to a running, resumable loop: name the three things, seed the artefact, write an
  evaluator that prints a scrapeable number, write the sealed program file, launch with
  `ensemble research`, then read results.tsv. Use whenever the user wants a loop that
  improves something measurable — "iterate until it's good", "keep trying until it
  improves", "optimize this overnight", "loop until the score goes up", "make it iterate
  on X", "build me an autoresearch", "set up the loop", "run the experiment", "why did it
  revert", "read the results" — or hands you a .mts file using `research({...})`. If the
  user instead asks WHY a constraint exists, or whether their goal qualifies as a loop at
  all, load the `autoresearch` skill.
---

# Building an autoresearch loop

Implementation. For the philosophy behind these rules, load the **`autoresearch`**
skill — it explains why the mode refuses things, and this one assumes you know.

## Before you start

Check the loop is the right tool at all (`autoresearch` skill, "Is your goal
actually a research loop?"). The single most common failure is running a loop on
a goal that code cannot score.

Then confirm setup once:

```bash
ensemble --version              # 0.21+
echo "${OPENROUTER_API_KEY:+set}"   # the only credential
```

## Step 1 · Name the three things

Do this in prose with the user before writing any file. If you cannot fill all
three lines, you are not ready.

```text
modify      — ONE artefact (a path, or a few paths that must move together)
evaluate    — a shell command that prints a number
instruction — what to aim for, and what is off limits
```

**Interrogate `evaluate` hardest.** It is the part people hand-wave, and a bad
scorer wastes the entire run — read `references/writing-the-evaluator.md` before
you write one. The single question it turns on: *if the agent maximises this
number as hard as it can, do I get what I actually wanted?*

## Step 2 · Seed the artefact

`modify` must **exist before the baseline** — validation refuses a path that does
not, because the loop measures the incumbent first and there must be an incumbent.

For a *creator* loop (the artefact does not exist yet), write a minimal honest
starting point — not an empty file. A stub that runs and scores badly is a real
baseline; an empty file is usually a crash, and a crashed baseline tells you
nothing about whether iteration 1 helped.

## Step 3 · Write the evaluator

The rules, in order of how often they are broken:

1. **Print a number the parser can find.** Default is the last number printed;
   name one with `metric: "score"` and print `score: 91.7`.
2. **It must not be reachable by the agent.** Put it outside `modify`. Research
   mode scopes the write tools and withdraws `bash`, but do not rely on that as
   your only defence — if cheating is *possible*, treat the result as suspect.
3. **It must be fast**, and it runs under `budget` (default `"5m"`). Over budget
   is killed and scores nothing — a timeout is not a bad score, it is no score.
4. **It must be deterministic**, or the loop measures noise. Seed anything random.
5. **Exit code decides nothing.** The metric does. A non-zero exit with a printed
   number still counts; that is deliberate.

Start from `templates/measure.mjs.template` — it carries these rules as comments
and shows the held-out-cases shape.

## Step 4 · Write the program file

Start from `templates/program.mts.template`, or write it directly:

```ts
import { research } from "@ghostmind-dev/ensemble";

export default research({
  modify: "path/to/artefact.mjs",

  evaluate: {
    command: "node path/to/measure.mjs",
    metric: "score",        // omit → the last number printed
    minimize: false,        // true when lower is better (a loss)
    budget: "5m",           // wall clock per experiment (this is the default)
  },

  instruction: `
What to aim for, in one or two sentences.

What is off limits — be explicit. Anything you do not forbid, the agent may do,
and the thing you forgot is usually how the metric gets gamed.
  `.trim(),
});
```

`evaluate` may also be a bare string when the defaults suffice: `evaluate: "npm test"`.

**Three keys. Nothing else.** No `nodes`, `edges`, `state`, `model`, `prompt`,
`name`, `goal`, `iterations` or `threshold` — the mode refuses each by name and
tells you where it actually belongs. If you find yourself wanting one, re-read
the refusal; it is usually right.

## Step 5 · Validate (free) then run

```bash
ensemble validate program.mts        # free, instant — catches a missing artefact
ensemble research program.mts        # baseline first, then experiments
```

Flags are the **session**, not the experiment — that is why they are not in the file:

| flag | default | what it does |
|---|---|---|
| `--iterations <n>` | 10 | experiments after the baseline |
| `--model <ref>` | claude-sonnet-5 | the proposing model |
| `--threshold <n>` | 0 | gain required to keep a change — the noise floor |

Set `--threshold` above 0 when your metric is noisy, or the loop will "keep"
changes that are measurement jitter. A tie always reverts.

## Step 6 · Read the ledger

`results.tsv` in the run directory: one row per iteration, with the score, the
verdict (`baseline` / `keep` / `revert`), and the agent's note. This is the
artefact you actually review. See `references/reading-the-ledger.md` for what the
shapes mean — plateau, thrash, a suspicious jump.

The run is an ordinary scene underneath, so everything else works:
`ensemble serve` to watch it live, `ensemble resume <run-dir>` after a stop.

## Step 7 · Revise the INSTRUCTION, never the loop

When the run disappoints, the fix is almost always one of:

- **The instruction failed to forbid something.** The agent found a cheap win you
  did not want. Name it explicitly and rerun.
- **The instruction failed to ask for something.** Generality, a constraint, a
  shape. Say it.
- **The metric was the wrong one.** Hardest to accept and most often true.

Do **not** reach into the artefact by hand, and do not edit the instruction
mid-run. Both invalidate every row above them in the ledger.

## When the seal genuinely does not fit

The sealed mode is narrow on purpose, but "the mode refuses it" is not the same as
"ensemble cannot do it." Three shapes are real experiments the three keys cannot
express:

- **a jury of proposers** — several models proposing, not one
- **a human gate each round** — approval before every experiment runs
- **two metrics** — a trade-off rather than a single scalar

For these, drop to `scene()` with a scene-level `research: {}` block and
`runtime: "experiment"` — the same measure/keep/revert machinery with the
guardrails off. The `ensemble` skill documents that form under "Escape hatch".

Reach for it only when one of the above actually applies. You are giving up the
property that makes the sealed mode worth having: that the scaffolding is not a
variable between experiments.

## Common failures

| Symptom | Cause |
|---|---|
| `research.edit names "x" but it does not exist` | seed the artefact (step 2). `research.edit` **is** your `modify` key — the sealed mode compiles to the scene-level block, whose key is `edit` |
| every iteration reverts | threshold too high, metric too noisy, or instruction too vague |
| score jumps then plateaus instantly | the agent found a shortcut — read the diff, then forbid it |
| the metric improves but the thing got worse | the metric is wrong; this is the real failure mode |
| baseline scores nothing | evaluator crashed or timed out — run its command by hand |

## Worked example

A complete, cheap one lives in the ensemble repo at
<https://github.com/ghostmind-labo/ensemble/tree/main/examples/05-autoresearch>:
a spam heuristic (`heuristic.mjs`) scored by 24 labelled messages
(`measure.mjs`), baseline 54.2. Its `research.mts` is 30 lines and shows the
shape of a good `instruction`, including the explicit "hard-coding the sample
sentences is a fabricated result, not a finding."

(Those paths are in the ensemble repo, not in the user's project — do not try to
read them locally unless you are working inside a checkout of ensemble itself.)
