# A runner as an A2A agent

`@ghostmind-dev/ensemble/a2a` exposes any ensemble runner as an [Agent2Agent](https://a2a-protocol.org) agent (protocol 1.0, JSON-RPC,
streaming). Another agent sends it a goal, watches where it is, answers when it asks, and can stop it.

It is a separate entry point of the package: the core never imports it, so a project that only calls `runner()` loads
no server code. It has no dependencies (`node:http`). Nothing in the runner changes and no node knows about it; the
adapter listens to the run from outside.

## On its own port

```sh
npx ensemble serve a2a triage.mts --port 4320
```

| Option | What it does |
|---|---|
| `--port`, `--host` | Where to listen. Default `127.0.0.1:4320` |
| `--token`, or `A2A_TOKEN` | Require `Authorization: Bearer <token>`; the card declares it |
| `--budget <usd>` | Cap on each task. A caller may ask for less, never more |
| `--public-url` | The address callers reach it at, written in the card |

Starting it costs nothing. Each task is a real run of the runner, with its real costs.

## Inside your own server

`a2aAgent(runner)` returns a plain `(req, res)` handler, so it mounts in anything built on `node:http`:

```ts
import express from "express";
import { a2aAgent } from "@ghostmind-dev/ensemble/a2a";
import triage from "./triage.mts";

const app = express();
app.use("/agents/triage", a2aAgent(triage, { budget: 0.05 }).handler);
app.listen(3000);
// card:  http://localhost:3000/agents/triage/.well-known/agent-card.json
```

A body parser in front of it (`express.json()`) is fine. `serveRunner(runner, options)` is the same handler listening on
its own port. Both take `run`, passed to every run: a `stepTimeout`, a `secretResolver`, a stub `decider` in a test.

## What maps to what

| A2A | The runner |
|---|---|
| The agent card | `graph.json`: the name, the description, the inputs. Its `version` is the graph hash |
| A message's text | `goal` |
| A message's data part | The other declared inputs, e.g. `{ "amount": 40 }` |
| A status update, while working | A `RunEvent`. `metadata.ensemble` holds `event` (`node:start` or `node:end`), `node`, `kind`, `lane`, and on an end `took`, `ms`, `cost`, `answers`, and `meta` (what a handler passed to `report()`) |
| `input-required` | A `by: "human"` node paused. The status message lists the questions; `metadata.ensemble.pending` holds them as data |
| A message with that `taskId` | The answer. The run resumes in the same task |
| `CancelTask` | The run's `AbortSignal`, which reaches every handler |
| `GetTask` | The task as it is now. Its `history` holds what the caller sent and one message per finished step (text, plus the step as data), so polling shows as much as streaming. `historyLength` limits it |
| The artifact | The runner's `result`: text, plus a data part when it is not a string |
| `metadata.ensemble` on the task | The run id, the graph hash, the steps taken, and the cost. A2A has no field for cost, so it is here |

## Answering a pause

The caller can steer the run only where the graph declared a pause, with the same closed questions a person would get.

- One question: answer with the value alone (`yes`, an option name, a level number).
- Several: one `key=value` per line, or a data part `{ "answers": { "ok": true, "tier": "senior" } }`.

An answer that does not fit runs nothing: the task returns to `input-required` and says what was wrong.

## Limits

- Tasks live in memory. A restart forgets them, including a paused one.
- One runner per handler. Mount several handlers for several runners.
- A2A 1.0 over JSON-RPC only: no 0.3 dialect, no HTTP+JSON binding, no push notifications.
- The library's own `agent` node cannot answer `input-required`, so a runner delegating to a pausing runner fails with
  a message naming the fix. A caller that can answer (another agent, your own code) is unaffected.
- The run's `human` option is not used: every `by: "human"` node pauses for the caller.

See also [runners as MCP tools](serve-mcp.md). Tested offline in `test/a2a-serve.test.mts`, against the library's own A2A client.
