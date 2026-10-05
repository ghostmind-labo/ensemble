# Runners as MCP tools

`@ghostmind-dev/ensemble/mcp` exposes ensemble runners as [Model Context Protocol](https://modelcontextprotocol.io) tools, so anything
that speaks MCP (Claude, an IDE, another agent) can call them. One runner is one tool.

It is a separate entry point of the package, like [the A2A one](serve-a2a.md): the core never imports it, so a project
that only calls `runner()` loads no server code. It has no dependencies. Nothing in a runner changes; the adapter
listens to each run from outside.

The caller can only **call** the runners this process was started with. It cannot create or edit one, so no sandbox is
involved: it is your code, on your machine or server.

## Over stdio (a local client)

```sh
npx ensemble serve mcp triage.mts
```

In Claude Code: `claude mcp add triage -- npx ensemble serve mcp /path/to/triage.mts`, run from the project that installed the package. The server reads
`OPENROUTER_API_KEY` from its environment, like any run. Whatever a handler logs goes to stderr, because stdout carries
protocol messages only.

## Over HTTP

```sh
npx ensemble serve mcp triage.mts refunds.mts --port 4321 --token "$MCP_TOKEN"     # POST http://127.0.0.1:4321/mcp
```

Or inside your own server, since `mcpTools(...)` returns a plain `(req, res)` handler:

```ts
import express from "express";
import { mcpTools } from "@ghostmind-dev/ensemble/mcp";
import { a2aAgent } from "@ghostmind-dev/ensemble/a2a";
import triage from "./triage.mts";
import refunds from "./refunds.mts";

const app = express();
app.use("/mcp", mcpTools([triage, refunds], { token: process.env.MCP_TOKEN, budget: 0.05 }).handler);
app.use("/agents/triage", a2aAgent(triage).handler);      // the same runner, as an A2A agent
app.listen(3000);
```

| Option | What it does |
|---|---|
| `--port`, `--host` | Serve over HTTP at `/mcp` instead of stdio. Default host `127.0.0.1` |
| `--token`, or `MCP_TOKEN` | Require `Authorization: Bearer <token>`. Put your own auth middleware in front for anything richer |
| `--budget <usd>` | Cap on each call |
| `--secret`, or `MCP_SECRET` | The key paused runs are sealed with. Without it a restart forgets paused runs |

In code there are also `pauseTtlMs` (24 hours), `allowedOrigins`, and `run`, passed to every run: a `stepTimeout`, a
`secretResolver`, a stub `decider` in a test.

## What maps to what

| MCP | The runner |
|---|---|
| A tool | A runner: the tool's name is the runner's, its arguments are the runner's inputs |
| The text result | The runner's `result` |
| `structuredContent` | `status`, `result`, and `run`: the run id, graph hash, cost, and each step with the edge it took and its answers and confidence |
| `notifications/progress` | One as each node starts and ends, when the caller sent a `progressToken` |
| An elicitation form | A `by: "human"` pause: a choice is an enum, a noul a boolean, a score a level number |
| The caller hanging up (HTTP), `notifications/cancelled` (stdio) | The run's `AbortSignal`, which reaches every handler |
| `isError: true` | The run failed, or stopped at its budget or step limit |

## A pause

A `by: "human"` node stops the run and asks its closed questions. How depends on the caller:

- **A caller that can show forms** (the current protocol revision, with the elicitation capability) gets
  `input_required` with a form. The person fills it in, the client sends the same call again, and the run resumes.
- **Any other caller** gets a normal result that says the run is waiting, with the questions and a `resume` token. It
  answers by calling the `answer` tool with that token. The tool exists only when a served runner can pause.

Either way the server remembers nothing. The paused run travels to the caller and back as an encrypted, authenticated
token, so the caller cannot read or alter the state, and any instance started with the same `--secret` can resume it.
An answer that does not fit the questions runs nothing and asks again, with the reason.

## Several instances (Kubernetes, serverless)

The server keeps nothing between requests, so it runs behind a load balancer or scales to zero with one condition:
**every instance needs the same `secret`**. A paused run is sealed with it, and an instance with a different key
cannot open what another one sealed. Without a `secret` each process invents its own, which is only right for a
single instance.

```ts
app.use("/mcp", mcpTools([triage, refunds], { secret: process.env.MCP_SECRET, token: process.env.MCP_TOKEN }).handler);
```

Two things to plan for:

- A call runs to completion on the instance that received it, so the run must fit within the platform's request
  timeout. Progress notifications need a connection that can stream.
- On a platform without Node's `(req, res)`, call `handle(message, { signal })` yourself: it takes one JSON-RPC
  message and returns `{ status, body }`, with no transport in it.

## Shutting down

`ensemble serve mcp --port …` drains on SIGTERM or Ctrl-C: new calls are refused with `503` and `Retry-After` (so the
caller or a load balancer tries another instance), calls in flight return their result, and whatever is still running
after the grace period (25 s by default, `--grace <seconds>`) is stopped and returns `isError` with status
`cancelled`. In your own server, call `drain()` from your signal handler:

```ts
const tools = mcpTools([triage], { secret: process.env.MCP_SECRET });
process.on("SIGTERM", () => void tools.drain(25_000).then(() => process.exit(0)));
```

## Protocol revisions

MCP changed shape in revision `2026-07-28`: no `initialize` handshake, no sessions, metadata on every request, and
server questions carried inside results. This adapter speaks that revision and the handshake-based ones before it
(`2025-11-25` back to `2024-11-05`), choosing per request by how the caller opens.

## Limits

- Tools only: no resources, prompts, subscriptions or the tasks extension.
- No OAuth. A bearer token, or your own middleware.
- The token is one shared secret: a paused run is not bound to a user.
- A caller's own budget cannot be passed; the cap is the server's.
- The old HTTP+SSE transport (2024-11-05) is not served, only Streamable HTTP and stdio.

Tested offline in `test/mcp-serve.test.mts`, against the library's own MCP client and against the wire in the current
revision.
