# ensemble API reference (v2, ≥ 0.32)

Everything is imported from `@ghostmind-dev/ensemble`. When in doubt, the
installed package's `dist/*.d.ts` is the source of truth, so read it rather than
guessing.

## Contents
1. runner(spec)
2. The three questions
3. Node kinds: decide · work · code · model · mcp · agent
4. Edges and the `on:` grammar
4b. Parallel lanes: fork and join
5. State, writes and memory
6. Handlers
7. Calling a runner: RunOptions, outcome, errors
8. Other exports
8b. Delegation from code: cards, the registry, the `Delegate` seam
9. calibrate: scoring decisions against labelled cases
10. supervise: a runner that lives for days
11. A person in the loop: `by: "human"`, pause and resume

---

## 1. runner(spec)

```ts
export default runner({
  name: "triage",                 // required; appears in graph.json and run ids
  description?: "one line",
  inputs?: ["goal", "path"],      // keys that arrive from outside; goal is always one
  memory?: ["seen"],              // keys that carry over between ticks under supervise; a node must write them
  work?: { handlerName: (ctx) => value },
  nodes: { nodeName: NodeSpec },  // required, at least one
  edges?: Edge[],
  entry: "nodeName",              // required; where the run starts
  result?: "stateKey",            // returned as `result`; defaults to the last step's value
  openrouter?: { apiKey?, baseUrl?, retries?, timeoutMs?, app?, fetch? }, // ONE key for everything: Jev decides through it too
  jev?: { model?, baseUrl?, retries?, timeoutMs?, apiKey?, fetch? },      // rarely needed; apiKey, baseUrl and fetch default to openrouter's
  skills?: Skill[],               // from loadSkills(); needed by model nodes that inline skills
  mcpServers?: { name: { command, args?, env?, cwd?, timeoutMs? }       // local process
                     | { url, transport?, headers?, auth?, listen?, timeoutMs? } },  // hosted server
  agents?: { name: { protocol: "a2a", url, … }                           // a hosted agent, by url
                 | { protocol: "acp", command, args?, … }               // a local agent, launched as a command
                 | { protocol: "mcp", server, tool, … } },              // an agent offered as ONE MCP tool — see §3, agent
});
```

`runner()` doesn't validate when it is built, so a broken runner can still be
inspected. It returns a callable with `.spec`, `.validate(): string[]`,
`.graph(): GraphDoc` and `.resume(paused, answer, options?)` (§11). Calling it
runs it, and it refuses to start if validation fails.

The CLI loads a file's **default export**, so always `export default runner({...})`.

## 2. The three questions

```ts
choice(instructions, { optionName: Description | null, ... })  // 2..255 options
score(instructions, [level0, level1, ...])                     // 2..10 levels, low → high
noul(instructions, { true: Description, false: Description }?) // yes/no
```

| Builder | On state | In run.json |
|---|---|---|
| `choice` | the option name (string) | `probabilities`, `confidence` |
| `score` | a **fractional** expected level: 0-based, Σ level·P | `probabilities`, `confidence`, `legend` |
| `noul` | P(yes), 0–1 | the number is its own confidence |

`Instructions` is a string, or
`{ question?: string, focus?: string, inspect?: string, compare?: string[] }`.
`inspect` and `compare` hold backticked state paths, e.g. ``"`goal`"``.

`Description` is a string, or `{ what, not_for, examples?, signals?, summary? }`.
Always prefer the object form with `what` + `not_for`.

Option names and question keys become state keys and branch labels, so use
identifier-like names: `billing`, `needs_text`, not `"Needs Text?"`.

Score levels are counted from 0. A 3-level score returns 0.0–2.0, and `1.3` means
"mostly level 1, some level 2".

## 3. Node kinds

A node is **exactly one** kind, told apart by its key. There is no `type:` field.

### decide: one Jev call

```ts
classify: {
  decide: { team: choice(...), urgent: noul(...), severity: score(...) },
  reads: ["goal", "customer_plan"],   // REQUIRED, non-empty: the only keys sent
  gate?: { on: "team", min: 0.7, to: "escalate" },
  fallback?: "escalate",              // where to go if the decider cannot answer AT ALL
  by?: "human",                       // a person answers instead of Jev — see §11
  comment?: "reviewer_note",          // human only: the state key for their free-text note
  label?: "Classify the ticket",
}
```

- Writes one state key per question, with the same name as the question.
- All questions in one node go out in one request and are answered
  independently.
- `gate` works only on a `choice` or a `score`. Below `min` confidence the run
  goes to `to` whatever the edges say, and the step records `took: "gate"`.
- `fallback` is for **no answer**: the service is down, rate-limited past its
  retries, timed out, or answered outside the question (`DeciderAnswerError` —
  an answer that does not fit is no answer). Without it the run fails; with it
  the run goes there, and the step records `took: "fallback"` and the `error`.
  Low confidence is the gate's job, not this one. Put a person or a hold behind
  it. A malformed *human* answer is the exception: that is a bug, so it never
  takes the fallback (§11).
- `reads` must never include an image key. Validation refuses it.

### work: a handler the user wrote

```ts
send: { work: "billing", reads?: ["goal"], writes?: ["reply"], label? }
```

`work` names a key of the runner's `work` map. `reads` only declares data flow,
because the handler sees the whole state anyway.

A handler is ordinary async TypeScript. It can import any npm package (a vendor
SDK, an agent framework, a database client) and do anything the use case needs,
including running its own loop. Call `report({ cost })` so the run's budget and
cost include it.

### code: deterministic, free

```ts
tally: { code: (s) => Number(s.rounds ?? 0) + 1, reads: ["rounds"], writes: ["rounds"] }
```

Can be `async`, e.g. to call `catalog()`. This is where every judgement about a
number goes.

### model: one OpenRouter call

```ts
look: {
  model: "vendor/model-id" | { from: "stateKey" },
  prompt: "text" | (s) => `text using ${s.goal}`,
  system?: "…",
  sees?: ["frame"],                // image URLs or data: URLs, one string or an array per key
  skills?: ["skill-name"] | { from: "skillKey" },   // bodies inlined into the system prompt; "none" = nothing
  reads?: ["goal"],
  writes?: ["text"] | ["text", "images"],           // positional
  temperature?: 0, maxTokens?: 400,
  reasoning?: "low",               // max | xhigh | high | medium | low | minimal | none
}
```

- Many current models reason before they write, and the reasoning is paid for
  out of `maxTokens`. A tight limit can leave no room for the answer: the step
  fails with `spent its N tokens reasoning and wrote no answer`. Give such a node a
  generous `maxTokens` (thousands, not hundreds) or `reasoning: "low"`. Check
  `supported_parameters` in the model's catalogue entry for `reasoning`; a
  model that cannot turn reasoning off may reject `"none"`.
- A model call that fails after being billed still records its cost on the
  step (`OpenRouterError.cost`), so the run's total and its budget count it.

- `writes[1]` receives an array of `data:` URLs if the model drew images. Those
  keys count as image keys, so a later `sees:` can look at them but a decide node
  can't read them.
- `sees` requires a model with vision, and a second write key requires a model
  that outputs images. `ensemble check` verifies both against the live catalogue.
- A model node never needs tool-calling support.

### mcp: one tool call, not a loop

```ts
read: {
  mcp: { server: "fs", tool: "read_text_file" | { from: "toolKey" } },
  args?: { path: "x" } | (s) => ({ path: String(s.path) }),
  reads?: ["path"],
  writes?: ["text"] | ["text", "data"],   // positional; data = structuredContent
}
```

The server must be declared in `mcpServers`. Servers start lazily, only when a
branch reaches them, and stop when the run ends. A tool of `"none"` or empty
(from state) fails the node, so wire the `none` answer to another branch.

#### Remote servers

`{ url }` reaches a hosted server. `transport` is `"auto"` (default: Streamable
HTTP, falling back to legacy SSE on 400/404/405; `ws://`/`wss://` is WebSocket),
`"streamable-http"`, `"sse"` or `"websocket"`. `headers` values and every auth
field may be `"${NAME}"`, resolved at connect time by `RunOptions.secretResolver`
(default `process.env`). `auth` is one of, or an array combining:

| `auth` | Fields |
|---|---|
| `{ type: "none" }` | Nothing — and no OAuth even on a 401 |
| `{ type: "headers" }` | Only `headers` |
| `{ type: "bearer" }` | `token` |
| `{ type: "api_key" }` | `in: "header" \| "query"`, `name`, `value` |
| `{ type: "basic" }` | `username`, `password` |
| `{ type: "mtls" }` | `cert`, `key`, `ca?`, `passphrase?` (PEM or path; needs https/wss) |
| `{ type: "custom" }` | `provider: async ({ url, server, challenge?, signal }) => headers` — re-asked after a 401 |
| `{ type: "oauth" }` | `grant?` (`authorization_code` default, `device_code`, `client_credentials`, `refresh_token`), `clientId?` (omit → dynamic registration), `clientSecret?`, `tokenEndpointAuth?`, `privateKey?`, `keyId?`, `scopes?`, `audience?`, `resource?`, `redirectPort?`, `tokenStore?` (a directory), `refreshToken?` |

No `auth` at all: a 401 with a Bearer challenge is treated as OAuth. People log
in once with `npx ensemble mcp login <server> [runner file] [--url] [--device]`;
machines (`client_credentials`, `refresh_token`) grant themselves. A run never
opens a browser: it fails with the login command. `RunOptions.tokenStore` swaps
the default store (0600 files under `~/.ensemble/mcp-tokens/`, or
`ENSEMBLE_MCP_TOKENS`) — pass one per user in a hosted app.
`npx ensemble mcp status [file]` shows each server's auth and login, never a
secret. `runner.warnings()` / `validate` flag literal secrets.

### agent: one message to an agent somebody else runs

```ts
research: {
  agent: "researcher",                       // a key of the runner's `agents`
  prompt?: "text" | (s) => `… ${s.goal}`,    // omitted: the node's reads ARE the message
  reads?: ["goal"],
  writes?: ["reply"] | ["reply", "detail"],  // positional
  label?: "Ask the researcher",
}
```

- **One call per node execution.** The loop is the agent's; the route in, the
  deadline, the budget and the judgement of the reply stay in the graph. Put a
  decide node after it: the agent never marks its own work.
- **The message.** A string is sent as written, a function receives the
  blackboard. With no `prompt`, the reads are sent as they are: one key bare,
  several labelled (`key:\n<value>`, blank line between), and `goal` when the
  node declares no reads. `promptFromReads(state, reads)` is that function.
- **Writes.** `writes[0]` takes the reply's text. `writes[1]` takes
  `{ status, artifacts, toolCalls, permissions, data? }`: `status` is the
  protocol's own word (`completed` for a2a and mcp, `end_turn` for acp),
  `artifacts` are `{ id?, name?, text, data?, files? }` (a2a), `toolCalls` are
  `{ id, title?, kind?, status? }` (acp: what the agent SAID it used; nothing
  there is run by the runner), `permissions` are `{ toolCall, title?, kind?,
  outcome: "allowed" | "rejected" | "cancelled" }` (acp), and `data` is
  structured output (A2A data parts, or an MCP tool's `structuredContent`).
- **Cancelling.** `stepTimeout`, the run's `signal` and the budget abort the
  call: the task is cancelled on A2A (`CancelTask`), the turn on ACP
  (`session/cancel`, then the process is ended), the tool call on MCP.
- **Cost.** `step.cost` is set only when the protocol reports one: ACP's
  `usage_update`, in USD. A2A and MCP define no cost field, so the step's cost
  is 0 and `step.meta.cost` is `"unknown"`, even when an MCP tool returns a
  cost of its own in `structuredContent` (that lands in `detail.data`).
  Unknown is not free: the run's total and `budget` count only what was
  reported.

#### Declaring agents

`?` marks an optional field; the comment gives its default.

```ts
agents: {
  researcher: {
    protocol: "a2a",
    url: "https://agent.example.com",        // required. A url ending in .json IS the card
    card?: "https://…/card.json",            // default: <url>/.well-known/agent-card.json, then the domain root, then the older agent.json name
    endpoint?: "https://…",                  // default: the address the card names
    binding?: "JSONRPC" | "HTTP+JSON",       // default: JSON-RPC, then HTTP+JSON
    version?: "1.0" | "0.3",                 // default: read from the card
    headers?: { "x-team": "${TEAM}" },       // default: none
    auth?: { type: "bearer", token: "${RESEARCH_TOKEN}" },  // default: none. The modes of a remote MCP server (table above), one or an array
    streaming?: false,                       // default: stream when the card offers it, otherwise poll
    pollMs?: 1000,                           // default 1000, backing off to 5 s
    timeoutMs?: 600_000,                     // default 10 minutes, start to finish
  },
  coder: {
    protocol: "acp",
    command: "opencode", args: ["acp"],      // required: any program that speaks ACP on stdio. args default: none
    env?: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"ask","bash":"ask","webfetch":"ask"}}' },
                                             // ADDED to the process's environment, which the agent inherits whole; values may be "${NAME}"
    cwd?: "/a/directory/you/expose",         // default: the process's own directory. Always set it
    permissions?: "reject" | "allow" | { allow: ["read", "search"] },  // default "reject"
    fs?: { read?: true, write?: true },      // default: neither. Client-side file methods, confined to cwd
    mcpServers?: ["fs"],                     // default: none. Keys of the runner's mcpServers, handed to the agent in session/new
    timeoutMs?: 600_000,                     // default 10 minutes
  },
  helper: {
    protocol: "mcp",
    server: "agento",                        // required: a key of the runner's mcpServers
    tool: "run_task",                        // required: the tool that IS the agent
    input?: "prompt",                        // default "prompt": the argument the message goes in
    args?: { max_usd: 0.05 },                // default: none. Other arguments, sent as written
  },
},
mcpServers: { agento: { command: "agento", args: ["mcp"], timeoutMs: 300_000 } },   // an mcp agent is bounded by its SERVER's timeoutMs, 30 s by default
```

- **a2a** speaks A2A v1.0 and the 0.3 dialect, chosen from the card, over the
  JSON-RPC and HTTP+JSON bindings (gRPC is not spoken). Credentials go only to
  the agent's own origin: a card that names another origin as its address needs
  `endpoint` set to it. An OAuth agent is logged in to once with
  `npx ensemble mcp login <agent> <runner file>`; the login lives in the same
  store as a remote MCP server's. A task that stops at `input-required` or
  `auth-required` fails the step: one execution is one message.
- **acp** speaks ACP protocol version 1 (v2 is a published draft and is not
  spoken). The agent is a child process for the one turn, running as the user,
  with the process's environment. `permissions` answers the agent's permission
  requests by policy, never by a person: `"reject"` refuses everything it asks,
  `"allow"` says yes to everything it asks, `{ allow: [kinds] }` says yes to
  those tool kinds only (`read`, `edit`, `delete`, `move`, `search`, `execute`,
  `think`, `fetch`, `switch_mode`, `other`). A refused request is not a failed
  step: the turn ends `end_turn` and the request is in `meta.permissions`.
  **The policy governs what the agent ASKS. An agent that acts without asking
  is not stopped by it**, so the agent's own configuration (through `env`) and
  `cwd` are part of every declaration; see the tested declarations below. A
  terminal is never offered. `mcpServers` names servers the runner already
  declares, so the agent can use tools the graph knows about: the AGENT
  connects to them, not this client. A local (`command`) server is always
  accepted; a `url` server goes over as http or sse only, needs an agent that
  advertises `mcpCapabilities.http` (or `.sse`), and auth that fits in headers
  (`none`, `headers`, `bearer`, `basic`, an `api_key` header).
- **mcp** makes one `tools/call` on a server declared in `mcpServers`, with the
  message in the `input` argument. A result with `isError: true` fails the
  step.
- Secrets are names: `"${NAME}"` in `headers`, `auth`, `env` and `args` is
  resolved at call time by `RunOptions.secretResolver` (default `process.env`),
  and no resolved value reaches run.json, graph.json, an event or an error.

#### Tested declarations

Run with this client on 2026-10-03, default policy `permissions: "reject"`:

| Agent | What it did | Declare it as |
|---|---|---|
| `agento acp` (0.3.0) | Read a file in `cwd`; asked before the edit, was refused, did not write, and said so. Reported no cost in 0.3.0 (0.4.0 sends one) | `{ protocol: "acp", command: "agento", args: ["acp"], cwd }`. It needs `OPENROUTER_API_KEY` in the environment and nothing else. `"--no-web"` in `args` leaves its web tools out; `"--max-usd", "0.05"` caps its spend |
| `opencode acp` (1.18.31), as it ships | **Wrote a file and ran a shell command without asking**; the policy never got a say | Use the next row |
| `opencode acp` with its own configuration set to ask | Asked, was refused, wrote nothing, then ended its turn without answering the rest of the task. Reported a cost | `{ protocol: "acp", command: "opencode", args: ["acp"], env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"ask","bash":"ask","webfetch":"ask"}}' }, cwd }` |
| `agento mcp` (0.4.0) | One tool, `run_task`: `prompt`, optional `cwd`, `model`, `max_usd`. Read-only unless the server is started with `--yes` or `--allow-shell <word>`. `structuredContent` is `{ status, reason, steps, toolCalls, cost, model }`; an unfinished run is `isError: true`. Its tool listing was read through this client; no task was run | `mcpServers: { agento: { command: "agento", args: ["mcp"], timeoutMs: 300_000 } }`, `agents: { helper: { protocol: "mcp", server: "agento", tool: "run_task" } }` |

No A2A agent run by a third party has been tested, only fakes that follow the
1.0 specification. A hosted agento with an A2A endpoint is in progress and not
live.

#### What works where

| Way in | The local library | Hosted ensemble |
|---|---|---|
| `a2a` | Yes | Yes, to a public agent that takes no credentials |
| `acp` | Yes | Local only: the sandbox starts no child process. `check` returns a warning with the fix |
| `mcp` | Yes, on any server | Yes, on a remote (`url`) server that takes no credentials. A local (`command`) server is local only |
| An agent in-process in a `work` handler (pattern 16) | Yes | Only when the library is an npm package listed in `dependencies` that makes network calls alone: the sandbox starts no process, reads no file and holds no secret |

In hosted ensemble a runner imports `@ghostmind-dev/ensemble` and the npm
packages passed as `dependencies` next to its source (`check_runner`,
`save_runner`); the exact versions are fixed when it is saved and stay with
that version of the runner.

In hosted ensemble the sandbox holds no secrets yet, so `${NAME}` does not
resolve there and an agent or MCP server that takes a token is local only for
now. An agent's own reported cost is not counted in a hosted run's cost; only
calls through the hosted OpenRouter proxy are.

#### In graph.json and run.json

Both documents stay `version: 1`; the node kind is additive. A graph node of
`kind: "agent"` has `cost: "metered"` and an `agent` block, never holding a
secret (a url without its query, auth as the name of its mode, environment
variables by name; `cwd` is not shown):

```ts
agent: {
  name, protocol,
  url?, auth?,                          // a2a: where, and the auth mode in words ("bearer", "none", …)
  command?, args?, env?: string[], permissions?, fs?, mcpServers?: string[],   // acp: permissions is always present
  server?, tool?,                       // mcp
  prompt: { text } | { source } | { reads: string[] },  // literal, a function's source, or the reads sent as they are
}
```

A run step of `kind: "agent"` has `handler` (the agent's key), `asked`,
`writes`, and `meta`:

| `meta` field | Holds |
|---|---|
| `agent`, `protocol`, `at` | Who was asked, how, and where (`at` is printable: no query, header or secret) |
| `prompt` | The one message sent. Written before the call, so a failed step still says who was asked what |
| `status` | How it ended, in the protocol's word |
| `served` | Who answered: the agent's own `name` and `version`, plus `a2a`, `binding`, `taskId`, `contextId`, `streamed` (a2a); `acp`, `sessionId` (acp); `server`, `tool` (mcp) |
| `toolCalls`, `permissions` | Present when there were any (acp) |
| `artifacts` | `{ id?, name?, files? }` each (a2a); the text is in `writes` |
| `usage` | What the protocol reported (ACP: `{ used, size, cost? }`) |
| `cost` | `"reported"` (then `step.cost` is the USD amount) or `"unknown"` (then `step.cost` is 0) |

A step that fails keeps what the agent had done before it stopped (`status`,
`served`, `toolCalls`, `permissions`, `usage`) next to its `error`. The text of
a half-finished reply is not in `run.json`; a caller finds it on
`RunFailed.cause.partial.text`.

## 4. Edges

```ts
{ from, to, on?: "grammar", when?: (s) => boolean, maxLoops?: n, fork?: true }
```

- `on` is for **meaning**. It must leave the decide node that asked the
  question.
- `when` is for **arithmetic**. It can leave any node and is plain TypeScript.
  Its reads are found by running it against a recording proxy, so every key it
  touches must have an origin.
- No `on` and no `when` makes the default edge. It also satisfies the
  exhaustiveness check.
- Never put both `on` and `when` on one edge.
- **Order matters.** Edges from a node are tried in declaration order and the
  first match wins. Edge ids are `e0`, `e1`… by position across the whole
  `edges` array.
- `maxLoops: n` lets an edge match at most n times. After that it stops matching
  and the next edge takes over.
- A node with no matching outgoing edge ends the run.

### `on:` grammar

| Form | Means | Only on |
|---|---|---|
| `"team=billing"` | the choice picked `billing` | choice |
| `"urgent"` | noul ≥ 0.5 | noul |
| `"!urgent"` | noul < 0.5 | noul |
| `"urgent>=0.7"` | explicit threshold: `>=` `>` `<=` `<` | noul |

A score has **no** `on:` form. Branch on it with
`when: (s) => Number(s.severity) >= 1.5`.

### 4b. Parallel lanes: fork and join

```ts
edges: [
  { from: "sense", to: "look",   fork: true },
  { from: "sense", to: "listen", fork: true },
  { from: "look", to: "assess" }, { from: "listen", to: "assess" },
],
nodes: { assess: { join: "all", decide: {…}, reads: ["scene", "heard"] } }
```

- A **forking edge** fires alongside every other forking edge from its node
  that holds, each starting its own lane. A node's edges are all forks or none.
  A fork may carry `on:` or `when:`, so a decide node can fan out to only the
  lanes it chose.
- A **join** (`join: "all"` on any node kind) runs once, after every lane
  leading to it has arrived or ended. It needs at least two incoming edges and
  cannot be the entry.
- Lanes between a fork and its join must not share a node, and must not write a
  key another lane writes or reads. `validate` refuses both, naming the key.
  Write to separate keys and combine them after the join.
- One controller covers every lane: `budget`, `stepTimeout`, `signal` and a
  failure on any lane stop all of them. The first reason to stop is the one
  recorded.
- No variable-width fan-out. N parallel calls over a list is a `work` handler.

## 5. State, writes and memory

State is a flat blackboard. Keys come from exactly three places: `inputs` (plus
`goal`), `memory` (carried in from the previous tick) and node `writes`.
Validation proves every key read has one of these origins, and that every
memory key has a writer (otherwise it could never change).

- `writes: []` or omitted means the node only has an effect.
- `writes: ["k"]` means the return value is stored **whole** under `k`.
- `writes: ["a", "b"]` means the return value must be an object with `a` and `b`,
  and they are destructured.
- For model, mcp and agent nodes, writes are **positional** (see above).
- Decide nodes write the plain value (`"billing"`, `0.83`, `1.4`), not the answer
  object. The full distribution goes to run.json.

## 6. Handlers

```ts
work: {
  billing: async ({ goal, state, signal, report }) => {
    report({ cost: 0.021, meta: { provider: "x", model: "y" } }); // optional, keeps run cost honest
    return await myApi(goal, { signal });                           // pass signal to fetch
  },
}
```

`state` is read-only. Return values follow the writes rules above. A throw fails
the run with `RunFailed`, which carries the partial run record. **Report the cost
before anything that can throw**: money spent on a step that then fails still
counts toward `run.cost.total` and the `budget`.

### Every step's record

Each entry in `run.json`'s `steps[]` carries: `n`, `node`, `kind`, `lane`
(`"main"`, the forking edge id that started the lane, or the join node's name),
`started`/`ended` (ISO) and `ms`, `cost`, `asked` (the state the node was given,
per its declared reads), `writes`, `answers` (decide: full distributions),
`gate`, `handler`, `meta`, `error`, `took` (the edge id, `"gate"`, `"fallback"`, or null) and
`forked` (the edge ids a fork step fired). `asked` is what an audit or a replay
needs; a work handler sees the whole state, but only what it declared is kept.

## 7. Calling a runner

```ts
const { result, state, run } = await myRunner(
  { goal: "…", other_input: "…" },
  {
    budget?: 0.05,        // USD; stops once exceeded
    maxSteps?: 50,        // default 50
    stepTimeout?: 30_000, // ms; fail any step that runs longer, and abort its signal. Off by default
    signal?: AbortSignal,
    decider?: Decider,    // stub or replace Jev: (state, questions, { signal }?) => Promise<Decision>
    caller?: Caller,      // stub or replace OpenRouter
    delegate?: Delegate,  // stub or replace how agent nodes reach their agent — see §8b
    secretResolver?,      // resolves "${NAME}" for remote MCP servers and agents; default process.env
    tokenStore?,          // where OAuth logins are read and refreshed; pass one per user in a hosted app
    human?: Human,        // answers by: "human" nodes; without it they PAUSE — see §11
    onEvent?: (e) => {},  // "node:start" | "node:end" | "run:end"
  },
);
```

The CLI is optional. A runner is a plain module, so a script can import it and
call it directly:

```ts
// run.mts: node run.mts
import triage from "./runners/triage.mts";
const { result } = await triage({ goal: process.argv[2] }, { budget: 0.05 });
console.log(result);
```

Throws `RunnerError` (`.problems`) if the spec does not validate, and `RunFailed`
(`.run`) if a node throws. `RunFailed.cause` is what actually went wrong, so a
host app can tell its own bug from an upstream one: `DeciderAnswerError` when the
decider answered outside the question it was asked (an option that was never
declared, a missing value, the wrong answer type), `HumanAnswerError` when a
person's answer doesn't fit. A `DeciderAnswerError` takes the decide node's
`fallback` when one is declared; a `HumanAnswerError` never does.

A stub decider returns
`{ model, answers: { key: { type:"choice", choice, confidence, probabilities } | { type:"noul", noul } | { type:"score", score, confidence, probabilities, legend } }, usage: { input_tokens, output_tokens }, cost }`
and must answer exactly the questions it was handed, with declared option names —
anything else is a `DeciderAnswerError`. Its third argument is `DecideOptions`
(`{ signal?: AbortSignal }`): pass the signal to your `fetch` so a cancelled
run — the caller hung up, the budget ran out, the step timed out — stops the
work in flight instead of paying for an answer nobody reads. It is optional, so
a two-argument decider is still a valid `Decider`.

## 8. Other exports

| Export | Use |
|---|---|
| `catalog(config?, signal?)` | Live OpenRouter models as `{ id, name, vision, draws, tools, promptUsd, completionUsd, imageUsd, contextLength }`. Cached 10 min per source (baseUrl + injected `fetch`), network |
| `shortlist(models, { vision?, draws?, tools?, maxPromptUsdPerM?, maxCompletionUsdPerM?, minContext?, idIncludes?, limit? })` | Filter in code, cheapest first |
| `modelOptions(models)` | A shortlist as `choice` criteria (only for a *fixed* shortlist) |
| `loadSkills({ project?, home?, dirs?, plugins? })` | Agent Skills from disk. Sync, local, safe at module scope |
| `skillOptions(skills, { max?, chars?, none? })` | Skills as `choice` criteria, with a `none` option by default |
| `toolOptions(tools, …)` | MCP tools as `choice` criteria |
| `searchServers(q)`, `missingEnv(entry)`, `toServerSpec(entry)` | The official MCP registry — a remote-only entry becomes `{ url, transport, headers }` |
| `login`, `logout`, `loginStatus`, `fileTokenStore` | Remote MCP OAuth from code, e.g. per user |
| `warnings(spec)` | Literal secrets and credentials without TLS — not problems, but fix them |
| `preflight(spec)` | What `ensemble check` runs |
| `validate(spec)`, `toGraph(spec)`, `execute(spec, inputs, opts)` | The functions behind the runner methods |
| `jev(config)`, `openrouter(config)` | The default decider and caller, configurable |
| `reporter()` | The terminal progress view, an `onEvent` consumer |

| `agentCard`, `sendA2a`, `promptAcp`, `searchAgents`, `toAgentSpec`, `promptFromReads`, `delegate`, `AgentError` | Delegation from code. See §8b |
| `calibrate(runner, cases, opts)` | Score decide nodes against labelled cases. See §9 |
| `supervise(runner, opts)` | Run a runner as a long-lived loop. See §10 |

CLI (through `package.json` scripts, never global):
`ensemble validate | graph | run | resume <file> <paused.json> | calibrate <file> <cases> | check | skills [q] [--remote] | servers [q] | agents [q] | agents card <url> | agents list <file> | mcp login·logout·status | status [id] | stop <id> | view [project] | serve mcp <file...> | version`.
`status` lists the runs live in this folder and the last ten recorded;
`status <id>` prints one as JSON (a live one: `running`, `steps`, `state`,
`cost`); `--json` gives the whole picture as data. `stop <id>` cancels a live
run, which writes its record with status `cancelled`. Both see any tracked
run, whether `ensemble run` started it or a script calling
`tracked(runner)(inputs)`. Ctrl-C on `ensemble run` cancels the same way.
`view [project] [--port 4400] [--host 127.0.0.1]` serves one read-only page
over the runs and live runs of a project; it loads no runner.
`serve mcp` speaks MCP over stdio and takes `--budget`, `--secret` and
`--grace <seconds>`. Over HTTP, and for A2A, mount the connector in your own
server: `mcpTools([...]).handler`, `a2aAgent(runner).handler`.
Run ids are `<timestamp>-<runner>-<4 hex>`, unique even within one second.
A run that fails still writes its `run.json` and `graph.json` (status
`failed`, the error on the step where it stopped) and exits 1.
Run options: `--input k=v`, `--budget`, `--max-steps`, `--json`, `-o`; `resume`
adds `--answer k=value` (repeatable, one per question), `--comment` and `--by`.

- `ensemble agents [query]` lists the ACP registry: each agent, and the
  `{ protocol: "acp", command, args }` that launches it, or how it is
  distributed when it has to be installed first.
- `ensemble agents card <url> [--header k=v]` reads an A2A agent's card and
  prints it as JSON (name, version, interfaces, streaming, skills, declared
  security), with the `agents: { … }` line to paste on stderr.
- `ensemble agents list <file>` prints the agents a runner declares: name,
  protocol, where, and the auth mode or permission policy. Never a secret.
- `ensemble mcp login <agent> <file>` also finds an `a2a` agent by its key.
- `ensemble check <file>` reads each A2A card, looks for each ACP command on
  PATH, and names the secrets still unset.

## 8b. Delegation from code

| Export | Use |
|---|---|
| `agentCard(name, spec, { secretResolver?, tokenStore?, signal? }?)` | Fetch an A2A agent's card: `{ name, description, version, url, interfaces: [{ url, binding, version?, tenant? }], streaming, skills: [{ id, name, description, tags }], security: [{ name, type }], raw }`. Throws `AgentError` |
| `sendA2a(name, spec, request)` | One message to an A2A agent, waited to the end of the task → `AgentReply` |
| `promptAcp(name, spec, request)` | One prompt turn against an ACP agent → `AgentReply` |
| `delegate` | The default `Delegate`: routes a request to the three protocols |
| `searchAgents(query?, { limit?, fetch?, baseUrl?, timeoutMs? }?)` | The ACP registry as `RegistryAgent[]`: `{ id, name, version, description, repository?, website?, license?, distribution: string[], launch?: { command, args } }`. Throws `DiscoveryError` when the registry cannot be read |
| `toAgentSpec(entry)` | A registry entry as `{ protocol: "acp", command, args }`, or `undefined` when it is a binary that must be installed first |
| `promptFromReads(state, reads)` | The message an agent node sends when it declares no `prompt` |
| `describeAgent(spec)` | Where an agent is, in words safe to print |
| `AgentError` | What a failed delegation throws: `.agent`, and `.partial` (what the agent had done before it stopped). The message is `agent "<name>": …` and names the fix. It reaches a caller as `RunFailed.cause` |
| `isAgent(node)`, `AGENT_PROTOCOLS`, `ACP_TOOL_KINDS`, `ACP_REGISTRY_URL` | The guard and the closed lists |

Types: `AgentSpec` (`A2aAgentSpec | AcpAgentSpec | McpAgentSpec`),
`AcpPermissions`, `AgentNode`, `AgentRequest`, `AgentReply`, `AgentToolCall`,
`AgentPermission`, `AgentArtifact`, `AgentCard`, `AgentInterface`, `Delegate`,
`RegistryAgent`.

`RunOptions.delegate` is the seam: one function stands in for every protocol,
so a test, a dry run or a host's own policy replaces them all at once.

```ts
type Delegate = (request: {
  name: string; agent: AgentSpec; prompt: string; signal: AbortSignal;
  secretResolver?, tokenStore?, mcp?, mcpServers?,   // the run's own resolver, store, MCP sessions and server declarations
}) => Promise<AgentReply>;

const stub: Delegate = async ({ name, prompt }) => ({
  text: `[stub ${name}] ${prompt}`,
  status: "completed",
  artifacts: [], toolCalls: [], permissions: [],
  // cost?: 0.01,   // USD; leave it out and the step records meta.cost "unknown"
  // data?, usage?
  meta: {},        // who answered; lands on the step as meta.served
});
await myRunner({ goal }, { delegate: stub });
```

## 9. calibrate(runner, cases, options?)

Tests decide nodes in isolation, the way you test one neuron: each case gives
the state the node reads, and nothing else runs (no handler, no model).

```ts
const report = await calibrate(triage, [
  { inputs: { goal: "charged twice" }, expect: { route: "billing" } },          // bare key if one node asks it
  { inputs: { goal: "where is it", plan: "vip" }, expect: { "screen.urgent": true, "route.anger": 1 } },
  { inputs: { goal: "refund please" }, expect: { route: "billing" }, set: "holdout" },
], { budget: 0.05, concurrency: 4, decider? });
```

**Split the cases.** `set: "dev"` (the default) is what you tune questions
against; `set: "holdout"` is scored separately and should be read **once**,
after the wording is frozen. Tuning against the cases that judge you is how a
graph comes to score well on those cases and nowhere else. The report keeps the
sets apart and adds `gap`, the dev-minus-holdout accuracy per question: a drop
of 0.1 or more means the dev set is flattering you.

- `expect` values: a choice takes an option name, a noul `true`/`false`, a score
  its **0-based** level (right when the fractional score rounds to it).
- Every key the tested node `reads` must be in `inputs`, even keys a model node
  would normally write. Put the text that node would have produced there.
- A bad case set throws `CalibrationError` (`.problems`) **before anything is
  asked**, so it costs nothing.
- One decider call per case per node, so several questions in one node cost one call.

The report has, per question: `n`, `accuracy`, `confidence` (mean), `gap`
(expected calibration error; near 0 means confidence can be trusted), `misses`
(`{ case, expected, got, confidence }`), plus `brier` for a noul, `meanError`
for a score, and `gates` for a choice or score:
`[{ min, keeps, accuracy }]`, meaning a gate at `min` keeps this share of cases
and gets this share of those right. Set `gate.min` from that table.

CLI: `npm run calibrate -- runner.mts cases.jsonl [--holdout held.jsonl] [--budget 0.05] [--json]`.
It reads one case per line, or a JSON array; `--holdout` tags a second file as
the frozen set and prints both blocks plus the gap.

## 10. supervise(runner, options)

A runner is one tick. `supervise` runs it again and again: memory between
ticks, budgets, a crash-safe journal, a failure streak limit, signal handling,
and an optional watcher runner that judges drift.

```ts
const outcome = await supervise(worker, {                // worker declares memory: ["notes"]
  next: async ({ tick, memory, last, interrupted, signal }) => ({ goal: await queue.pop() }), // undefined ends it
  memory: { notes: "" },                     // starting values; ignored once a checkpoint exists
  budget: { total: 20, perDay: 5, perRun: 0.05 }, // total stops; perDay RESTS until spend ages out; perRun caps each tick
  maxTicks: 10_000,
  pace: 60_000,                              // ms between tick starts
  maxStreak: 5,                              // stop after this many failed ticks in a row
  window: 20,                                // ticks the vitals look back over
  run: { stepTimeout: 120_000 },             // any RunOptions except budget/signal/onEvent
  watch: { every: 10, runner: watcher, goal: "…", run: { … } },
  journal: ".ensemble/live",                 // journal.jsonl, checkpoint.json, pulse.json, lock; resumes on restart
  resume: true,                              // default
  signals: true,                             // default: SIGTERM/SIGINT stop after the tick in flight; twice aborts
  signal,
  onEvent: (e) => {},                        // start · tick · rest · watch · alert · stop
  onRunEvent: (e, tick) => {},               // each tick's node events, e.g. reporter()
  onAlert: async ({ tick, reason, vitals }) => {}, // your effect: page someone
});
// → { status: "exhausted" | "maxTicks" | "budget" | "failing" | "stopped" | "cancelled", ticks, spent, memory, vitals }
```

**Memory** is the runner's declared `memory` keys. The supervisor injects them
into every tick's inputs (they win over anything `next()` sets) and, after a
completed tick, keeps what the graph wrote to them. A tick that fails leaves
memory untouched. Keep it small: a tally or the last few results, not a
transcript. Jev gets worse on padded state.

**Vitals** are numbers over the last `window` ticks: `tick, ticks, failed,
waiting, failureRate, gateRate, confidence, sameness, streak, cost, spent,
spentToday, msPerTick, costPerCompleted`. `waiting` counts the ticks that paused
for a person and have not been resumed; they are not failures. `sameness` is the share of ticks that took the most
common path. `costPerCompleted` is the window's spend divided by the ticks that
completed — what a finished task really costs, with its failed attempts charged
to it (`null` when nothing completed). Watch that, not the price per call.

**Restarting after a crash.** If the process stopped in the middle of a tick,
the first `next()` after the restart receives
`interrupted: { tick, steps, finished }`: the tick that was running (the same
number `next()` is now being asked for), every step that finished before the
stop as the journal recorded it, and `finished: true` when the run completed but
its checkpoint was lost. A `work` step in that list may already have sent the
email or written the row. **Check before repeating it** — `next()` is the only
place that knows what "already done" means for your system. It is handed over
once, and journalled as an `interrupted` line.

**The watcher** is an ordinary runner that declares
`inputs: ["goal", "vitals", "recent"]` and has a `result` of `"continue"`,
`"alert"` or `"stop"`. `vitals` is the object above, for `when:` edges.
`recent` is plain text, one line per tick, for decide nodes. Check the numbers
first in code, and ask Jev only about meaning. Any other result, or a watcher
that throws, becomes an alert. Watcher cost counts toward the budget. See
`examples/06-watch/watch.mts`.

**The watched work does not author the evidence.** By default `recent` carries
only what the supervisor wrote — `tick 7 · completed · look → assess · 412ms`.
`watch: { evidence: "facts+text" }` appends what each tick returned, which is
richer and is also the tick's own words: use it where the work's output is
trusted, never where a tick handles a support message, a web page, a file or
anything else from outside. A conscience the work can talk to is not a
conscience.

**The journal** is `journal.jsonl`, appended as things happen. It holds `step`
lines as each node finishes (with `lane` and `asked`), a `run` line per tick with
the whole run.json, `watched` lines with the watcher's run, and the supervisor's
own events, including `interrupted` after a restart that found an unfinished
tick. `checkpoint.json` holds tick, spend, memory and the window, and is
replaced atomically after every tick. `pulse.json` is rewritten on every node
event: if its `at` goes stale, the process is stuck or dead. `lock` holds the
pid of the one supervisor allowed on this journal; a second one is refused
while the first is alive, and a stale lock is taken over. Run lines hold the
whole state, so keep images as URLs, not data: URLs.

## 11. A person in the loop

**A person is just another decider.** A `decide` node with `by: "human"` asks a
person the same closed questions — choice, noul, score — so their answer is
typed, their options are wired, and `validate` proves every answer has an edge,
exactly as for Jev. No new node kind, and `graph.json` marks where the people
are (`decide.by: "human"`, `model: "human"`, `cost: "free"`).

```ts
approve: {
  decide: {
    ok:   noul("Should this refund be issued as drafted?"),
    tier: choice("Which approval tier applies?", { standard: …, senior: … }),
  },
  reads: ["goal", "draft", "amount"],   // what the person is SHOWN
  by: "human",
  comment: "reason",                    // optional: where their free-text note lands
},
edges: [
  { from: "approve", to: "pay",    on: "ok" },     // a yes lands as 1, so on: works unchanged
  { from: "approve", to: "refuse" },
],
```

**Answers.** One value per question: an option name for a choice; yes/no for a
noul (`true`/`false` or `"yes"`/`"no"`), which lands on state as **1 or 0**; a
0-based level for a score. A person's answer carries no confidence, so a `gate`
on a human node is refused. An answer that doesn't fit the questions fails the
run with `HumanAnswerError` naming the fix — and never takes the `fallback`,
because it's a bug, not an outage.

**Short runs — wait for them.** Pass a `human` handler and the run waits for it:

```ts
const { result } = await approvals(inputs, {
  human: async ({ node, questions, asked, comment, signal }) => {
    const reply = await slack.askWithButtons(questions, asked, { signal });  // your UI
    return { answers: reply.answers, by: reply.user, comment: reply.note };
  },
});
```

A person's wait is **not** subject to `stepTimeout` — that exists for machines
that hang. Return `undefined` to pause instead.

**Long waits — pause, and resume later.** With no handler (or one that returns
`undefined`) the run stops cleanly: `run.json` has `status: "paused"` and a
`pending` block (`{ node, questions, asked, comment? }`, the questions in
graph.json's readable form), and the outcome carries `paused` — a plain-JSON
snapshot. Store it anywhere. Later, in any process:

```ts
const { result, run } = await approvals.resume(paused, { answers: { ok: "no", tier: "standard" }, comment: "over the limit", by: "dana" });
```

The resumed run is **one continuous record** — same id, the earlier steps, the
person's answer, what followed — and it can pause again at a later human node.
Loop budgets are carried through the pause. `resume` refuses with `ResumeError`
if the graph changed since (its node, edges and loop budgets might mean
something else now) or if it's the wrong runner.

Rules `validate` enforces: no `gate` on a human node; `comment` only on one,
naming an identifier that isn't also a question key; and **no human node inside
a fork lane** — a run can only pause on one lane, so ask after the join.

**Under `supervise`**, a tick that pauses doesn't block the loop and doesn't
count as a failure: it's counted in `vitals.waiting`, saved under
`paused/<tick>.json` in the journal, and handed to `onPaused(paused, tick)` — or
raised as an alert if there's no `onPaused`, so it's never silent.

**From the CLI**, `ensemble run` asks at the terminal when there is one. With no
terminal (a script, CI) it pauses, writes `paused.json` next to `run.json`,
prints the exact resume command, and exits **3**:

```sh
npx ensemble resume runners/refund.mts .ensemble/runs/<id>/paused.json --answer ok=no --answer tier=standard --comment "duplicate" --by dana
```
