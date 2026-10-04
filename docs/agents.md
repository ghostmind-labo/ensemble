# Agents

An ensemble graph can hand one step to an agent: a program with its own model, its own
tools and its own loop. Ensemble still runs no loop of its own. What it adds is everything
around the hand-off: a `decide` node that routes to the agent only when one is needed, a
deadline that reaches it, a record of what it was asked and what it did, and a second
`decide` node that judges the reply. The agent never grades its own work.

This page is the place to start, and for most uses the place to stop. Each way has its
own page with a complete runner, every option and every failure message.

## The four ways

Three are industry standards and are **declared** in the runner, so `graph.json` names
the agent and the protocol. The fourth runs an agent library inside your own handler.

| | [A2A](agents-a2a.md) | [ACP](agents-acp.md) | [MCP](agents-mcp.md) | [In-process](agent.md) |
|---|---|---|---|---|
| **Where the agent runs** | On someone's server, reached by URL | On this machine, as a child process started for one turn | Behind an MCP server (remote, or a local process), as one tool | Inside your own `work` handler, in the runner's process |
| **Declared as** | `{ protocol: "a2a", url }` | `{ protocol: "acp", command, args }` | `{ protocol: "mcp", server, tool }` | A `work` handler (not in `agents`) |
| **What you need installed** | Nothing | The agent's command, on PATH (`opencode`, `agento`) | Nothing for a remote server; the server's command for a local one | The agent library (`npm i @ghostmind-dev/agento`, or any SDK) |
| **Local library** | Yes | Yes | Yes | Yes |
| **Hosted ensemble** | Yes, to a public agent that needs no credentials | No | Yes, on a remote server that needs no credentials | No |
| **Cost in `run.json`** | Always `"unknown"`: A2A has no cost field | `"reported"` when the agent sends `usage_update` in USD, else `"unknown"` | Always `"unknown"`: MCP has no cost field | What your handler passes to `report({ cost })` |
| **What can go wrong** | No card at the address; the task stops to ask a question; a spend the run's budget does not see | The agent acts on your machine without asking (see the safety rule); the command is missing; the agent wants a login | The server's 30 s default timeout is too short for an agent; a spend the budget does not see | The loop is opaque to `graph.json`; a cost you forget to `report()` looks free |

[In hosted ensemble](#in-hosted-ensemble) has the reasons behind that row.

## Which one should I use

1. **The agent lives behind a URL and publishes an A2A card** → [A2A](agents-a2a.md).
   The only declared way that needs nothing installed, and one of the two that run in
   hosted ensemble.
2. **The agent is a program on this machine** (`opencode acp`, `agento acp`, anything in
   the [ACP registry](https://agentclientprotocol.com/get-started/registry)) →
   [ACP](agents-acp.md). Local library only. Read the safety rule below first.
3. **The agent's owner offers it as one MCP tool** (`agento mcp`, a remote MCP server
   with an "ask" tool) → [MCP](agents-mcp.md). One tool call and no second protocol.
4. **You are writing the agent yourself and want its API in your hands** (its hooks, its
   event log, tools in the same file, an approval callback) → [in-process](agent.md).
5. **The runner will run in hosted ensemble** → A2A, or MCP on a remote server, and an
   agent that needs no token. Nothing else runs there today.
6. **The step is one generative call, or a closed question** → not an agent at all: a
   `model` node, or a `decide` node. An agent is for an open-ended sub-task whose steps
   depend on what the last one returned.

## The safety rule

> **Ensemble does not sandbox an agent.** An ACP agent is a process running as you, on
> your machine. The `permissions` policy in the runner governs what the agent **asks**;
> an agent that acts without asking is not stopped by it. This is not theoretical:
> `opencode acp`, as it ships, wrote a file and ran a shell command without asking, so
> ensemble's default `permissions: "reject"` never got a say
> ([what was tested](agents-acp.md#agents-tested-with-this-client)).
>
> So every ACP agent needs all three:
>
> 1. **Its own configuration set to ask or deny**, passed through `env` in the
>    declaration. Then it asks, and the runner's policy answers.
> 2. **A `cwd` you are willing to expose.** An empty or throwaway directory when the
>    agent only needs to think.
> 3. **A `decide` node after it** that judges the reply, because a refused agent may
>    stop short without saying what it did not do.
>
> The declaration proven to hold for opencode is on the
> [ACP page](agents-acp.md#the-declarations-to-use).

An A2A or MCP agent runs somewhere else, with whatever access its owner gave it. What
you control there is the message you send and what you do with the reply, so the third
point applies to every way: judge the reply in the graph.

## Agents supported out of the box: OpenRouter only

These are the owner's rules for the agents ensemble will offer as ready-made choices.
They do not limit what you may declare yourself.

- **Open-source agents only.**
- **OpenRouter is the only model provider.** One key (`OPENROUTER_API_KEY`), one bill,
  and the run's budget can apply. An agent that needs its own vendor key as it ships
  (Claude Code, Codex, Gemini CLI) is not eligible.
- **An approved, version-pinned catalog is planned, not built.** Its first entries are
  to be `opencode` and `agento`, and each entry is to carry the launch command, how to
  point the agent at OpenRouter, and the agent's own safe configuration (point 1 of the
  safety rule). There is no catalog command today: you install an agent yourself and
  declare its command, or run it somewhere and declare its URL.

[`@ghostmind-dev/agento`](agent.md) is the Ghostmind agent engine and fits these rules
by construction: it runs with `OPENROUTER_API_KEY` alone
([what that means](agents-build.md#5-requirements-for-an-agent-meant-for-the-catalog)).

## The agent node

```ts
import { choice, noul, runner } from "@ghostmind-dev/ensemble";

export default runner({
  name: "delegate",
  inputs: ["goal"],

  // Who can be asked, and how each is reached. One field picks the protocol.
  agents: {
    researcher: {
      protocol: "a2a",
      url: "https://agent.example.com",
      auth: { type: "bearer", token: "${RESEARCH_AGENT_TOKEN}" },
    },
  },

  nodes: {
    // Before: is an agent needed at all?
    triage: {
      decide: {
        route: choice("How should this request be handled?", {
          direct: { what: "Small talk that needs no lookup", not_for: "Anything asking for facts" },
          research: { what: "Needs facts or findings gathered", not_for: "Small talk" },
        }),
      },
      reads: ["goal"],
    },
    answer: { code: (s) => `Happy to help: ${s.goal}`, reads: ["goal"], writes: ["reply"] },

    // The agent node: one message out, one reply back.
    research: {
      agent: "researcher",
      prompt: (s) => `${s.goal}\n\nAnswer in a short paragraph.`,
      reads: ["goal"],
      writes: ["reply", "delegation"],
    },

    // After: did the reply answer? The agent does not get to say.
    review: { decide: { answered: noul("Does the reply fully answer what was asked?") }, reads: ["goal", "reply"] },
    tally: { code: (s) => Number(s.rounds ?? 0) + 1, reads: ["rounds"], writes: ["rounds"] },
    deliver: { code: (s) => String(s.reply), reads: ["reply"], writes: ["final"] },
  },

  edges: [
    { from: "triage", to: "answer", on: "route=direct" },
    { from: "triage", to: "research", on: "route=research" },
    { from: "answer", to: "deliver" },
    { from: "research", to: "review" },
    { from: "review", to: "tally", on: "!answered" },
    { from: "review", to: "deliver", on: "answered" },
    { from: "tally", to: "research", maxLoops: 1 },   // one retry, bounded on the edge
    { from: "tally", to: "deliver" },
  ],
  entry: "triage",
  result: "final",
});
```

The runnable version is [`examples/10-delegate`](../examples/10-delegate/delegate.mts).
Swapping the agent for another protocol changes the declaration and nothing else in the
graph.

| Node field | What it is | Default |
|---|---|---|
| `agent` | A key of the runner's `agents`. `validate` refuses a name that is not declared | required |
| `prompt` | The message: text, or a function of the state | The node's `reads` are the message: one key is sent bare, several are labelled (`goal:` …), and `goal` alone when the node has no reads |
| `reads` | The state keys the message is built from. Each must have an origin, like every other read | none |
| `writes` | Positional. `[text]` takes the reply; `[text, detail]` also takes `{ status, artifacts, toolCalls, permissions, data? }` | none |

The declaration's fields are on each protocol's page:
[A2A](agents-a2a.md#options), [ACP](agents-acp.md#options), [MCP](agents-mcp.md#options).

What stays true whatever the protocol:

- **One call per node execution.** The loop is inside the agent. To ask again, loop the
  graph back to the node on an edge with `maxLoops`.
- **`stepTimeout` and `signal` reach the agent.** A2A sends `CancelTask`; ACP sends
  `session/cancel` and then ends the process; an MCP call is aborted. An A2A or ACP
  agent also has its own `timeoutMs` (10 minutes by default); an MCP agent is bounded by
  its server's `timeoutMs` (30 seconds by default, so raise it).
- **A run never waits on a person at the agent's request.** An A2A task that stops at
  `input-required`, or an ACP permission request, is answered by what the runner
  declared, or the step fails and says what to change. To put a person in the path,
  use a `decide` node with `by: "human"` before or after the agent.
- **No secret is written down.** Credentials are `${NAME}` in the runner and resolved
  at call time; `graph.json`, `run.json`, events and errors never carry a value.

## What lands in `graph.json`

An agent node has `kind: "agent"`, `cost: "metered"` and an `agent` block. Both documents
stay at `version: 1`: the node kind and the block are additions. This is
`node src/cli.ts graph examples/10-delegate/delegate.mts`, the agent node only:

```json
{
  "id": "research",
  "kind": "agent",
  "label": "Ask the researcher",
  "cost": "metered",
  "reads": ["goal", "rounds"],
  "writes": ["reply", "delegation"],
  "agent": {
    "name": "researcher",
    "protocol": "a2a",
    "url": "https://agent.example.com",
    "auth": "bearer",
    "prompt": {
      "source": "(s) =>\n        `${String(s[\"goal\"])}\\n\\nAnswer in a short paragraph, and say what you could not confirm.` +\n        (s[\"rounds\"] ? `\\n\\nA first answer was judged incomplete. Be specific this time.` : \"\")"
    }
  }
}
```

| `agent` field | Present for | Holds |
|---|---|---|
| `name`, `protocol` | all | The key in `agents`, and `a2a` / `acp` / `mcp` |
| `url`, `auth` | a2a | The address without its query string, and the auth mode as a word (`"bearer"`, `"none"`) |
| `command`, `args`, `env`, `permissions`, `fs`, `mcpServers` | acp | The command and arguments as written, the **names** of the `env` variables, the permission policy (always present), file access and forwarded servers when set |
| `server`, `tool` | mcp | The `mcpServers` key and the tool |
| `prompt` | all | `{ "text" }` for literal text, `{ "source" }` for a function, `{ "reads": [...] }` when the reads are the message |

## What lands in `run.json`

This is the same node's step from the free dry run
(`node plugin/skills/ensemble-build/scripts/dryrun.mts examples/10-delegate/delegate.mts "What changed in the last release?" --answer triage.route=research --json`),
where a stub stands in for the agent:

```json
{
  "n": 2,
  "node": "research",
  "kind": "agent",
  "lane": "main",
  "started": "2026-10-04T01:46:36.335Z",
  "ended": "2026-10-04T01:46:36.335Z",
  "ms": 0,
  "cost": 0,
  "took": "e3",
  "asked": { "goal": "What changed in the last release?" },
  "handler": "researcher",
  "meta": {
    "agent": "researcher",
    "protocol": "a2a",
    "at": "https://agent.example.com",
    "prompt": "What changed in the last release?\n\nAnswer in a short paragraph, and say what you could not confirm.",
    "cost": "unknown",
    "status": "completed",
    "served": { "name": "dry-run" }
  },
  "writes": {
    "reply": "[dry agent researcher over a2a] What changed in the last release?\n\nAnswer in a short paragraph, and say what you could not confirm.",
    "delegation": { "status": "completed", "artifacts": [], "toolCalls": [], "permissions": [] }
  }
}
```

A live step has the same shape. What differs is `meta.served` (who really answered) and
the fields an agent fills in:

| `meta` field | Holds |
|---|---|
| `agent`, `protocol`, `at` | Who was asked, how, and where. `at` is printable: no query string, header or secret |
| `prompt` | The one message sent. Written before the call, so a failed step still says who was asked what |
| `status` | How it ended, in the protocol's own word: `completed` (A2A, MCP), `end_turn` (ACP) |
| `served` | Who answered. A2A: the agent's `name` and `version`, `a2a` (dialect), `binding`, `taskId`, `contextId`, `streamed`. ACP: `name`, `version`, `acp`, `sessionId`. MCP: `server`, `tool` |
| `toolCalls` | Present when the agent reported any (ACP does): `{ id, title?, kind?, status? }`. A record of what the agent said it did. Ensemble executed none of them |
| `permissions` | Present when the agent asked for any (ACP): `{ toolCall, title?, kind?, outcome }`, where `outcome` is `allowed`, `rejected` or `cancelled` |
| `artifacts` | Present when an A2A task returned any: `{ id?, name?, files? }`. Their text is in `writes` |
| `usage` | What the protocol reported (ACP: `{ used, size, cost? }`) |
| `cost` | `"reported"` or `"unknown"`: see below |

The [ACP page](agents-acp.md#what-lands-in-graphjson-and-runjson) shows a step with
tool calls, a refused permission and a reported cost.

A step that **fails** keeps `agent`, `protocol`, `at`, `prompt` and whatever the agent
had done before it stopped (`status`, `served`, `toolCalls`, `permissions`, `usage`),
next to `error`. The text of a half-finished reply is not written to `run.json`.

### Cost

`step.cost` is a number the agent **reported**, and `meta.cost` says which case it is:

| `meta.cost` | Meaning |
|---|---|
| `"reported"` | The protocol carried a cost in USD; it is in `step.cost` and in the run's total |
| `"unknown"` | Nothing was reported. `step.cost` is `0`, which means *not known*, not free |

Only ACP has a cost field (`usage_update`), and only an agent that sends it in USD is
`"reported"`. A2A and MCP define none, so those steps are always `"unknown"`. Ensemble
never estimates.

The consequence for `--budget`: the budget stops a run on the cost it can see. An agent
that reports nothing can spend without the run noticing, so bound it with `stepTimeout`,
with the agent's own limits (`agento` takes `--max-usd`), and with `maxLoops` on the edge
that leads back to it.

## In hosted ensemble

Hosted ensemble is the cloud version of ensemble itself: a sandbox that loads your
runner with no secrets, no child processes and the public internet only.

| Way | Today |
|---|---|
| `a2a` to a public agent that needs no credentials | Works |
| `mcp` on a remote (`url`) MCP server that needs no credentials | Works |
| `acp` | Cannot run: the sandbox starts no child process. `check` returns the warning `agent "x" is a local process (acp): it cannot start in the cloud, use a hosted agent (protocol: "a2a") or an agent offered as a tool of a remote MCP server (protocol: "mcp" on a url server)` |
| `mcp` on a local (`command`) MCP server | Cannot run, for the same reason. `check` warns about the server |
| In-process (`work` handler importing an agent library) | Cannot run: the sandbox imports `@ghostmind-dev/ensemble` and nothing else |
| Any agent or MCP server that needs a token | Does not work yet: the sandbox holds no secrets, so `${NAME}` cannot resolve. Per-user secrets are an open decision |

An agent's own reported cost is not counted in a hosted run's cost: only calls that go
through hosted ensemble's OpenRouter proxy are.

## Checking before a run

The CLI is reached through the project's `package.json` scripts or `npx`, never a
global install.

```sh
npx ensemble validate runner.mts        # the agent is declared; its protocol has what it needs. Offline
npx ensemble check runner.mts           # reads the A2A card, looks for the ACP command on PATH, names missing secrets
npx ensemble agents list runner.mts     # the agents a runner declares, never a secret
npx ensemble agents card https://agent.example.com   # an A2A agent's card, as JSON
npx ensemble agents coding              # search the ACP registry
```

In tests and dry runs, pass a stub for every protocol at once:

```ts
await run({ goal: "…" }, {
  delegate: async ({ name, prompt }) => ({
    text: `stub reply from ${name}`, status: "completed",
    artifacts: [], toolCalls: [], permissions: [], meta: {},
  }),
});
```

## Status (2026-10-03)

**Works today**

- The `agent` node over `a2a`, `acp` and `mcp` in the local library, and the in-process
  way.
- In hosted ensemble: `a2a` and remote `mcp`, without credentials
  ([the table above](#in-hosted-ensemble)).
- `agento acp` and `opencode acp` were run against this client on a Mac
  ([what happened](agents-acp.md#agents-tested-with-this-client)).

**Not yet tested**

- Nothing A2A has been run against a real third-party agent: only against fakes that
  follow the 1.0 specification.
- The example ACP agents were not run through the
  [acp-tck](https://github.com/agentclientprotocol/acp-tck).
- `agento mcp`, and the cost `agento acp` reports, shipped in agento 0.4.0, after the
  tests above. The tool listing of `agento mcp` was read through this client; no task
  was run through either.

**Planned, not built**

- The approved catalog ([above](#agents-supported-out-of-the-box-openrouter-only)).
- Secrets in hosted ensemble, which is what an agent that needs a token waits on.
- **A hosted agento, in progress and not live.** It is being built at
  `https://agento.ghostmind.app` (dev) and `https://agento.ghostmind.dev` (prod), with
  Google sign-in and each person's own OpenRouter account. It is to expose agento four
  ways: a chat, a remote MCP at `/mcp`, an OpenAI-compatible endpoint at `/api/v1`, and
  an A2A endpoint (agent card at `/.well-known/agent-card.json`), so that an ensemble
  graph can delegate to it with `protocol: "a2a"` and a bearer token. Its first version
  talks and uses web tools only: no files, no shell. Reaching it from hosted ensemble
  also needs the secrets decision above, since it takes a token.

## Limits

- Text out, text and structured data back. Images and files are not sent to an agent;
  a file an A2A agent returns is recorded by name, type and URL, not by content.
- One turn. There is no way to continue the same A2A task or ACP session from a later
  node; each execution starts a new one.
- A2A over gRPC is not spoken (it cannot be without a dependency). JSON-RPC and
  HTTP+JSON are.
- ACP protocol version 1 is spoken. Version 2 is a published draft and is not.
- An ACP agent is never lent a terminal. It can be handed the runner's MCP servers by
  name (`mcpServers: ["fs"]`); an A2A or MCP agent cannot.
- Skills are not forwarded to an agent. Put a skill's text in the message
  ([how](agents-build.md#4-consuming-it)).
