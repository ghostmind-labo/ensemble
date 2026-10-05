# Build your own agent, and consume it from a graph

An agent is a program with its own loop: it reads a task, calls a model, maybe calls
tools, and answers. This page is how to write one that an ensemble graph can hand a
step to, in each of the three protocols, and how to wire it in. Every example here is
a file in [`examples/10-delegate/agents/`](../examples/10-delegate/agents) that the
test suite runs against ensemble's own clients.

[Agents](agents.md) has the overview and the pages per protocol. An agent that is meant
to be offered as a ready-made choice has more to satisfy than the protocol:
[section 5](#5-requirements-for-an-agent-meant-for-the-catalog).

## 1. What an agent must do

### Over ACP (a command, spoken to on stdio)

Messages are JSON-RPC 2.0, one per line, on stdin and stdout. Nothing else may be
written to stdout; logs go to stderr.

| The client sends | The agent must |
|---|---|
| `initialize` with `protocolVersion: 1` and `clientCapabilities` | Answer `{ protocolVersion: 1, agentCapabilities, agentInfo, authMethods }` |
| `session/new` with `cwd` and `mcpServers` | Answer `{ sessionId }` |
| `session/prompt` with `sessionId` and `prompt: [{ type: "text", text }]` | Send `session/update` notifications while it works, then answer `{ stopReason }` |
| `session/cancel` (a notification) | Stop, and answer the pending `session/prompt` with `stopReason: "cancelled"`, not with an error |

- The reply is the text of the `agent_message_chunk` updates:
  `{ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }`.
- Stop reasons are `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` and
  `cancelled`. Ensemble treats only `end_turn` as success.
- Report each tool with `tool_call` and `tool_call_update` (`toolCallId`, `title`,
  `kind`, `status`). Ensemble records them; it does not run them.
- Report cost with `usage_update`: `{ used, size, cost: { amount, currency: "USD" } }`.
  This is what lets the run's budget see the agent.
- **Read the client's capabilities.** Ensemble declares no `fs` and no `terminal`
  unless the runner opts in to file access, and a capability that is absent must not
  be called. An agent that needs the disk reads it itself.
- **Ask before anything that changes the world, and expect to be refused.** Call
  `session/request_permission` before a write, a delete or a command. Ensemble answers
  from the runner's policy, which rejects by default:
  `{ outcome: { outcome: "selected", optionId } }` naming the reject option, or
  `{ outcome: { outcome: "cancelled" } }`. An agent that acts without asking leaves the
  runner's policy with nothing to answer
  ([what that looks like](agents-acp.md#agents-tested-with-this-client)).
- **After a refusal, finish the turn.** Carry on without the tool, answer what you can,
  and say in the reply what you were not allowed to do. Ending the turn at the refusal
  loses the half of the task that needed no permission.

### Over A2A (a server, reached by URL)

| The client sends | The agent must |
|---|---|
| `GET /.well-known/agent-card.json` | Serve the Agent Card: `name`, `description`, `version`, `supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }]`, `capabilities`, `skills`, and `securitySchemes` when it needs credentials |
| `SendMessage` with `{ message: { messageId, role: "ROLE_USER", parts: [{ text }] } }` | Answer `{ task }` (or `{ message }` for a reply with no task) |
| `GetTask` with `{ id }` | Answer the task as it is now |
| `CancelTask` with `{ id }` | Stop the work and answer the task, now `TASK_STATE_CANCELED` |

- Requests are JSON-RPC 2.0 over HTTP POST to the interface's `url`, with an
  `A2A-Version: 1.0` header.
- A task has `id`, `contextId` and `status: { state }`. It ends in
  `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, `TASK_STATE_CANCELED` or
  `TASK_STATE_REJECTED`. By default `SendMessage` waits until it does; a long task may
  instead be returned as `TASK_STATE_WORKING` and polled with `GetTask`.
- The result is `artifacts: [{ artifactId, name, parts }]`. A part carries `text`, or
  `data` for JSON.
- Do not end in `TASK_STATE_INPUT_REQUIRED` or `TASK_STATE_AUTH_REQUIRED` when called
  from a graph: nothing there can answer, and the step fails.
- Set `capabilities.streaming: true` only if you implement `SendStreamingMessage`
  (server-sent events, one JSON-RPC response per `data:` line).
- Auth is declared in the card (`securitySchemes`, `securityRequirements`) and
  enforced with ordinary HTTP: a `401` with `WWW-Authenticate` when it is missing.

### Over MCP (one tool)

| The client sends | The agent must |
|---|---|
| `initialize`, then `notifications/initialized` | Answer `{ protocolVersion, capabilities: { tools: {} }, serverInfo }` |
| `tools/list` | List one tool, with an `inputSchema` naming the argument the task goes in |
| `tools/call` with `{ name, arguments }` | Answer `{ content: [{ type: "text", text }] }`, plus `structuredContent` for a JSON result, and `isError: true` when the run failed |

- Name the task argument `prompt` and the runner needs no `input` field.
- MCP has no permission request, so there is nobody to ask. Be **safe by default**:
  when nobody is attending, do not offer the write and shell tools to the model at all,
  and let whoever starts the server opt in with a flag. `agento mcp` does this
  (read-only unless started with `--yes` or `--allow-shell <word>`). Not offering a tool
  is stronger than offering it and refusing.
- Put what the run cost in `structuredContent` (`agento mcp` returns
  `{ status, reason, steps, toolCalls, cost, model }`). Ensemble does not count it, but
  the graph can read it ([how](agents-mcp.md#agento-mcp)).

## 2. A minimal working agent for each

Each of these answers the task with one model call through OpenRouter. A real agent
loops where the model call is; the protocol around it does not change. They are plain
Node with no dependencies.

| File | Start it as |
|---|---|
| [`acp-agent.mjs`](../examples/10-delegate/agents/acp-agent.mjs) | `{ protocol: "acp", command: "node", args: ["examples/10-delegate/agents/acp-agent.mjs"] }` |
| [`a2a-agent.mjs`](../examples/10-delegate/agents/a2a-agent.mjs) | `PORT=4310 node examples/10-delegate/agents/a2a-agent.mjs`, then `{ protocol: "a2a", url: "http://localhost:4310" }` |
| [`mcp-agent.mjs`](../examples/10-delegate/agents/mcp-agent.mjs) | `mcpServers: { toy: { command: "node", args: ["examples/10-delegate/agents/mcp-agent.mjs"] } }`, then `{ protocol: "mcp", server: "toy", tool: "run_task", input: "task" }` |

All three read the same environment:

| Variable | What it is |
|---|---|
| `OPENROUTER_API_KEY` | The key the model call is made with |
| `OPENROUTER_BASE_URL` | Where OpenRouter is reached; default `https://openrouter.ai/api/v1`. Honour it, so the agent also works behind a proxy that meters a run |
| `AGENT_MODEL` | An OpenRouter model id. Check it against the live catalogue; do not copy one from memory |

The heart of the ACP one, to show how little there is:

```js
async function prompt(id, params) {
  const task = params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const update = (change) =>
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: change } });

  const { text, usage } = await askModel(task, session.abort.signal);       // your loop goes here
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  update({ sessionUpdate: "usage_update", used: usage.total_tokens, size: usage.total_tokens,
           cost: { amount: usage.cost, currency: "USD" } });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}
```

## 3. Building it on `@ghostmind-dev/agento`

`@ghostmind-dev/agento` is the Ghostmind agent engine: its own tool loop, guards, a
dollar budget, go/pause/stop hooks and an append-only event log, with Jev guiding the
worker model. As a library, it goes inside a `work` node:

```ts
import { eventLog, openrouter, runAgent } from "@ghostmind-dev/agento";

work: {
  agent: async ({ goal, signal, report }) => {
    const result = await runAgent({
      provider: openrouter({ model: process.env.AGENT_MODEL! }),
      task: { goal, expectation: "One or two sentences: the answer, and what was changed." },
      toolsets: [{ name: "app", description: "What this agent can do.", tools }],
      budget: { maxUsd: 0.05 },
      signal,
      log: eventLog(),
    });
    report({ cost: result.cost, meta: { status: result.status, steps: result.steps, toolCalls: result.toolCalls } });
    return result.answer ?? "";
  },
},
```

[In-process: a `work` node](agent.md) has the full runner.

The same engine is also a command, so it can be declared instead of imported:
`agento acp` ([the declaration](agents-acp.md#the-declarations-to-use)) and
`agento mcp` ([the declaration](agents-mcp.md#agento-mcp)).

## 4. Consuming it

**Declare it, and add a node.**

```ts
agents: {
  toy: { protocol: "acp", command: "node", args: ["agents/acp-agent.mjs"],
         env: { OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}", AGENT_MODEL: "${AGENT_MODEL}" } },
},
nodes: {
  ask:    { agent: "toy", reads: ["goal"], writes: ["reply"] },
  review: { decide: { answered: noul("Does the reply answer the request?") }, reads: ["goal", "reply"] },
  …
}
```

**Judge the reply with a `decide` node.** The agent does not decide whether it did the
job. Route a weak reply back once on an edge with `maxLoops`, or to a person.

**Give the agent the graph's MCP servers (ACP).** An `acp` agent can be handed servers
the runner already declares, by name:

```ts
mcpServers: { fs: { command: "/usr/local/bin/fs-server", args: ["--root", "/srv"] } },
agents: { coder: { protocol: "acp", command: "opencode", args: ["acp"], mcpServers: ["fs"] } },
```

They are sent in `session/new`, and the agent makes the connection, not ensemble.
What is forwarded, exactly:

| The runner's server | Sent as | Condition |
|---|---|---|
| `{ command, args, env }` | `{ name, command, args, env: [{ name, value }] }` | Always: every ACP agent must accept stdio servers |
| `{ url }` | `{ type: "http", name, url, headers: [{ name, value }] }` | Only if the agent advertises `mcpCapabilities.http` |
| `{ url, transport: "sse" }` | `{ type: "sse", … }` | Only if the agent advertises `mcpCapabilities.sse` |

`bearer`, `basic`, an `api_key` header and plain `headers` travel as headers, with
`${NAME}` resolved for the agent. OAuth, mTLS, a custom provider, a query-string key
and WebSocket servers cannot be handed over; `validate` says so. `graph.json` lists
the forwarded servers by name. A2A and MCP agents are not given servers: A2A has no
field for it, and an MCP tool is already on the other side.

**Skills are not forwarded.** No protocol here carries Agent Skills, so an agent node
has no `skills` field. To give an agent a skill, put its text in the message:

```ts
import { findSkill, loadSkills, renderSkills } from "@ghostmind-dev/ensemble";
const skills = loadSkills();
ask: { agent: "toy", prompt: (s) => `${renderSkills([findSkill(skills, "release-notes")!])}\n\n${s.goal}`, reads: ["goal"], writes: ["reply"] }
```

**Cost and budget.** A cost counts only when the agent reports it: over ACP, send
`usage_update` with a USD cost, as the example does. A2A and MCP cannot report one, so
those steps record `meta.cost: "unknown"` and the budget does not see them
([the cost rule](agents.md#cost)). Bound every agent with `stepTimeout` and with
`maxLoops` on the edge that leads back to it.

## 5. Requirements for an agent meant for the catalog

The owner's rules for which agents ensemble will offer as ready-made choices are on the
[overview](agents.md#agents-supported-out-of-the-box-openrouter-only): open source,
OpenRouter as the only model provider, and an approved, version-pinned catalog that is
planned and not built. They do not limit what you may declare yourself. For the agent's
author they come down to four requirements:

1. **No key of its own.** The agent runs with `OPENROUTER_API_KEY` and nothing else: no
   login step, no saved default it depends on, no writable home directory. Every model
   call goes through OpenRouter, and `OPENROUTER_BASE_URL` is honoured, so the agent
   also works behind a proxy that meters a run. Anything that reaches outside
   OpenRouter is named and can be switched off.
2. **Safe by default when unattended.** Over ACP, ask before every write and every
   command, and finish the turn when refused. Over MCP, do not offer write or shell
   tools unless the server was started with a flag that allows them. Offering no write
   tools is the requirement; offering them and refusing is not enough.
3. **It reports what it spent**, in USD: `usage_update` over ACP, `structuredContent`
   over MCP.
4. **It can be pinned.** A released version, launched by a command that names it.

`@ghostmind-dev/agento` is the reference for all four. It runs with only
`OPENROUTER_API_KEY` (and honours `OPENROUTER_BASE_URL`), with no login, no saved
default and no writable home needed, and every model call, including its Jev guide,
goes through OpenRouter. Its web tools are the one thing that reaches outside
OpenRouter (`web_search` through Exa's hosted endpoint, with no key, and `web_fetch`);
`--no-web` turns them off.

## 6. Test it before wiring it in

1. **Against ensemble's client, for $0.** Declare the agent, stub the decider, and run:
   the agent is real, the decisions are not.

   ```ts
   const outcome = await run({ goal: "name a colour" }, {
     decider: async (_state, questions) => ({
       model: "stub", cost: 0, usage: { input_tokens: 0, output_tokens: 0 },
       answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "noul", noul: 1 }])),
     }),
     stepTimeout: 60_000,
   });
   console.log(outcome.run.steps[0].meta);   // status, tool calls, cost: "reported" | "unknown"
   ```

   [`test/agent-examples.test.mts`](../test/agent-examples.test.mts) does this for the
   three example agents, with a local stand-in for OpenRouter so nothing is spent. Copy
   it to test your own. The skill's dry run
   (`node plugin/skills/ensemble-build/scripts/dryrun.mts runner.mts --explore`) is the
   opposite check: it stubs the agent as well, to walk every branch of the graph.
2. **`npx ensemble check runner.mts`.** For A2A it reads the card and says which interface,
   version and auth it found; for ACP it looks for the command on PATH.
3. **The ACP Test Compatibility Kit.** The ACP site documents
   [`acp-tck`](https://github.com/agentclientprotocol/acp-tck) on its
   [Testing page](https://agentclientprotocol.com/libraries/testing): it launches your
   agent as a stdio subprocess and drives initialization, the session lifecycle, prompt
   turns, cancellation, error handling and transport hygiene. The page says it is
   experimental and that a passing run is not an official statement of conformance.
   Whether the example agents were run through it is in the
   [status](agents.md#status-2026-10-03).
