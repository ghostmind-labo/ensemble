# MCP: an agent offered as a tool

Some agents are published as an MCP server with one tool: you call the tool with a
request, the agent does its work on the other side, and the tool's result is the reply.
Ensemble already speaks MCP, so this needs no second protocol.

Use it when the agent's owner offers it this way. With a remote server it is one of the
two ways that run in hosted ensemble. [Agents](agents.md) compares the four ways and
holds what is common to all of them.

## A complete runner

This one uses `agento mcp`, the Ghostmind agent served as an MCP server on stdio
(`npm i -g @ghostmind-dev/agento`, 0.4.0 or later; it needs `OPENROUTER_API_KEY` in the
environment and nothing else).

```ts
import { noul, runner } from "@ghostmind-dev/ensemble";

export default runner({
  name: "ask-over-mcp",
  inputs: ["goal"],

  mcpServers: {
    // An agent takes longer than a tool: raise the server's 30-second default.
    agento: { command: "agento", args: ["mcp"], timeoutMs: 300_000 },
  },
  agents: {
    helper: { protocol: "mcp", server: "agento", tool: "run_task" },
  },

  nodes: {
    ask: { agent: "helper", reads: ["goal"], writes: ["analysis", "detail"] },
    review: { decide: { useful: noul("Does the analysis answer the request?") }, reads: ["goal", "analysis"] },
    deliver: { code: (s) => String(s.analysis), reads: ["analysis"], writes: ["final"] },
    escalate: { code: () => "A person will look at this.", writes: ["final"] },
  },
  edges: [
    { from: "ask", to: "review" },
    { from: "review", to: "deliver", on: "useful" },
    { from: "review", to: "escalate", on: "!useful" },
  ],
  entry: "ask",
  result: "final",
});
```

A remote server is declared by `url` instead, and everything else is the same:

```ts
mcpServers: { agents: { url: "https://mcp.example.com/mcp", timeoutMs: 300_000 } },
agents: { analyst: { protocol: "mcp", server: "agents", tool: "ask_analyst", input: "question" } },
```

## Options

The agent's declaration:

| Field | What it is | Default |
|---|---|---|
| `protocol` | `"mcp"` | required |
| `server` | A key of the runner's `mcpServers` | required |
| `tool` | The tool that IS the agent | required |
| `input` | The argument the message goes in | `"prompt"` |
| `args` | Other arguments, sent as written | none |

Everything about reaching the server is on its `mcpServers` entry, as for any MCP
server: `command` and `args` (a local process) or `url` (a remote one), `headers`,
`auth`, and `timeoutMs`. **`timeoutMs` is 30 seconds by default and bounds the whole
call**, so raise it for an agent.

The tool's text content lands on the first write key. With a second key, the detail is
`{ status: "completed", artifacts: [], toolCalls: [], permissions: [], data? }`, where
`data` is the tool's `structuredContent`. A tool result with `isError: true` fails the
step.

Find the tool and its argument names with the server's own listing:
`npx ensemble servers <query>` for the registry, and
`toolOptions(await session.listTools())` in code.

## `agento mcp`

| | |
|---|---|
| Tool | `run_task` |
| Arguments | `prompt` (required); optional `cwd`, `model`, `max_usd` |
| Result text | The answer |
| `structuredContent` | `{ status, reason, steps, toolCalls, cost, model }`, with `cost` in USD |
| An unfinished run | Comes back with `isError: true`, so the step fails |
| Safe by default | **Read-only**: the write and shell tools are not even offered, unless the server is started with `--yes` or `--allow-shell <word>`. `--no-web` leaves its web tools out |

```ts
mcpServers: { agento: { command: "agento", args: ["mcp"], timeoutMs: 300_000 } },
agents: { helper: { protocol: "mcp", server: "agento", tool: "run_task", args: { max_usd: 0.05 } } },
```

To use what the agent reported, read it out of the detail in a `code` node:

```ts
spent: { code: (s) => Number(s.detail?.data?.cost ?? 0), reads: ["detail"], writes: ["agent_cost"] },
```

> Status: `agento mcp` shipped in agento 0.4.0. Its tool listing was read through
> ensemble's MCP client (`run_task`, with the arguments above). A task was not run
> through it, so the rest of the table comes from the published package.

## Cost

MCP has no field for what a call cost, so the step records `meta.cost: "unknown"`, adds
0 to the run's total, and the run's budget does not see the agent's spend
([the cost rule](agents.md#cost)). This holds even when the tool returns a cost of its
own, as `agento mcp` does in `structuredContent.cost`: that number lands in the detail's
`data` and is yours to read, and ensemble does not count it. Bound the agent with the
server's `timeoutMs`, the tool's own cap (`max_usd`) and `maxLoops` on the retry edge.

## What lands in `graph.json` and `run.json`

The agent node of the runner above (`npx ensemble graph runner.mts`):

```json
{
  "id": "ask",
  "kind": "agent",
  "cost": "metered",
  "reads": ["goal"],
  "writes": ["analysis", "detail"],
  "agent": {
    "name": "helper",
    "protocol": "mcp",
    "server": "agento",
    "tool": "run_task",
    "prompt": { "reads": ["goal"] }
  }
}
```

In `run.json` the step has the [common shape](agents.md#what-lands-in-runjson), with
`meta.at` as `<server>/<tool>`, `meta.served` as `{ "server", "tool" }`,
`meta.status: "completed"` and `meta.cost: "unknown"`. There are no `toolCalls` or
`permissions`: what the agent did on the other side is not reported through MCP, except
in whatever the tool puts in `structuredContent`.

## Agent node or `mcp` node

The same call can be written as a plain `mcp` node:

```ts
analyse: {
  mcp: { server: "agento", tool: "run_task" },
  args: (s) => ({ prompt: s.goal, max_usd: 0.05 }),
  reads: ["goal"],
  writes: ["analysis", "analysis_data"],
}
```

Both make exactly one `tools/call`. Choose the `agent` node when you want `graph.json`
and `run.json` to show a delegation (`kind: "agent"`, the agent's name, the message that
was sent). Choose the `mcp` node when the tool takes several arguments you want to
build from the state.

## Auth and secrets

Everything is the server's: the `mcpServers` entry carries the transport, the headers,
the auth mode and the `${NAME}` secrets, exactly as for any other MCP server, and a
login is `npx ensemble mcp login <server>`.

## When it fails

| The message says | What happened | Fix |
|---|---|---|
| `agent "x" needs server — a key of the runner's mcpServers` / `needs tool — the name of the tool that IS the agent` (validate) | A field is missing | Add it |
| `agent "x" uses MCP server "s", which the runner does not declare` (validate) | No `mcpServers.s`, or a typo (the message lists `Declared:`) | Declare the server, or fix the name |
| `MCP server "s" is a local process (stdio): it cannot start in the cloud, use a remote server (url)` (hosted `check`, a warning) | The runner is in hosted ensemble | A remote server |
| `mcp "s": tools/call timed out after 30000ms` | The agent took longer than the server's `timeoutMs` | Raise `timeoutMs` on the `mcpServers` entry |
| `agent "x": the tool s/t failed: …` | The tool returned `isError: true`. For `agento mcp`: an unfinished run, or `OPENROUTER_API_KEY is not set in the agento server's environment` | The text after the colon is the tool's own |
| `mcp "s": needs NAME, which is not set` | A `${NAME}` on the server did not resolve | Set it in the environment. In hosted ensemble it cannot be set yet |
| `mcp "s": needs a login — run: npx ensemble mcp login s --url …` | An OAuth server with no stored login | Run that command once |

## Limits

- One tool call. An MCP server that expects several calls in a conversation is not an
  agent in this sense; use an `mcp` node per call.
- A tool's progress notifications and elicitation requests are not used.
- Text in. Images and files are not sent.

## In hosted ensemble

It works when the server is remote (`url`) and needs no credentials. A server started
as a local process, such as `agento mcp`, cannot start there, and `check` warns about
it ([the full table](agents.md#in-hosted-ensemble)). A hosted agento with a remote MCP
endpoint is in progress and not live ([status](agents.md#status-2026-10-03)).
