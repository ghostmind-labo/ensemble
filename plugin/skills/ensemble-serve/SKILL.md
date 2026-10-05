---
name: ensemble-serve
description: Host ensemble runners so callers outside your own code can reach them. Covers the two connectors, MCP (so Claude, an IDE or any assistant can call runners as tools) and A2A (so another agent can send a runner a goal, follow each node, answer its questions and cancel it), mounting them as handlers in an existing Node or Express server behind your own sign-in, budgets, what each caller sees, how a paused `by: "human"` run is answered over each protocol, running on several instances, and shutting down cleanly. Use this whenever someone wants a runner exposed as a tool, an agent, an endpoint or a service, asks about `@ghostmind-dev/ensemble/mcp` or `/a2a`, `mcpTools`, `a2aAgent`, an agent card, A2A or Agent2Agent, deploying runners behind a load balancer, or adding authentication in front of them. To run, watch or steer a runner yourself, use the `ensemble` skill instead.
---

# Hosting runners

A runner is a function. To let something outside your code call it, mount a **connector** in a server you already
have. A connector speaks one protocol and nothing else: it is not a server, and it authenticates nobody. The server
and the sign-in are yours.

| Connector | Import | The caller is | It gets |
|---|---|---|---|
| MCP | `mcpTools` from `@ghostmind-dev/ensemble/mcp` | An assistant (Claude, an IDE) | Each runner as a tool; optionally tools to start, watch and cancel runs |
| A2A | `a2aAgent` from `@ghostmind-dev/ensemble/a2a` | Another agent | One runner as an agent: a task it can follow, answer and cancel |

Nothing in a runner changes, and neither connector is loaded unless you import it. A runner must validate to be
mounted; one with problems is refused at start, with the problems listed.

```ts
import express from "express";
import { mcpTools } from "@ghostmind-dev/ensemble/mcp";
import { a2aAgent } from "@ghostmind-dev/ensemble/a2a";
import triage from "./triage.mts";
import refunds from "./refunds.mts";

const app = express();
app.use("/mcp", requireSignIn, mcpTools([triage, refunds], { budget: 0.05, secret: process.env.MCP_SECRET }).handler);
app.use("/agents/triage", requireSignIn, a2aAgent(triage, { budget: 0.05, store }).handler);
app.listen(3000);
```

Mounting is free. Every call or task is a real run with real costs, so set `budget`.

## Sign-in is yours

`requireSignIn` above is your middleware. The connectors check no credential, so never expose a handler without one.

- **MCP:** a client that signs in with OAuth expects your server to publish protected-resource metadata and answer
  `401` pointing to your authorization server. That is your server's job, in front of the handler.
- **A2A:** put your scheme in the `card` option (`securitySchemes`, `securityRequirements`) and it is published in the
  agent card, so callers know what to send.

## Locally there is nothing to host

An assistant on the same machine does not need a server:

- **With a shell,** it uses the CLI: `ensemble run`, `status`, `stop`, `resume`. That is the `ensemble` skill.
- **Without one,** `npx ensemble serve mcp triage.mts` offers the same over stdio. The assistant starts it as a
  child process, so there is no port and nothing to authenticate. In Claude Code:
  `claude mcp add ensemble -- npx ensemble serve mcp ./triage.mts`.

## What an MCP caller gets

| Tool | What it does |
|---|---|
| `<runner name>` | Runs it and waits. Returns the result, and `structuredContent` with the run's cost and each step's edge, answers and confidence |
| `answer` | Answers a run that paused. Present only when a runner can pause |
| `start_run`, `get_run`, `list_runs`, `cancel_run` | Start without waiting, read a run as it stands, list runs, stop one. Offered with `control: true` |

Set `runsDir` to record every run as `run.json` and `graph.json`, the layout `ensemble run` writes; `get_run` and
`list_runs` then also find runs from earlier processes.

## What an A2A caller gets

- **A card** at `<mount>/.well-known/agent-card.json`, derived from the graph: the name, the description, the inputs.
- **Progress:** with `SendStreamingMessage`, a status update as each node starts and ends. `metadata.ensemble` carries
  the node, the edge it took, its cost and its answers.
- **State:** `GetTask` returns the task; its `history` has one message per finished step.
- **Stop:** `CancelTask` aborts the run, and the abort reaches every handler.
- **Cost:** in the task's `metadata.ensemble`, since A2A has no field for it.

Another ensemble runner can delegate to it with an `agent` node:
`agents: { triage: { protocol: "a2a", url: "https://example.com/agents/triage" } }`. That works for a runner that
does not pause; the `agent` node cannot answer `input-required`.

## Letting the caller steer

A caller can steer a run only where the graph declares a pause: a decide node with `by: "human"`. It answers the same
closed questions a person would. To give a calling agent a say, add such a node where its judgement matters and route
on the answer like any other decision. A caller cannot write state at any other moment.

| Over | A pause looks like | The caller answers with |
|---|---|---|
| MCP, a client that shows forms | A form: a choice is a dropdown, a noul a checkbox, a score a number | Filling it in; the client sends the call again |
| MCP, any other client | A result saying the run is waiting, with a `resume` token | The `answer` tool: `{ resume, answers: { key: value } }` |
| A2A | `input-required`, with the questions in the status message | A message with the same `taskId`: the value alone for one question, `key=value` per line for several |

An answer that does not fit the questions runs nothing: the caller is asked again, with the reason.

## More than one instance

Behind a load balancer a request may reach any instance, so nothing a second instance needs may live in one
instance's memory.

| | What to share | What then works across instances |
|---|---|---|
| MCP | The same `secret` on every instance | A waited-for call, and answering a pause: the paused run travels with the caller as a sealed token |
| A2A | The same `store` (three methods over JSON: `get`, `set`, `delete`; Redis or a table) | Status checks, answers and cancels for a task any instance ran |

Two limits:

- **MCP's `control` tools are single-instance.** They track runs in memory, so `get_run` and `cancel_run` only see a
  run on the instance that started it. With several instances, use A2A for runs that must be followed.
- **A run executes on the instance that received it,** so it must fit the platform's request timeout. If that
  instance dies without warning mid-run, the run is lost and an A2A task reports `failed`.

## Shutting down

Call `drain()` on each connector from your signal handler, so a deploy does not drop runs in flight:

```ts
const tools = mcpTools([triage], { secret: process.env.MCP_SECRET });
const agent = a2aAgent(triage, { store });
process.on("SIGTERM", () => void Promise.all([tools.drain(25_000), agent.drain(25_000)]).then(() => process.exit(0)));
```

New work is refused with `503` and `Retry-After` so it goes to another instance, status checks and cancels are still
answered, runs in flight finish, and whatever outlives the grace period is stopped and recorded as cancelled.

## When something is off

| Symptom | Cause | Fix |
|---|---|---|
| `does not validate, so it is not served` | The runner has problems | Fix what `npx ensemble validate` lists |
| `cannot be a tool` | The runner's name has a space or symbol | Rename it: letters, digits, `_`, `-`, `.` |
| `a runner named "answer" cannot be served`, or `one of the connector's own tools` | The name is reserved | Rename the runner |
| `the paused run cannot be resumed` | The token expired, or another instance has a different `secret` | Give every instance the same `secret`; the caller starts again |
| `Task not found` on another instance | A2A is using the default in-memory store | Pass a shared `store` |
| `503`, "shutting down" | The instance is draining | Send it again; the load balancer picks another |
| An MCP client shows garbage over stdio | Something wrote to stdout | Log with `console.log` (redirected to stderr) or to stderr, never `process.stdout.write` |
| A task ends `failed` with "stopped at its budget" | The run cost more than `budget` | Raise it, or make the runner cheaper |

Full details: `docs/serve-mcp.md` and `docs/serve-a2a.md` in the library's repository.
