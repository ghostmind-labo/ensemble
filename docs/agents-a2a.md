# A2A: a hosted agent

[Agent2Agent](https://a2a-protocol.org) (A2A, a Linux Foundation project) is how an
agent on someone else's server is reached without knowing what it is built from. A
card at a well-known address says who the agent is and where to talk to it; one call
sends a message; the answer is a task that moves through declared states until it ends.

Use it when the agent lives behind a URL. Nothing is installed, and it is one of the two
ways that run in hosted ensemble. [Agents](agents.md) compares the four ways and holds
what is common to all of them (the node's fields, the cost rule, the status of each).

## A complete runner

```ts
import { noul, runner } from "@ghostmind-dev/ensemble";

export default runner({
  name: "ask-the-researcher",
  inputs: ["goal"],

  agents: {
    researcher: {
      protocol: "a2a",
      url: "https://agent.example.com",
      auth: { type: "bearer", token: "${RESEARCH_AGENT_TOKEN}" },   // leave out for an agent that needs none
    },
  },

  nodes: {
    research: { agent: "researcher", reads: ["goal"], writes: ["findings", "detail"] },
    review: { decide: { answered: noul("Do the findings answer the request?") }, reads: ["goal", "findings"] },
    deliver: { code: (s) => String(s.findings), reads: ["findings"], writes: ["final"] },
    escalate: { code: () => "A person will look at this.", writes: ["final"] },
  },
  edges: [
    { from: "research", to: "review" },
    { from: "review", to: "deliver", on: "answered" },
    { from: "review", to: "escalate", on: "!answered" },
  ],
  entry: "research",
  result: "final",
});
```

```sh
npx ensemble validate runner.mts                           # offline: the declaration is well formed
RESEARCH_AGENT_TOKEN=… npx ensemble check runner.mts       # reads the card, names what is missing
RESEARCH_AGENT_TOKEN=… npx ensemble run runner.mts "What changed in the last release?" --budget 0.05
```

The node has no `prompt`, so its reads are the message: here, the goal as it is. The
`review` node is not optional decoration: it is what keeps a weak reply from being
delivered ([the safety rule](agents.md#the-safety-rule)).

## Options

| Field | What it is | Default |
|---|---|---|
| `protocol` | `"a2a"` | required |
| `url` | Where the agent lives. A `url` ending in `.json` is taken as the card itself | required |
| `card` | The card's address, when it is not at the well-known path | `<url>/.well-known/agent-card.json`, then the same name at the domain root, then the older `agent.json` name in both places |
| `endpoint` | Call this address instead of the one the card names | The card's |
| `binding` | `"JSONRPC"` or `"HTTP+JSON"` | JSON-RPC when the card offers it, then HTTP+JSON |
| `version` | `"1.0"` or `"0.3"` | Read from the card |
| `headers` | Sent on every request. Values may be `${NAME}` | none |
| `auth` | One auth mode or an array of them ([below](#auth-and-secrets)) | none |
| `streaming` | `false` never streams, even when the card offers it | Stream when the card says `capabilities.streaming` |
| `pollMs` | How often to ask for the task when not streaming | `1000`, backing off to 5 seconds |
| `timeoutMs` | How long the task may take, start to finish | `600_000` (10 minutes) |

## What one execution does

1. **Discovery.** The card is fetched (see `card` above). Each request for it gives up
   after 30 seconds.
2. **Choosing an interface.** From the card's `supportedInterfaces`, the JSON-RPC
   binding is preferred, then HTTP+JSON. The protocol version comes from the interface.
3. **Send.** One message with one text part: the node's `prompt`, or its reads.
4. **Wait.** If the card says `capabilities.streaming`, the call is
   `SendStreamingMessage` and updates arrive as server-sent events. Otherwise it is
   `SendMessage`, and while the task is still working, `GetTask` is called until it ends.
5. **Result.** The text of the task's artifacts lands on the first write key. With a
   second key, `{ status, artifacts, toolCalls, permissions, data? }` lands there, where
   `data` holds any structured parts. `toolCalls` and `permissions` are always empty for
   A2A: the protocol does not report them.

| Task state | What the step does |
|---|---|
| `completed` | Writes the reply and moves on |
| `failed`, `rejected`, `canceled` | Fails, with the agent's own message |
| `input-required` | Fails: the agent is asking a question and nothing inside a run can answer it. The task is cancelled |
| `auth-required` | Fails: the agent needs a credential it was not given. The task is cancelled |

When the run is cancelled, a `stepTimeout` expires, or the agent's `timeoutMs` runs out,
the request is dropped and `CancelTask` is sent for the task.

## What lands in `graph.json` and `run.json`

The [overview](agents.md#what-lands-in-graphjson) shows both for this protocol, taken
from `examples/10-delegate`: the graph node carries `url` (no query string) and `auth`
as a word, and the run step's `meta.served` carries the agent's own `name` and
`version`, the dialect (`a2a`), the `binding`, `taskId`, `contextId` and whether it
`streamed`. `meta.cost` is always `"unknown"`.

## Auth and secrets

An A2A agent is asked who you are in the same ways a remote MCP server is, so the modes
are the same: `bearer`, `api_key` (header or query), `basic`, `oauth`, `mtls`, `custom`,
and plain `headers`. They combine as an array.

```ts
auth: { type: "api_key", in: "header", name: "x-api-key", value: "${AGENT_KEY}" }
auth: { type: "oauth", grant: "client_credentials", clientId: "${ID}", clientSecret: "${SECRET}", scopes: ["tasks"] }
auth: [{ type: "mtls", cert: "client.pem", key: "client.key" }, { type: "bearer", token: "${T}" }]
```

- A secret is written as `${NAME}` and resolved at call time from the environment, or
  from the `secretResolver` a host app passes. A literal secret is a `validate` warning.
- `graph.json` carries the auth mode as a word (`"bearer"`), never a value. `run.json`,
  events and errors are redacted.
- An OAuth flow that needs a person happens once, in a terminal:
  `npx ensemble mcp login researcher runner.mts`. The login is stored in the same 0600
  token store remote MCP uses. A run never opens a browser; it fails and names the command.
- **Credentials are not forwarded on a card's say-so.** If the card names an address on
  a different origin from `url`, and the agent has `auth` or `headers`, the step fails
  and tells you to set `endpoint` explicitly.
- Sending credentials over plain `http://` to anything but localhost is a `validate`
  warning.

`ensemble check` reads the card, and when it declares security schemes but the runner
gives the agent no auth, it says so.

## When it fails

A failed step's `error` starts `agent "<name>": `, and the caller gets it as
`RunFailed.cause` (an `AgentError`). `ensemble check` finds the first group before a run
does.

| The message says | What happened | Fix |
|---|---|---|
| `needs url — where the agent lives, e.g. https://agent.example.com` (validate) | No `url` | Add it |
| `uses ftp:// — an A2A agent is reached over http(s)://` (validate) | Another scheme | An `http(s)://` address |
| `has binding "…" — use "JSONRPC" or "HTTP+JSON", or leave it out (gRPC is not spoken)` (validate) | An unknown `binding` | One of the two, or none |
| `has version "…" — use "1.0" or "0.3", or leave it out to read it from the card` (validate) | An unknown `version` | One of the two, or none |
| `needs NAME, which is not set` | A `${NAME}` in `auth` or `headers` did not resolve | Set it in the environment. In hosted ensemble it cannot be set yet |
| `could not reach <url>: …` | No connection to the card or the endpoint | Check the `url`; a hosted run reaches public addresses only |
| `no Agent Card found — tried … An A2A agent publishes one at /.well-known/agent-card.json; set card: "<url>" on the agent if it is elsewhere` | Nothing at the well-known paths | Set `card`, or point `url` at the card itself |
| `answered, but not with an Agent Card — set card: "<the card's url>" on the agent` | The address served a web page or other JSON | Set `card` |
| `its card offers GRPC, and this client speaks JSONRPC and HTTP+JSON — ask the agent's owner to enable the JSON-RPC binding` | No binding in common | The owner enables one |
| `its card offers no <binding> interface (offered: …) — drop binding, or pick one it offers` | `binding` asks for one the card lacks | Drop `binding` |
| `offers A2A 0.3 over HTTP+JSON only, which this client does not speak — it needs the JSON-RPC binding or A2A 1.0` | The old dialect on the one binding it is not spoken on | The owner enables JSON-RPC, or upgrades |
| `its card sends requests to <url>, a different origin from <home> — credentials are not forwarded there on a card's say-so. If that address is right, set endpoint: "<url>" on the agent` | The card names another origin and the agent has `auth` or `headers` | Set `endpoint` once you have checked the address |
| `the server rejected the bearer token (HTTP 401)` / `the server wants credentials (HTTP 401, …) — add auth to its spec` | Wrong or missing credentials | Fix the secret, or add `auth` |
| `<url> refused: …` | The agent answered with an error | The rest of the message is the agent's own |
| `the task stopped at input-required … Put what it needs in the node's prompt or reads, or ask a person first with a by: "human" node and pass their answer in` | The agent wants more before it continues, and one execution is one message | Send what it asks for up front, or put a `by: "human"` node before the agent node |
| `the task stopped at auth-required … Authorise it out of band, or add auth to agents.<name>` | The agent needs access on your behalf | Authorise it where the agent says, or add `auth` |
| `the task ended failed: …` (or `rejected`, `canceled`) | The agent's own task ended badly | The text after the colon is the agent's reason |
| `did not finish within Nms — raise timeoutMs on the agent if it needs longer (task … cancelled)` | `timeoutMs` passed | Raise it, or ask for less. `cancel not confirmed` means the agent did not acknowledge |
| `was aborted (task … cancelled)` | `stepTimeout`, the budget or the caller's `signal` stopped the run | Expected |

## Protocol versions

The current A2A specification is **1.0**: method names such as `SendMessage` and
`GetTask`, task states such as `TASK_STATE_COMPLETED`, parts told apart by which field
they carry, and an `A2A-Version: 1.0` header on every request. Many deployed agents
still speak **0.3**: `message/send`, `tasks/get`, lowercase states, parts with a `kind`.
The client reads the version from the card and speaks the matching dialect. Set
`version` to force one.

## Limits

- gRPC is not spoken. A card that offers only gRPC fails with that reason.
- A2A 0.3 is spoken over JSON-RPC only.
- A2A defines no field for what a task cost, so the step records `meta.cost: "unknown"`
  and the run's budget does not see the agent's spend
  ([the cost rule](agents.md#cost)).
- Push notifications (webhooks), the extended agent card, extensions, card signature
  verification and `ListTasks` are not used.
- One text part is sent. Files and images are not.

## In hosted ensemble

An A2A agent works when it is on a public address and needs no credentials. An agent on
a private network or on `localhost` is out of reach, and one that needs a token does not
work yet ([why](agents.md#in-hosted-ensemble)).

## Status

The client is tested against an in-process A2A server that covers the card (both
generations), `SendMessage`, streaming, polling, cancel, auth, `input-required`, the
0.3 dialect and the HTTP+JSON binding. Those are fakes that follow the specification;
what has and has not been run against real agents, and the hosted agento that is to
offer an A2A endpoint, are in the overview's [status](agents.md#status-2026-10-03). When
a real agent behaves differently, its card (`npx ensemble agents card <url>`) and the
failing step's `meta.served` are the place to look.
