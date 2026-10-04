# ACP: a local agent, launched as a command

The [Agent Client Protocol](https://agentclientprotocol.com) (ACP, started by Zed) is
what editors use to drive a coding agent: start it as a subprocess, speak JSON-RPC over
its stdin and stdout, send a prompt, and listen while it works. Agents people already
have installed speak it, so a graph can hand a step to one without importing its SDK.

This is the Agent **Client** Protocol, not IBM's archived "Agent Communication
Protocol". Use it when the agent is a program on the same machine. It runs with the
local library only. [Agents](agents.md) compares the four ways and holds what is common
to all of them.

## Read this first

> **The `permissions` policy governs what the agent ASKS. An agent that acts without
> asking is not stopped by it.** The agent is a process running as you, with your
> environment, in the directory you give it. Every ACP agent therefore needs:
>
> 1. **its own configuration set to ask or deny**, passed through `env` in the
>    declaration, so that it asks and the runner's policy answers;
> 2. **a `cwd` you are willing to expose**: an empty or throwaway directory when it only
>    needs to think;
> 3. **a `decide` node after it** that judges the reply.
>
> The runner below does all three.

## A complete runner

```ts
import { noul, runner } from "@ghostmind-dev/ensemble";

export default runner({
  name: "ask-the-coder",
  inputs: ["goal"],

  agents: {
    coder: {
      protocol: "acp",
      command: "opencode",
      args: ["acp"],
      // 1. The agent's OWN configuration: ask before editing, running a command or fetching.
      env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"ask","bash":"ask","webfetch":"ask"}}' },
      // 2. A directory you are willing to expose.
      cwd: "/path/to/the/project",
      // permissions: "reject" is the default: whatever the agent asks to do is refused.
    },
  },

  nodes: {
    inspect: {
      agent: "coder",
      prompt: (s) => `${s.goal}\n\nRead the code and answer. Do not change any file.`,
      reads: ["goal"],
      writes: ["answer", "detail"],
    },
    // 3. The reply is judged here, not by the agent.
    review: { decide: { grounded: noul("Does the answer cite specific files or functions?") }, reads: ["answer"] },
    deliver: { code: (s) => String(s.answer), reads: ["answer"], writes: ["final"] },
    flag: { code: (s) => `Unverified: ${s.answer}`, reads: ["answer"], writes: ["final"] },
  },
  edges: [
    { from: "inspect", to: "review" },
    { from: "review", to: "deliver", on: "grounded" },
    { from: "review", to: "flag", on: "!grounded" },
  ],
  entry: "inspect",
  result: "final",
});
```

```sh
npx ensemble validate runner.mts    # offline
npx ensemble check runner.mts       # is the command on PATH? how will permission requests be answered?
npx ensemble run runner.mts "Where is the retry limit set?" --budget 0.05
```

## Agents tested with this client

Each was run on a Mac on 2026-10-03 with ensemble's ACP client, on a trivial task and
then on a task that reads a file and writes one, under the default policy
`permissions: "reject"`.

| Agent | Version | What happened | Use |
|---|---|---|---|
| `agento acp` | 0.3.0 | Answered. Read a file in `cwd`. **Asked** permission for the edit, was refused, did not write, and said so in its reply. Reported no cost, so the step recorded `meta.cost: "unknown"` | [The agento declaration](#the-declarations-to-use) |
| `opencode acp`, as it ships | 1.18.31 | Answered. Read a file. **Wrote a file and ran a shell command without asking**, so the policy never got a say | Not as it ships |
| `opencode acp`, with its own configuration set to ask | 1.18.31 | Asked, was refused, wrote nothing. It then **ended its turn right after the refusal without answering the first half of the task**. Reported a cost ($0 in that test) and about 57,000 tokens of context used for a one-word answer | [The opencode declaration](#the-declarations-to-use) |

What the tests did not control: which model opencode used (it took the machine's own
opencode configuration). agento reports its cost (`usage_update`, in USD) from 0.4.0
on, which is newer than the version tested here.

The lessons are the three points at the top of this page. The third one is what the
second opencode row shows: an agent that is refused may stop short, so the node after it
has to ask whether the reply answers the request.

## The declarations to use

**opencode**, with the configuration that was proven to make it ask:

```ts
coder: {
  protocol: "acp",
  command: "opencode",
  args: ["acp"],
  env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"ask","bash":"ask","webfetch":"ask"}}' },
  cwd: "/path/you/are/willing/to/expose",
}
```

**agento**, which asks before it writes without being configured to:

```ts
coder: {
  protocol: "acp",
  command: "agento",
  args: ["acp"],                       // add "--no-web" to leave its web tools out
  cwd: "/path/you/are/willing/to/expose",
}
```

agento needs `OPENROUTER_API_KEY` in its environment and nothing else: no login, no
saved default, no writable home. A launched agent inherits the run's environment, so a
key that is already exported reaches it without an `env` entry.

**Any other ACP agent** fits the same shape. Before you trust it, find out what it does
without asking, and set its own configuration accordingly:

```ts
coder: { protocol: "acp", command: "npx", args: ["-y", "some-agent@1.2.0", "--acp"], cwd: "/tmp/empty" }
```

`npx ensemble agents <query>` searches the ACP registry and prints a declaration for
each agent that a package manager can launch as it stands. The registry says how to
launch an agent, not how it behaves. An approved catalog that also carries each agent's
safe configuration is [planned](agents.md#agents-supported-out-of-the-box-openrouter-only).

## Options

| Field | What it is | Default |
|---|---|---|
| `protocol` | `"acp"` | required |
| `command` | The program that speaks ACP on stdio | required |
| `args` | Its arguments. Values may be `${NAME}` | none |
| `env` | Variables **added** to the process's own environment, which the agent inherits whole. Values may be `${NAME}` | none |
| `cwd` | The session's working directory | The process's own. Set it |
| `permissions` | How permission requests are answered: `"reject"`, `"allow"`, or `{ allow: [kinds] }` | `"reject"` |
| `fs` | `{ read?, write? }`: offer the client-side file methods, confined to `cwd` | Neither |
| `mcpServers` | Keys of the runner's `mcpServers` to hand to the agent | none |
| `timeoutMs` | How long the turn may take | `600_000` (10 minutes) |

`graph.json` shows `command`, `args`, the names of the `env` variables, `permissions`
(always), and `fs` and `mcpServers` when set. It does not show `cwd`.

## What one execution does

1. The command is started in `cwd`, with the process's environment plus `env`.
2. `initialize` with protocol version 1. The client declares **no** file-system and
   **no** terminal capability unless `fs` is set. The agent has 30 seconds to answer.
3. `session/new` with the working directory and the MCP servers the declaration
   names (none by default; see [what is forwarded](agents-build.md#4-consuming-it)).
4. `session/prompt` with one text block.
5. While the agent works, `session/update` notifications are read: message chunks
   become the reply, tool calls are recorded, a usage update sets the cost.
6. The turn ends with a stop reason, and the process is closed.

| Stop reason | What the step does |
|---|---|
| `end_turn` | Writes the reply and moves on |
| `refusal` | Fails: the agent refused |
| `max_tokens`, `max_turn_requests` | Fails: the reply is incomplete. The tool calls and permissions up to that point are kept in the failed step. The partial text is not in `run.json`; a caller finds it on `RunFailed.cause.partial.text` |
| `cancelled` | Fails: the run was cancelled or timed out |
| anything else | Fails, naming the value |

When the run is cancelled, a `stepTimeout` expires, or `timeoutMs` runs out,
`session/cancel` is sent. The agent gets two seconds to answer `cancelled`; then the
process is ended either way.

## Permissions: a policy, never a person

An editor shows a permission request to its user. A run has no one to show it to, so
the request is answered by what the runner declares.

| `permissions` | A request to… | is answered |
|---|---|---|
| `"reject"` (default) | anything | rejected |
| `"allow"` | anything | allowed |
| `{ allow: ["read", "search", "fetch"] }` | a tool of a listed kind | allowed; every other kind is rejected |

Tool kinds are the protocol's: `read`, `edit`, `delete`, `move`, `search`, `execute`,
`think`, `fetch`, `switch_mode`, `other`. Every request and its outcome is recorded in
`run.json` under `meta.permissions`, and the policy itself is in `graph.json`.

A refused request is not a failed step. The turn ends normally (`end_turn`), and the
reply says, or should say, what the agent was not allowed to do.

## File access (off by default)

```ts
coder: { protocol: "acp", command: "agento", args: ["acp"], cwd: "/srv/project", fs: { read: true } }
```

`fs.read` and `fs.write` offer the protocol's `fs/read_text_file` and
`fs/write_text_file` to the agent. Paths must be absolute and inside `cwd`; anything
else is refused. Most agents read the disk themselves and never use these, which is why
`cwd` is the control that matters.

A terminal is never offered. `validate` rejects a declaration that asks for one.

## Secrets

`${NAME}` in `env` and `args` is resolved when the process is launched. `graph.json`
shows the names of the `env` variables, never their values, and the arguments as
written. Errors, including what the agent printed on stderr, are redacted. A literal
secret in `env` (a variable whose name contains `token`, `secret`, `key` or `password`)
is a `validate` warning.

An agent that needs a login refuses to open a session. A run cannot log in for it: run
the agent's own login once in a terminal, or hand it a key through `env`.

## Cost

When the agent sends a `usage_update` with a cost in USD, that is the step's cost
(`meta.cost: "reported"`) and it counts toward `--budget`. A cost in another currency
is recorded in `meta.usage` and not converted. No update means `meta.cost: "unknown"`
([the cost rule](agents.md#cost)). Bound the agent from its own side as well: agento
takes `--max-usd` in `args` (0.5 by default).

## What lands in `graph.json` and `run.json`

The agent node of the runner above (`npx ensemble graph runner.mts`):

```json
{
  "id": "inspect",
  "kind": "agent",
  "cost": "metered",
  "reads": ["goal"],
  "writes": ["answer", "detail"],
  "agent": {
    "name": "coder",
    "protocol": "acp",
    "command": "opencode",
    "args": ["acp"],
    "env": ["OPENCODE_CONFIG_CONTENT"],
    "permissions": "reject",
    "prompt": { "source": "(s) => `${s.goal}\\n\\nRead the code and answer. Do not change any file.`" }
  }
}
```

A step in which an agent read a file, asked to edit one and was refused. It was
recorded by the real client against the test suite's ACP agent, a real subprocess that
costs nothing (`test/fixtures/acp-agent.mjs`), which is why `at` and `served` name a
fixture (the two timestamps are left out):

```json
{
  "n": 1,
  "node": "inspect",
  "kind": "agent",
  "lane": "main",
  "ms": 26,
  "cost": 0,
  "took": "e0",
  "asked": { "goal": "tools then say what happened" },
  "handler": "coder",
  "meta": {
    "agent": "coder",
    "protocol": "acp",
    "at": "node test/fixtures/acp-agent.mjs",
    "prompt": "tools then say what happened",
    "cost": "unknown",
    "status": "end_turn",
    "served": { "name": "fixture-agent", "version": "0.9.0", "acp": 1, "sessionId": "sess_fixture" },
    "toolCalls": [
      { "id": "call_1", "title": "Reading notes.md", "kind": "read", "status": "completed" },
      { "id": "call_2", "title": "Editing notes.md", "kind": "edit", "status": "failed" }
    ],
    "permissions": [
      { "toolCall": "call_2", "title": "Editing notes.md", "kind": "edit", "outcome": "rejected" }
    ]
  },
  "writes": {
    "answer": "I was not allowed to edit the file.",
    "detail": {
      "status": "end_turn",
      "artifacts": [],
      "toolCalls": [
        { "id": "call_1", "title": "Reading notes.md", "kind": "read", "status": "completed" },
        { "id": "call_2", "title": "Editing notes.md", "kind": "edit", "status": "failed" }
      ],
      "permissions": [
        { "toolCall": "call_2", "title": "Editing notes.md", "kind": "edit", "outcome": "rejected" }
      ]
    }
  }
}
```

And the `meta` of a step whose agent reported a cost, from the same fixture. The step's
`cost` is then `0.0123`, and so is the run's total:

```json
{
  "agent": "coder",
  "protocol": "acp",
  "at": "node test/fixtures/acp-agent.mjs",
  "prompt": "plain",
  "cost": "reported",
  "status": "end_turn",
  "served": { "name": "fixture-agent", "version": "0.9.0", "acp": 1, "sessionId": "sess_fixture" },
  "usage": { "used": 1200, "size": 200000, "cost": { "amount": 0.0123, "currency": "USD" } }
}
```

`toolCalls` is what the agent **said** it did. A tool the agent used without reporting
it does not appear, which is the other half of the safety rule.

## When it fails

A failed step's `error` starts `agent "<name>": `, and the caller gets it as
`RunFailed.cause` (an `AgentError`).

| The message says | What happened | Fix |
|---|---|---|
| `needs command — the program that speaks ACP on stdio, e.g. command: "opencode", args: ["acp"]` (validate) | No `command` | Name the program |
| `has args that are not a list of strings` (validate) | `args: "acp"` | `args: ["acp"]` |
| `has permissions … — use "reject" (the default), "allow", or { allow: ["read", "search"] }` (validate) | A bad policy | One of the three forms |
| `allows "x", which is not an ACP tool kind. Kinds: read, edit, delete, move, search, execute, think, fetch, switch_mode, other` (validate) | A typo in `{ allow: [...] }` | A listed kind |
| `asks for a terminal — this client never offers one. The agent runs commands with its own tools, gated by permissions` (validate) | A `terminal` field | Remove it |
| `is handed MCP server "s", which the runner does not declare` / `cannot be handed MCP server "s": …` (validate, or at the handshake) | A forwarded server that is missing or cannot travel | [What is forwarded](agents-build.md#4-consuming-it) |
| `agent "x" runs "cmd", which is not on PATH here — install it, or give the full path as command` (check) | The command is not installed | Install it, or give the full path |
| `agent "x" is a local process (acp): it cannot start in the cloud, …` (hosted `check`, a warning) | The runner is in hosted ensemble | Use `a2a`, or `mcp` on a remote server |
| `needs NAME, which is not set` | A `${NAME}` in `env` or `args` did not resolve | Set it in the environment |
| `could not start "cmd" — it is not installed or not on PATH` | The command does not exist here | Install it |
| `the agent exited (N) before answering: …` | The process died; the tail of its stderr follows | Run the command by hand to see why |
| `initialize did not answer within 30000ms — is "cmd" an ACP agent? (e.g. opencode acp)` | The program started but does not speak ACP on stdio | Add the argument that puts it in ACP mode (`args: ["acp"]`) |
| `speaks ACP protocol version 2, and this client speaks 1 — use a release of the agent that still offers v1` | A version mismatch | A release that offers v1 |
| `the agent wants a login before it opens a session … A run cannot log in for it: run the agent's own login once in a terminal (or give it its key through env: { KEY: "${NAME}" }), then run again` | The agent is not logged in or has no key | Log in once by hand, or pass its key through `env`. For agento: set `OPENROUTER_API_KEY` |
| `session/new failed: …` | The agent refused the session for another reason | The rest is the agent's own |
| `did not finish within Nms — the turn was cancelled. Raise timeoutMs on the agent if it needs longer` | `timeoutMs` passed | Raise it, or ask for less in one turn |
| `was aborted — the turn was cancelled` | `stepTimeout`, the budget or the caller's `signal` stopped the run | Expected |
| `the agent refused to continue (stop reason: refusal) — rephrase the prompt, or route this request elsewhere` | The model behind the agent refused | Rephrase, or route that kind of request to another branch |
| `stopped at max_tokens before it finished, so its reply is incomplete — ask for less in one turn, or raise the agent's own limit` (or `max_turn_requests`) | The agent hit its own limit | Narrow the prompt, or raise the limit in the agent's configuration |
| `ended the turn with stop reason "…", which ACP v1 does not define` | A non-standard agent | Report it to the agent's owner |

Three things that are not errors and still need a response:

| What you see | What it means | What to change |
|---|---|---|
| `meta.permissions` shows `outcome: "rejected"` and the reply says it could not edit | The policy answered a request | Expected. To let it, name the tool kinds: `permissions: { allow: ["edit"] }` |
| Files changed, and `meta.permissions` is empty | The agent acted without asking | Set the agent's **own** configuration to ask (the opencode declaration above), and narrow `cwd` |
| The reply is short or skips half the task after a rejection | The agent stopped at the refusal | Route it from the `decide` node after it: retry once with a narrower prompt, or hand off |

## Limits

- Protocol version 1 only. ACP version 2 is published as a draft; an agent that answers
  `initialize` with another version fails the step.
- One prompt turn per execution, in a new session. `session/load`, `session/resume`,
  modes, config options, slash commands and elicitation are not used.
- MCP servers are handed over only when named in `mcpServers`, and a `url` server only
  to an agent that advertises the HTTP or SSE MCP capability.
- One text block is sent. Images, audio and embedded resources are not.

## In hosted ensemble

An `acp` agent cannot run there: the sandbox starts no child process, and `check`
returns a warning that says so. Use an [A2A](agents-a2a.md) agent, or an agent offered
as a tool of a remote [MCP](agents-mcp.md) server
([the full table](agents.md#in-hosted-ensemble)).

## Status

Besides the two real agents above, the client is tested against a small ACP agent run
as a real subprocess: the prompt turn, chunked and split messages, tool-call updates,
permission requests under each policy, file access, cancel, every stop reason, a login
wall, a wrong protocol version and a crash. What has not been tested is listed once,
in the overview's [status](agents.md#status-2026-10-03).
