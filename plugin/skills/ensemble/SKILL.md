---
name: ensemble
description: Operate @ghostmind-dev/ensemble end to end as an agent. Covers what a runner is, writing a graph (decide, work, code, model, mcp and agent nodes, edges, forks, loops, a person in the loop), checking it for free (validate, graph, dry-run, check), running it, watching a run while it is live (nodes in progress, each step's answers and confidence, the state so far, the cost), sending it a signal (stop it, or answer the question it paused on), reading the finished record, and changing a runner safely. Locally this is the `ensemble` CLI; against a hosted runner the same operations are MCP tools (start_run, get_run, list_runs, cancel_run, answer). Use this whenever a task involves an ensemble runner or a runner(...) .mts file, a decision graph or Jev workflow, `.ensemble/runs` or `.ensemble/live`, questions like "what is that run doing", "stop it", "why did it take that branch", "it is waiting for an answer", or any request to build, run, monitor, steer or modify one.
---

# Operating ensemble

ensemble runs a **graph of steps** toward a goal. At each fork a classifier (Jev) answers a closed question (yes/no,
one of N, or a position on a scale), and the answer picks the branch. Because the questions are closed, every branch
is known before anything runs. A run takes one input and returns one result, and leaves a record of every step with
its answers and how confident each was.

A runner is one `.mts` file that default-exports `runner({...})`. Everything below is about that file and its runs.

## Which interface you use

| Where the runner is | You use | You need |
|---|---|---|
| On this machine, in a project you can run commands in | The `ensemble` CLI | A shell. Nothing else: no server, no MCP |
| Hosted by someone, reached over the network | MCP tools | The connector added to your tools by the host |

The operations are the same in both. Use the column that matches where you are.

| To | Locally (CLI) | Hosted (MCP tool) |
|---|---|---|
| Prove the graph is sound | `npx ensemble validate <file>` | done by the host |
| See the graph as data | `npx ensemble graph <file>` | the tool list describes each runner |
| Run and wait for the result | `npx ensemble run <file> "goal" --budget 0.05` | the tool named after the runner |
| Run without waiting | the same command, in the background | `start_run` |
| See what is running, and what has run | `npx ensemble status` | `list_runs` |
| Read one run's state right now | `npx ensemble status <id>` | `get_run` |
| Stop a run | `npx ensemble stop <id>` | `cancel_run` |
| Answer a run that paused to ask | `npx ensemble resume <file> <paused.json> --answer key=value` | `answer` |
| Read a finished run | `.ensemble/runs/<id>/run.json` | `get_run` |

`validate`, `graph`, `status` and the dry-run are free and offline. `run` costs real money (a decide step is about
$0.00002; a model step is whatever the model costs), so **always pass `--budget`** and never start a paid run the
person did not ask for.

## 1. Understand a runner before touching it

```sh
npx ensemble validate triage.mts          # is it sound? Problems are listed, each naming its fix
npx ensemble graph triage.mts | jq        # every node, edge and question, as JSON
```

In `graph.json`: `nodes[]` (each with a `kind`, what it `reads` and `writes`, and for a decide node its `questions`),
`edges[]` (each with an `id` such as `e0`, and its condition), `runner.entry` (where a run starts) and
`runner.result` (the state key a run returns).

## 2. Build a graph

Install the library in the project (`npm install @ghostmind-dev/ensemble`, Node 22.18 or later) and write one file:

```ts
// triage.mts
import { choice, noul, runner, score } from "@ghostmind-dev/ensemble";

export default runner({
  name: "triage",                          // letters, digits, - _ . : it names the runs and the tool
  description: "Routes a support message and drafts a reply.",
  inputs: ["goal"],                        // `goal` always exists; list any others

  work: {                                  // your code: any library, any side effect
    send: ({ state }) => `[${state.team}] ${state.reply}`,
    hand_off: ({ goal }) => `Handed to a person: ${goal}`,
  },

  nodes: {
    classify: {
      decide: {
        team: choice("Which team should handle this message?", {
          billing: { what: "Charges, invoices, refunds", not_for: "Where a parcel is" },
          orders: { what: "Delivery, cancellation, returns", not_for: "Money questions" },
        }),
        upset: noul("Is the customer clearly upset?"),
      },
      reads: ["goal"],
      gate: { on: "team", min: 0.7, to: "escalate" },   // unsure → a person
    },
    draft: {
      model: "vendor/model-id",            // an OpenRouter id; check the live catalogue, never guess one
      prompt: (s) => `Reply to this ${s.team} message:\n${s.goal}`,
      reads: ["goal", "team"],
      writes: ["reply"],
      maxTokens: 2000,                     // generous: models that reason pay for it out of this
    },
    check: {
      decide: { quality: score("How good is the reply?", [{ what: "Unusable" }, { what: "Fine" }, { what: "Excellent" }]) },
      reads: ["goal", "reply"],
    },
    deliver: { work: "send", reads: ["team", "reply"], writes: ["outcome"] },
    escalate: { work: "hand_off", reads: ["goal"], writes: ["outcome"] },
  },

  edges: [
    { from: "classify", to: "draft" },
    { from: "draft", to: "check" },
    { from: "check", to: "escalate", when: (s) => Number(s.quality) < 0.5 },   // numbers go in `when`
    { from: "check", to: "deliver" },                                          // no condition: the default
  ],

  entry: "classify",
  result: "outcome",
});
```

### The six node kinds

| Kind | It is | Use it for |
|---|---|---|
| `decide` | One call to Jev with one or more closed questions | Anything about meaning: which category, is this X, how good |
| `work` | A handler you wrote, named in `work: {}` | Effects: send, store, call an API, anything with a library |
| `code` | An inline function of the state | Arithmetic and bookkeeping: counts, thresholds, dates |
| `model` | One generative call through OpenRouter | Writing, looking at an image (`sees`), drawing |
| `mcp` | One tool call on an MCP server | A tool someone else already built |
| `agent` | One message to an external agent | Handing a whole sub-task to another agent |

Add `by: "human"` to a decide node and a person answers its questions in Jev's place; the run pauses until they do.

### The three questions

| Builder | Lands in state as | Branch on it with |
|---|---|---|
| `choice(question, { option: description, … })` | the option name | `on: "team=billing"` |
| `noul(question)` | P(yes), 0 to 1 | `on: "upset"`, `on: "!upset"`, `on: "upset>=0.7"` |
| `score(question, [level0, level1, …])` | a fractional level, 0-based | `when: (s) => Number(s.quality) >= 1.5` (no `on:` form) |

Write each option as `{ what, not_for }`: `not_for` draws the line against the neighbouring option. Keep questions
atomic. Never ask Jev to count, add or compare dates: put numbers in a `code` node or a `when`.

### Edges

- Tried in the order written; the first that holds wins. An edge with no condition is the default.
- `on:` is for a decide node's answer. `when:` is plain code and can leave any node. Never both on one edge.
- `maxLoops: n` lets an edge match n times, then the next one takes over. That is how a loop ends.
- `fork: true` on several edges from one node runs them in parallel; a node with `join: "all"` waits for all of them.
  Parallel lanes must write different state keys.
- A node with no edge that holds ends the run.

### State

Every key a node reads must come from somewhere: the runner's `inputs` (plus `goal`), or an earlier node's `writes`.
A decide node writes one key per question. A node with one `writes` key stores its return value whole; with several
it must return an object with those keys.

For every field, the other node kinds in detail, and worked graphs, use the `ensemble-build` skill and its
`references/`. For writing questions Jev answers well, use `ensemble-questions`.

## 3. Check it, for free

Do all of these before any paid run. Each catches what the next cannot.

```sh
npx ensemble validate triage.mts       # structure: every option wired, every key has an origin
node <ensemble-build skill>/scripts/dryrun.mts triage.mts --explore    # walks every branch with fake answers, $0
npx ensemble check triage.mts          # can it run here: the key, the model ids, the MCP servers
```

`validate` returns problems as sentences that name the fix; apply them one at a time and run it again. The dry-run
executes your real handlers with stubbed decisions and models, so it also catches a handler that throws.

## 4. Run it

```sh
npx ensemble run triage.mts "I was charged twice for order A-104" --budget 0.05
```

Other inputs go in with `--input key=value`. The run prints one line per step, writes its record to
`.ensemble/runs/<id>/`, and exits 0 when it completed, 1 when it failed or was stopped, and 3 when it paused for an
answer.

To watch or steer a run, start it in the background so your shell stays free, then use the commands in the next two
sections.

A runner called from a script instead of the CLI is visible to the same commands when it is wrapped:

```ts
import { tracked } from "@ghostmind-dev/ensemble";
import triage from "./triage.mts";
const { result, run } = await tracked(triage)({ goal }, { budget: 0.05 });
```

## 5. Watch a live run

```sh
npx ensemble status                # live runs first, then the last ten recorded
npx ensemble status --json         # the same, as data: { live: [...], recorded: [...] }
npx ensemble status <id>           # one run as JSON. A live id looks like 51234-1; a finished one is its folder name
```

A live run reads like this:

```json
{
  "id": "51234-1",
  "runner": "triage",
  "status": "running",
  "started": "2026-10-05T19:31:43.000Z",
  "cost": 0.000018,
  "running": ["draft"],
  "steps": [
    { "node": "classify", "kind": "decide", "took": "e0", "cost": 0.000018,
      "answers": { "team": { "type": "choice", "value": "billing", "confidence": 0.91 } } }
  ],
  "state": { "goal": "I was charged twice…", "team": "billing", "upset": 0.91 }
}
```

| Field | What it tells you |
|---|---|
| `running` | The nodes in progress right now. Empty means between nodes |
| `steps` | Every node that has finished, in order, with the edge it `took` and, for a decide node, its `answers` |
| `state` | The inputs plus everything written so far. This is what later nodes will read |
| `cost` | USD spent so far |

A run that is not in `live` has ended; find it under `recorded` and read its `run.json`. Poll at a sensible pace: a
model step can take tens of seconds, so every few seconds is enough.

## 6. Send a signal

A run accepts exactly two signals from outside. It cannot be handed arbitrary data mid-run: every state key has a
declared origin, which is what lets the graph be proven sound.

### Stop it

```sh
npx ensemble stop <id>
```

The run cancels itself: every handler is told to stop, and the record is written with status `cancelled`, showing
the steps that completed. The command waits until that has happened.

### Answer it

A run pauses at a decide node marked `by: "human"`. It exits 3 and prints the file to resume from:

```sh
npx ensemble resume triage.mts .ensemble/runs/<id>/paused.json --answer ok=yes --answer tier=senior --by "agent"
```

One `--answer key=value` per question: an option name for a choice, `yes` or `no` for a noul, a level number for a
score. `paused.json` holds the questions under `pending.questions` and what the node was shown under `pending.asked`,
so read it before answering. An answer that does not fit is refused and nothing runs. The resumed run keeps the same
id and the same record.

Answer on someone's behalf only when they asked you to decide; otherwise show them the questions and ask.

## 7. Read the result

`.ensemble/runs/<id>/run.json`:

| Field | Meaning |
|---|---|
| `run.status` | `completed`, `failed`, `cancelled`, `budget` (hit its cap), `maxSteps`, or `paused` |
| `run.cost.total` | USD for the whole run |
| `steps[].took` | The edge id taken; join it to `graph.json` `edges[].id` to see the condition |
| `steps[].answers` | For a decide node: `value`, `confidence`, and the full `probabilities` |
| `steps[].asked` | What the node was given, which for a decide node is exactly what Jev saw |
| `steps[].error` | Why a step failed |
| `state` | The final state; `state[<result key>]` is what the run returned |

To explain why a run took a branch, read the decide step before it: its answer and confidence, then the edge it took.
Do not re-run to find out. For patterns across many runs, and for tuning a threshold, use the `ensemble-runs` skill.
To show a person, `npx ensemble view` serves one read-only page of the runs here (finished and live) at
http://127.0.0.1:4400. You do not need it yourself: everything on that page is in `status --json` and `run.json`.

## 8. Change a runner

1. Edit the file.
2. `npx ensemble validate` it, and fix what it lists.
3. Dry-run with `--explore` so every branch, including the new one, has been walked.
4. Make one paid run with a budget, and read its record.

What to know when changing one:

- **The graph has a hash.** Any change to nodes, edges or questions changes it, and the runs after that count as a new
  version of the runner. Old records keep the graph they ran with, in their own `graph.json`.
- **A paused run cannot be resumed on a changed graph.** `resume` refuses, naming both hashes. Answer waiting runs
  before you change the graph, or start them again after.
- **Adding an option to a choice needs an edge for it,** or `validate` reports the option as unwired.
- **A new state key needs an origin.** If a node reads it, something earlier must write it or it must be in `inputs`.
- **Changing a handler's side effect is not visible to `validate`.** The dry-run executes handlers for real, so point
  them at something safe first.

## 9. The same, against a hosted runner (MCP)

When the runner is hosted, you have tools instead of commands. You cannot see or edit the file; you can run, watch
and steer.

| Tool | Arguments | Returns |
|---|---|---|
| `<runner name>` | the runner's inputs, e.g. `{ "goal": "…" }` | The result as text, and `structuredContent` with `status`, `result`, and `run` (cost, and each step with its edge and answers) |
| `start_run` | `{ "runner": "<name>", "inputs": { … } }` | `{ "run": "<id>", "status": "running" }`, at once |
| `get_run` | `{ "run": "<id>" }` | The run as it stands: `status`, `running`, `steps`, `state`, `cost`, and `result` or `pending` |
| `list_runs` | `{ "runner"?, "limit"? }` | Recent runs, newest first |
| `cancel_run` | `{ "run": "<id>" }` | The run after it stopped |
| `answer` | `{ "resume": "<token>", "answers": { key: value }, "comment"? }` | The result of the resumed run |

- Call the runner's own tool when you only want the answer. Use `start_run` then `get_run` when you want to follow it
  or might stop it.
- A run that pauses reports `status: "paused"` with `pending.questions` and a `resume` token. Pass that token to
  `answer` with one value per question: an option name, `true` or `false`, or a level number.
- Some hosts offer only the runner tools and `answer`. If `start_run` is not in your tool list, you can run and
  answer but not watch.
- `isError: true` means the run failed or stopped at its budget; the text says which, and `structuredContent.run`
  shows where.

## When something is off

| You see | It means | Do |
|---|---|---|
| `validate` lists problems | The graph is not sound | Apply each named fix, re-run `validate` |
| `<model> spent its N tokens reasoning and wrote no answer` | The model thought its whole allowance away | Raise `maxTokens` on that node, or set `reasoning: "low"` |
| Status `budget` | The run cost more than `--budget` | Raise it, or find the expensive step in `steps[].cost` |
| Status `maxSteps` | A loop did not end within 50 steps | Put `maxLoops` on the edge that loops back |
| `the graph changed since this run paused` | The file was edited after the pause | Resume with the old file, or start a new run |
| `no live run "<id>"` | It already ended | `npx ensemble status` and read its record |
| `was told to stop and has not yet` | A handler is ignoring its `signal` | Pass `signal` to the handler's `fetch` or check it in its loop |
| `no OpenRouter key` | `OPENROUTER_API_KEY` is not set | Ask the person to set it; it is the only key |

## Related skills

- `ensemble-build`: from a use case to a validated, dry-run runner, with the full API reference.
- `ensemble-questions`: designing choice, score and noul questions and their thresholds.
- `ensemble-runs`: reading many runs, calibrating a decision against labelled cases, long-lived supervised loops.
- `ensemble-serve`: hosting runners for other callers over MCP or A2A.
