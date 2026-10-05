# A runner as an A2A agent

`@ghostmind-dev/ensemble/a2a` is a connector that exposes any ensemble runner as an
[Agent2Agent](https://a2a-protocol.org) agent (protocol 1.0, JSON-RPC, streaming). Another agent sends it a goal, watches where it is, answers when it asks, and can stop it.

It is a separate entry point of the package: the core never imports it, so a project that only calls `runner()` loads
no server code. It has no dependencies (`node:http`). Nothing in the runner changes and no node knows about it; the
adapter listens to the run from outside.

## Mounting it

`a2aAgent(runner)` returns a plain `(req, res)` handler, so it mounts in anything built on `node:http`:

```ts
import express from "express";
import { a2aAgent } from "@ghostmind-dev/ensemble/a2a";
import triage from "./triage.mts";

const app = express();
app.use("/agents/triage", requireSignIn, a2aAgent(triage, { budget: 0.05 }).handler);
app.listen(3000);
// card:  http://localhost:3000/agents/triage/.well-known/agent-card.json
```

A body parser in front of it (`express.json()`) is fine. There is no command for this: an A2A agent is reached over
HTTP, and the server is yours.

| Option | What it does |
|---|---|
| `budget` | USD cap on each task. A caller may ask for less (`metadata.budget`), never more |
| `publicUrl` | The address callers reach it at, written in the card. Default: the request's host and mount path |
| `card` | Merged into the agent card. Declare your server's sign-in here (`securitySchemes`, `securityRequirements`) |
| `store` | Where tasks are kept. Memory by default; a shared one for several instances (below) |
| `run` | Passed to every run: a `stepTimeout`, a `secretResolver`, a stub `decider` in a test |

Mounting costs nothing. Each task is a real run of the runner, with its real costs.

## Sign-in

The adapter authenticates nobody: `requireSignIn` above is yours, and the handler should not be exposed without it.
What it does for you is tell callers: put your scheme in `card` and it is published in the agent card.

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

## Several instances (Kubernetes, a load balancer)

Give every instance the same store, and any of them can report on, answer or cancel a task another one ran:

```ts
import { createClient } from "redis";
import { a2aAgent, type TaskStore } from "@ghostmind-dev/ensemble/a2a";

const redis = await createClient({ url: process.env.REDIS_URL }).connect();
const store: TaskStore = {
  get: async (key) => JSON.parse((await redis.get(key)) ?? "null") ?? undefined,
  set: async (key, value) => void (await redis.set(key, JSON.stringify(value), { EX: 7 * 86_400 })),
  delete: async (key) => void (await redis.del(key)),
};

app.use("/agents/triage", a2aAgent(triage, { store }).handler);
```

The store is three methods over JSON, so a database table works the same way. How long a task is kept, including a
paused one waiting for its answer, is the store's expiry.

| What happens | How it works across instances |
|---|---|
| `GetTask` reaches another instance | It reads the task from the store, with the steps so far |
| The answer to a pause reaches another instance | That instance takes the paused run from the store and resumes it there |
| `CancelTask` reaches another instance | It leaves a mark in the store; the instance running the task sees it at its next node or heartbeat (10 s by default) and stops |
| The instance running a task dies | After 45 s without a heartbeat the task is reported `failed`, saying its instance stopped |
| A caller streaming loses its connection | The task keeps running; ask after it with `GetTask` |

A stream is served by the instance that received the request, so keep long-lived connections allowed at the ingress.

## Shutting down

When an instance is replaced (a deploy, a scale-down), stopping it should not drop the runs it is in the middle of.
Call `drain()` from your signal handler:

```ts
const agent = a2aAgent(triage, { store });
process.on("SIGTERM", () => void agent.drain(25_000).then(() => process.exit(0)));
```

| While draining | What happens |
|---|---|
| A new message or an answer to a pause | Refused with `503` and `Retry-After`, so the caller or the load balancer sends it to another instance |
| `GetTask`, `CancelTask` | Still answered |
| A run in flight | Finishes, or pauses, as it would have |
| A run still going after the grace period (25 s by default) | Stopped; its task is recorded as cancelled |

Set the grace period below what your platform allows a stopping instance.

## Limits

- With the default store, tasks live in this process's memory: a restart forgets them, and a second instance has
  never heard of them. Give it a shared store to change that (see below).
- A run executes on the instance that received it. If that instance dies without warning mid-run, the task is
  reported failed; it is not picked up by another. A planned stop drains first (see above).
- One runner per handler. Mount several handlers for several runners.
- No authentication of any kind. That belongs to the server the handler is mounted in.
- A2A 1.0 over JSON-RPC only: no 0.3 dialect, no HTTP+JSON binding, no push notifications.
- The library's own `agent` node cannot answer `input-required`, so a runner delegating to a pausing runner fails with
  a message naming the fix. A caller that can answer (another agent, your own code) is unaffected.
- The run's `human` option is not used: every `by: "human"` node pauses for the caller.

See also [runners as MCP tools](serve-mcp.md). Tested offline in `test/a2a-serve.test.mts`, against the library's own A2A client.
