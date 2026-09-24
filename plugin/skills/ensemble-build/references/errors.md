# validate messages and their fixes

`ensemble validate` prints problems as `· <message>`. Each message already names
its fix. This table covers the intent behind each one, so you fix the design and
not just the symptom.

| Message contains | What it means | Fix |
|---|---|---|
| `is not a node. Nodes:` (entry) | `entry` names a node that doesn't exist | Point `entry` at the first node |
| `is none of decide / work / code / model / mcp` | The node has no kind key, often a typo like `decides:` or `models:` | Use exactly one of `decide`, `work`, `code`, `model`, `mcp` |
| `is both X and Y` | Two kind keys on one node | Split it into two nodes joined by an edge |
| `has an empty decide block` | `decide: {}` | Ask at least one question, or make the node something else |
| `which is not a valid identifier` | A question key like `"needs text"` | Use `needs_text`. Keys become state keys and branch labels |
| `declares no reads` | A decide node without `reads` | Add the *minimal* keys, usually `reads: ["goal"]`. Don't send everything: accuracy falls with irrelevant state |
| `holds image data and Jev takes text only` | A decide node reads a key that a model node `sees` or draws | Add a `model` node that looks and writes a sentence (`writes: ["scene"]`), then read `scene` instead |
| `gates on "x", which it does not ask` | `gate.on` is misspelled or names another node's question | Name a question of *this* node |
| `gates on "x", a noul` | A noul has no confidence, because its value *is* its certainty | Branch with `on: "x>=0.8"` or `on: "!x"`, or gate on a choice or score |
| `gates to "x", which is not a node` | Bad `gate.to` | Name an existing node, usually a safe exit |
| `gate.min … between 0 and 1` | For example `min: 70` | Use `0.7` |
| `runs work "x", which is not in the work map` | A handler name that isn't registered | Add `x` to `work: {}`, or fix the name |
| `declares code that is not a function` | `code: "…"` | `code: (s) => …` |
| `names no model` | Empty `model` | A live-checked id, or `{ from: "key" }` |
| `has no prompt` | A model node without a `prompt` | Add the instruction, as a string or `(s) => string` |
| `writes at most two keys, positionally` | A model or mcp node with 3+ writes | `[text]` or `[text, images/data]`. Split any extra fields out in a `code` node after it |
| `both looks at and overwrites` | `sees: ["img"]` and `writes: [_, "img"]` | Write the drawn images to a new key |
| `names skill "x", which is not in the runner's registry` / `loaded no skills` | A model node lists a skill the runner didn't load | Pass `skills: loadSkills()` to the runner, or fix the name (`ensemble skills` lists them) |
| `uses MCP server "x", which the runner does not declare` | Missing `mcpServers.x` | Declare `{ command, args }`, found via `ensemble servers <q>` |
| `names no tool` | Empty `mcp.tool` | A tool name, or `{ from: "key" }` |
| `edge N (a→b): "x" is not a node` | A typo in `from` or `to` | Fix the name |
| `has both on and when` | Mixed branch forms | Meaning goes in `on`, arithmetic in `when`. Pick one |
| `cannot parse on:` / `"!" cannot be combined` / `is not a number` | Bad `on:` syntax | Grammar: `k=opt`, `k`, `!k`, `k>=0.7` |
| `leaves "x", which is not a decide node` | An `on:` edge leaving a work, code or model node | Use `when: (s) => s.k === "opt"` for keys written earlier, or move the edge onto the decide node |
| `reads "k", which "x" does not ask` | `on:` names a question of another node | Branch where the question is asked, or use `when:` |
| `uses "=", which only a choice answers` | `on: "urgent=yes"` on a noul | `on: "urgent"` or `on: "urgent>=0.7"` |
| `has no option "o". Declared:` | A typo in an option name | Use one of the declared names exactly |
| `thresholds "k", a score` | `on: "quality>=1.5"` | `when: (s) => Number(s.quality) >= 1.5`. A score is a number |
| `thresholds "k", a choice` | `on: "team>=0.5"` | `on: "team=billing"`. To use confidence, set `gate` |
| `asks "k" but nothing handles "a", "b"` | Options without an edge, where the run would silently end | Wire each one. Add a bare default edge only if one shared fallback is really intended |
| `a noul, but nothing handles an answer of …` / `just above …` | Threshold edges on a noul leave part of the 0–1 range with no edge, so the run would fall through to the exit there | Add the edge the message names (`on: "k<0.8"`, or the missing band), or a default edge from that node with no `on`/`when`. Only reported when the fall-through is provable: no forks, no `when:`, no already-exhaustive choice at the node |
| `reads "k" but nothing writes it` | A key with no origin | If it comes from the caller, add it to `inputs`. If a node should produce it, add it to that node's `writes`. Often a typo: compare with the "Written in this runner" list |
| `in its when() but nothing writes it` | A `when` touches a missing key | Same fix. Also check `s.k` spelling in the predicate |
| `result: "k" is never written` | Bad `result` | Name a key that a final node writes |
| `unreachable from "entry"` | Nodes that no edge or gate leads to | Wire them in, or delete them |
| `has N forking edge(s) and M ordinary — a node's edges are all forks` | Mixed `fork: true` and plain edges on one node | Mark them all `fork: true`, or move the ordinary edges to another node |
| `is join: "all" but only one edge leads there` / `no edge leads there` | A join with fewer than two incoming edges | Point each lane's last edge at it, or drop the join |
| `entry "x" is a join` | The entry node is a join | Start from a plain node |
| `forks to "a" and "b", but both lanes reach "x"` | Two lanes share a node that isn't a join | Mark it `join: "all"` if the lanes should meet there, or give each lane its own node |
| `but the lanes both touch "k" — concurrent lanes must write and read disjoint keys` | One lane writes a key another lane writes or reads | Write to separate keys and combine them after the join |
| `memory key "k" is never written` | A declared memory key with no writer | Add it to a node's `writes`, or declare it in `inputs` instead |
| `"k" is both an input and memory` | Same key in both lists | Pick one: inputs arrive each run, memory carries over |

## Failures that validate cannot see (found by dryrun or a live run)

| Symptom | Cause | Fix |
|---|---|---|
| `x.x` nested in state, or a later `when` always false | One write key got an object | Return the bare value |
| `declares writes a, b but returned string` | Several write keys, non-object return | Return `{ a, b }` |
| `returned no b` | The multi-write object is missing a key | Return every declared key |
| A loop runs to `maxSteps` | A back-edge without `maxLoops`, or a `when` that never flips | Add `maxLoops` plus a following exit edge |
| `result` is `undefined` | The path taken never wrote the `result` key | Make every exit node write it |
| `takes its tool from "k", which is "none"` | A `tool=none` answer reached an mcp node | Route `on: "tool=none"` somewhere else first |
| A safety edge is skipped on unsure answers | A `gate` on the same node fires before any edge | Split the node into screen (overrides) → route (gated choice), or send the gate to the same safe exit |
| A `when:` key shows `readBy: []` in `graph.json` data | `&&` / `||` / `?:` short-circuited during the probe, so validation never saw that key | Read every key into a variable before combining them |
| An edge never taken in `--explore` | Dead wiring, a shadowing edge above it, or a `when` the stubs never tripped | Reorder, delete, or confirm the `when` with `--answer` |
| `asked "k" but the decider returned no answer for it` | Whatever is mounted on the `Decider` seam — a stub, a cache, a fallback model — left a question out (`DeciderAnswerError`, reaching the caller as `RunFailed.cause`) | Answer every question handed in, keyed as asked. Declaring `fallback` routes it instead of failing |
| `asked "k" and the decider said something the graph cannot route: …` | The answer is outside the closed question: an option that was never declared, a level or probability out of range, or the wrong answer type. The run would have exited having done nothing (`DeciderAnswerError`) | Fix the decider — a stub must return the declared option names and types. An answer that does not fit is no answer, so it takes the node's `fallback` when there is one |
| `no OpenRouter key — set OPENROUTER_API_KEY` | A live run reached a decide or model node with no key (`JevError` / `OpenRouterError`) | Set `OPENROUTER_API_KEY`, or pass `openrouter: { apiKey }` on the runner. It is the only key: Jev is reached through OpenRouter too |
| `jev: out of credits — add some at https://openrouter.ai/credits (HTTP 402)` | The OpenRouter account is empty. Not retried | Top up the account; one balance pays for decisions and generation alike |

## A person in the loop

| Message or symptom | What it means | Fix |
|---|---|---|
| `is answered by a person and has a gate` | A gate on a `by: "human"` node | A person's answer has no confidence. Remove the gate; route on the answer with `on:` edges |
| `has by: "…" — omit it for the decider, or write by: "human"` | A typo, or another value | Only `"human"` exists |
| `declares comment but is not by: "human"` | A note key on a decider node | Only a person leaves a note |
| `writes its comment to "k", which is also a question key` | The note would overwrite an answer | Give the note its own key |
| `that lane asks a person at "x" — a run can pause on only one lane` | A human node between a fork and its join | Move the question after the join |
| `falls back to "x", which is not a node` | Bad `fallback` | Name an existing node, usually a person or a hold |
| `"k" is yes or no, not …` / `is one of …, not …` / `is a level from 0 to N` / `got no answer — answer every question` | The person's answer doesn't fit the closed question (`HumanAnswerError`) | Fix the integration that built the answer. It deliberately does not take the fallback |
| `the graph changed since this run paused` (`ResumeError`) | The runner was edited between pause and resume | Resume with the graph that paused it, or start a new run |
| `this run paused in "a", not "b"` | Resumed with the wrong runner | Use the runner named in the snapshot |
| `ensemble run` exits 3 | The run paused for a person and there was no terminal to ask | Expected. Run the printed `ensemble resume … --answer …` |
| `took: "fallback"` in a step | The decider could not answer, and the node declared a fallback | Expected. Read the step's `error` for why |

## calibrate and supervise

| Message or symptom | What it means | Fix |
|---|---|---|
| `case N tests X, which reads k — add "k" to its inputs` | A case lacks a key the node reads, maybe one a model node normally writes | Put that key in the case's `inputs`. For a model-written key, use the text the model would produce |
| `expects "k", which no decide node asks` | Wrong key | Use `node.key` as listed by `ensemble graph … \| jq '.nodes[].questions'` |
| `which more than one node asks — write it as node.key` | A bare key is ambiguous | Use `node.key` |
| `is a choice — expect one of …` / `a noul — expect true or false` / `a score — expect a level from 0 to N` | The label has the wrong type | Option name, boolean, or 0-based integer level |
| `has set "…" — a case is "dev" (tuned against) or "holdout" (looked at once)` | A third set name | Cases are tuned against (`dev`, the default) or frozen (`holdout`) |
| `gap` shows a drop of 0.1+ between dev and holdout | The questions were fitted to the dev cases | Rewrite the boundaries (`not_for`) from the holdout misses, then get NEW holdout cases — the old ones are now dev |
| the watcher never mentions what a tick produced | Default: `recent` carries supervisor-written facts only | `watch: { evidence: "facts+text" }`, and only where the tick's output is trusted |
| `did not finish within Nms` | `stepTimeout` fired: a handler, model or tool call hung | Find the slow call in the step's `node`. Raise the limit only if that call is legitimately slow |
| status `failing`, alert `N ticks in a row did not complete` | `maxStreak` consecutive ticks failed | Read the `run` lines in `journal.jsonl` for the failing step's `error` |
| alert `the watcher returned … — it must return "continue", "alert" or "stop"` | The watcher's `result` isn't one of the three | Make every watcher exit write one of the three strings, and set `result` or end on a node that returns it |
| a `rest` event, then nothing for hours | `budget.perDay` is spent. It sleeps until the oldest spend is 24 h old | Expected. Raise `perDay`, or cut the cost per tick |
| memory resets after a restart | No `journal` directory, or `resume: false` | Pass the same `journal` path every time |
| memory never changes | The runner writes the key on a path that fails, or not at all | Only completed ticks update memory. Check the `run` lines for that node's `error` |
| `next()` receives `interrupted` after a restart | The process stopped mid-tick; the journal shows steps with no checkpoint after them | Look at `interrupted.steps` before asking for the tick again: a `work` step there may already have had its effect. `finished: true` means every effect happened and only the memory update was lost |
| `run.cost.total` is higher than the completed steps add up to | A step reported a cost and then threw; that money was still spent | Expected. Report cost as early as it is known, so a failure cannot hide it |
| `is held by process N, which is still running` | Another supervisor owns this journal | Stop it, or use another `journal` path. A dead holder's lock is taken over automatically |
| stopped with `SIGTERM received — stopping after the tick in flight` | A deploy or ctrl-C | Expected: the tick finished and was checkpointed. Restart with the same `journal` to resume |
