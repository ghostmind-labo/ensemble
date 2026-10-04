# Runners as MCP tools

`serve.mts` exposes ensemble runners as [Model Context Protocol](https://modelcontextprotocol.io) tools, so anything
that speaks MCP (Claude, an IDE, another agent) can call them. One runner is one tool.

It is an adapter beside the library, like [`a2a/`](../a2a/README.md), and not part of the npm package: the library
itself still serves nothing. It has no dependencies. Nothing in a runner changes; the adapter listens to each run from
outside.

The caller can only **call** the runners this process was started with. It cannot create or edit one, so no sandbox is
involved: it is your code, on your machine or server.

## Over stdio (a local client)

```sh
node mcp/serve.mts examples/01-triage/triage.mts
```

In Claude Code: `claude mcp add triage -- node /path/to/mcp/serve.mts /path/to/triage.mts`. The server reads
`OPENROUTER_API_KEY` from its environment, like any run. Whatever a handler logs goes to stderr, because stdout carries
protocol messages only.

## Over HTTP

```sh
node mcp/serve.mts triage.mts refunds.mts --port 4321 --token "$MCP_TOKEN"     # POST http://127.0.0.1:4321/mcp
```

Or inside your own server, since `mcpTools(...)` returns a plain `(req, res)` handler:

```ts
import express from "express";
import { mcpTools } from "./mcp/serve.mts";
import { a2aAgent } from "./a2a/serve.mts";
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
