---
name: ensemble-serve
description: Make an ensemble runner callable from outside its own script, and call one that is. Covers serving runners as MCP tools (so Claude, an IDE or any MCP client can call them), serving a runner as an A2A agent (so another agent can send it a goal, watch each node, answer its questions and cancel it), mounting both in an existing Node or Express server, tokens and budgets, how a paused `by: "human"` run is answered over each protocol, and viewing runs in a browser with ensemble-view. Use this whenever someone wants a runner exposed as an agent, a tool, an endpoint or a service, wants Claude or another agent to call or supervise a runner, asks about A2A, Agent2Agent, an agent card, MCP tools, `ensemble serve`, `@ghostmind-dev/ensemble/mcp` or `/a2a`, or wants to watch or review runs visually.
---

# Serving a runner

A runner is a function: one input, one output. The same runner, unchanged, can also be reached from outside its
script. Nothing in the runner is edited for this, and no node knows it is being served.

| Way in | Reach for it when | How |
|---|---|---|
| A function | Your own code calls it | `await triage({ goal })` |
| The CLI | A person or a shell script runs it once | `npx ensemble run triage.mts "goal"` |
| **MCP tools** | Claude, an IDE or any assistant should call it | `npx ensemble serve mcp triage.mts` |
| **An A2A agent** | Another agent should delegate to it and supervise the run | `npx ensemble serve a2a triage.mts` |

Start with the plain call. Serve only when something outside the script has to reach the runner.

Before serving, the runner must validate (`npm run validate -- <file>`): a runner with problems is refused at start,
with the problems listed. Starting a server is free. Every call or task is a real run with real costs, so set a budget.

## As MCP tools

One runner is one tool. Its name is the runner's `name`, its arguments are the runner's `inputs`, and several runners
can share one server.

```sh
npx ensemble serve mcp triage.mts refunds.mts                         # stdio, for a local client
npx ensemble serve mcp triage.mts --port 4321 --token "$MCP_TOKEN"    # HTTP, at /mcp
```

To let Claude Code call it, run this in the project that installed the library:

```sh
claude mcp add triage -- npx ensemble serve mcp ./triage.mts
```

The process needs `OPENROUTER_API_KEY` in its environment, like any run.

A call returns the runner's result as text, plus structured content holding `status`, `result` and `run`: the run id,
the cost, and every step with the edge it took and its answers with confidence. Read `run.steps` to explain a
decision; do not re-ask the runner.

The caller can only call the runners the server was started with. It cannot create or edit one.

## As an A2A agent

One runner is one agent, with an agent card derived from its graph.

```sh
npx ensemble serve a2a triage.mts --port 4320 --budget 0.05
# card: http://127.0.0.1:4320/.well-known/agent-card.json
npx ensemble agents card http://127.0.0.1:4320        # read it back
```

What the calling agent gets:

- **Progress.** With `SendStreamingMessage`, one status update as each node starts and ends. `metadata.ensemble`
  carries the node, the edge it took, its cost and its answers.
- **State.** `GetTask` returns the task; its `history` has one message per finished step.
- **Steering.** A `by: "human"` node becomes `input-required`. The caller answers by sending a message with the same
  `taskId`.
- **Stop.** `CancelTask` aborts the run, and the abort reaches every handler.
- **Cost.** In the task's `metadata.ensemble`, since A2A has no field for it.

Another ensemble runner can delegate to it with an `agent` node:
`agents: { triage: { protocol: "a2a", url: "http://localhost:4320" } }`. That works for a runner that does not pause;
the `agent` node cannot answer `input-required`.

## Inside an existing server

Both are plain `(req, res)` handlers, so they mount in anything built on `node:http`:

```ts
import express from "express";
import { mcpTools } from "@ghostmind-dev/ensemble/mcp";
import { a2aAgent } from "@ghostmind-dev/ensemble/a2a";
import triage from "./triage.mts";

const app = express();
app.use("/mcp", mcpTools([triage], { token: process.env.MCP_TOKEN, budget: 0.05 }).handler);
app.use("/agents/triage", a2aAgent(triage, { budget: 0.05 }).handler);
```

Put your own auth middleware in front for anything beyond one shared token. Both take `run`, passed to every run
(`stepTimeout`, `secretResolver`, a stub `decider` in a test).

## Letting the caller steer

A caller can steer a run only where the graph declares a pause: a decide node with `by: "human"`. It answers the same
closed questions a person would. So to give a calling agent a say, add such a node at the point where its judgement
matters, and route on the answer like any other decision.

| Over | A pause looks like | The caller answers with |
|---|---|---|
| MCP, a client that shows forms | A form: a choice is a dropdown, a noul a checkbox, a score a number | Filling it in; the client sends the call again |
| MCP, any other client | A result saying the run is waiting, with a `resume` token | The `answer` tool: `{ resume, answers: { key: value } }` |
| A2A | `input-required`, with the questions in the status message | A message with the same `taskId`: the value alone for one question, `key=value` per line for several |

An answer that does not fit the questions runs nothing: the caller is asked again, with the reason. A caller cannot
write state at any other moment.

For MCP over HTTP, pass `--secret` (or `MCP_SECRET`) so a paused run survives a restart: the paused run travels to the
caller and back as a token sealed with that key.

## Watching runs

Every run writes `run.json` and `graph.json` under `.ensemble/runs/<id>/`, however it was called. To look at them in
a browser, from the project folder:

```sh
npx @ghostmind-dev/ensemble-view
```

It lists runs and runners, draws each graph with the path a run took, and shows each step's answers and confidence.
It is read-only and loads no runner. For numbers across many runs, or to tune a decision, use the `ensemble-runs`
skill.

## When something is off

| Symptom | Cause | Fix |
|---|---|---|
| `does not validate, so it is not served` | The runner has problems | Fix what `npm run validate` lists |
| `cannot be a tool` | The runner's name has a space or symbol | Rename it: letters, digits, `_`, `-`, `.` |
| `a runner named "answer" cannot be served` | That name is the tool that answers a pause | Rename the runner |
| `the paused run cannot be resumed` | The token expired, or the server restarted without `--secret` | Call the tool again from the start; set a secret |
| MCP client shows garbage on stdio | Something wrote to stdout | Handlers must log with `console.log` or to stderr, not `process.stdout.write` |
| `401` | A token is set on the server | Send `Authorization: Bearer <token>` |
| A task ends `failed` with "stopped at its budget" | The run cost more than `--budget` | Raise it, or make the runner cheaper |

Full details: `docs/serve-mcp.md` and `docs/serve-a2a.md` in the library's repository.
