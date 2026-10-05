# Runners over MCP

`@ghostmind-dev/ensemble/mcp` is a connector: it lets anything that speaks the
[Model Context Protocol](https://modelcontextprotocol.io) (Claude, an IDE, another agent) run your runners and, when
you ask for it, watch and steer the runs. One runner is one tool.

It is not a server and it authenticates nobody. It is a separate entry point of the package that the core never
imports, with no dependencies. Nothing in a runner changes; the connector listens to each run from outside.

The caller can only **call** the runners the connector was given. It cannot create or edit one, so no sandbox is
involved: it is your code.

## Which way to use it

| Where | How | Server and sign-in |
|---|---|---|
| On your machine, for an assistant that has no shell | `npx ensemble serve mcp triage.mts` (stdio) | None: the assistant starts it as a child process |
| Hosted | `mcpTools([triage]).handler` mounted in your own server | Yours: the handler sits behind whatever your server already has |

An assistant that can run commands does not need MCP locally: the CLI does the same things (`ensemble run`,
`status`, `stop`, `resume`). See the `ensemble` skill.

## On your machine (stdio)

```sh
npx ensemble serve mcp triage.mts refunds.mts
claude mcp add ensemble -- npx ensemble serve mcp ./triage.mts ./refunds.mts     # in Claude Code
```

The process needs `OPENROUTER_API_KEY` in its environment, like any run. Whatever a handler logs goes to stderr,
because stdout carries protocol messages only. Runs are recorded under `.ensemble/runs`, the folder `ensemble run`
writes, so the viewer and `ensemble status` see them too.

`--budget <usd>` caps each call, `--secret` (or `MCP_SECRET`) keeps paused runs resumable across a restart, and
`--grace <seconds>` is how long runs in flight get to finish on Ctrl-C or SIGTERM (default 25).

## Hosted (a handler in your server)

```ts
import express from "express";
import { mcpTools } from "@ghostmind-dev/ensemble/mcp";
import triage from "./triage.mts";
import refunds from "./refunds.mts";

const app = express();
app.use("/mcp", requireSignIn, mcpTools([triage, refunds], { budget: 0.05, secret: process.env.MCP_SECRET }).handler);
app.listen(3000);
```

`requireSignIn` is yours. The connector checks no credential, so do not expose the handler without one.

| Option | What it does |
|---|---|
| `budget` | USD cap on each call |
| `secret` | The key paused runs are sealed with. Every instance needs the same one |
| `runsDir` | Record every run there (`run.json`, `graph.json`), and let `get_run` and `list_runs` read it |
| `control` | Offer the tools that watch and steer runs (below) |
| `pauseTtlMs` | How long a paused run may wait for its answer. Default 24 hours |
| `allowedOrigins` | Origins a browser may call from, besides the server's own host |
| `run` | Passed to every run: a `stepTimeout`, a `secretResolver`, a stub `decider` in a test |

## The tools

| Tool | What it does |
|---|---|
| `<runner name>` | Runs that runner and waits. Arguments are the runner's inputs. Returns the result, and the record of the run |
| `answer` | Answers a run that stopped to ask. Present only when a runner can pause |
| `start_run` | Starts a runner and returns a run id at once, without waiting |
| `get_run` | A run as it stands: status, nodes in progress, finished steps with answers and confidence, the state so far, cost, and the result or the pending question |
| `list_runs` | Recent runs, newest first: this process's and those on disk |
| `cancel_run` | Stops a run that is still going |

The last four are offered with `control: true`, which `ensemble serve mcp` sets.

## What maps to what

| MCP | The runner |
|---|---|
| The text result | The runner's `result` |
| `structuredContent` | `status`, `result`, and `run`: the run id, graph hash, cost, and each step with the edge it took and its answers and confidence |
| `notifications/progress` | One as each node starts and ends, when the caller sent a `progressToken` |
| An elicitation form | A `by: "human"` pause: a choice is an enum, a noul a boolean, a score a level number |
| The caller hanging up (HTTP), `notifications/cancelled` (stdio), `cancel_run` | The run's `AbortSignal`, which reaches every handler |
| `isError: true` | The run failed, or stopped at its budget or step limit |

## A pause

A `by: "human"` node stops the run and asks its closed questions. How depends on the caller:

- **A caller that can show forms** (the current protocol revision, with the elicitation capability) gets
  `input_required` with a form. The person fills it in, the client sends the same call again, and the run resumes.
- **Any other caller** gets a normal result that says the run is waiting, with the questions and a `resume` token. It
  answers by calling `answer` with that token. A run begun with `start_run` shows the same token in `get_run`.

The paused run travels to the caller and back as an encrypted, authenticated token, so the caller cannot read or
alter the state, and any instance holding the same `secret` can resume it. An answer that does not fit the questions
runs nothing and asks again, with the reason.

## Several instances

A waited-for call and a pause keep nothing in the process, so they work behind a load balancer with one condition:
**every instance needs the same `secret`**.

The `control` tools are the exception. They track runs in the process's memory, so `get_run` and `cancel_run` only
see a run on the instance that started it. Use them with one instance (a local assistant), or serve the runner as an
[A2A agent](serve-a2a.md), which keeps tasks in a shared store.

A call runs to completion on the instance that received it, so it must fit the platform's request timeout. On a
platform without Node's `(req, res)`, call `handle(message, { signal })` yourself: one JSON-RPC message in,
`{ status, body }` out, with no transport in it.

## Shutting down

Call `drain()` from your signal handler: new calls are refused with `503` and `Retry-After` (so the caller or a load
balancer tries another instance), calls in flight return, and whatever is still running after the grace period is
stopped and reports `cancelled`.

```ts
const tools = mcpTools([triage], { secret: process.env.MCP_SECRET });
process.on("SIGTERM", () => void tools.drain(25_000).then(() => process.exit(0)));
```

## Protocol revisions

MCP changed shape in revision `2026-07-28`: no `initialize` handshake, no sessions, metadata on every request, and
server questions carried inside results. The connector speaks that revision and the handshake-based ones before it
(`2025-11-25` back to `2024-11-05`), choosing per request by how the caller opens.

## Limits

- Tools only: no resources, prompts, subscriptions or the tasks extension.
- No authentication of any kind. That belongs to the server the handler is mounted in.
- A paused run is not bound to a user: whoever holds the token can answer it.
- A caller's own budget cannot be passed; the cap is the host's.
- The old HTTP+SSE transport (2024-11-05) is not served, only Streamable HTTP and stdio.

Tested offline in `test/mcp-serve.test.mts`, against the library's own MCP client and against the wire in the current
revision.
