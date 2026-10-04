# validate messages and their fixes

`ensemble validate` prints problems as `· <message>`. Each message already names
its fix. This table covers the intent behind each one, so you fix the design and
not just the symptom.

| Message contains | What it means | Fix |
|---|---|---|
| `is not a node. Nodes:` (entry) | `entry` names a node that doesn't exist | Point `entry` at the first node |
| `is none of decide / work / code / model / mcp / agent` | The node has no kind key, often a typo like `decides:` or `models:` | Use exactly one of `decide`, `work`, `code`, `model`, `mcp`, `agent` |
| `is both X and Y` | Two kind keys on one node | Split it into two nodes joined by an edge |
| `has an empty decide block` | `decide: {}` | Ask at least one question, or make the node something else |
| `which is not a valid identifier` | A question key like `"needs text"` | Use `needs_text`. Keys become state keys and branch labels |
| `declares no reads` | A decide node without `reads` | Add the *minimal* keys, usually `reads: ["goal"]`. Don't send everything: accuracy falls with irrelevant state |
| `holds image data and Jev takes text only` | A decide node reads a key that a model node `sees` or draws | Add a `model` node that looks and writes a sentence (`writes: ["scene"]`), then read `scene` instead |
| `gates on "x", which it does not ask` | `gate.on` is misspelled or names another node's question | Name a question of *this* node |
| `gates on "x", a noul` | A noul has no confidence, because its value *is* its certainty | Branch with `on: "x>=0.8"` or `on: "!x"`, or gate on a choice or score |
| `gates to "x", which is not a node` | Bad `gate.to` | Name an existing node, usually a safe exit |
| `gate.min … between 0 and 1` | For example `min: 70` | Use `0.7` |
| `runs work "x", which is not in the work map` | A handler name that isn't registered | Add `x` to `work: {}`, or fix the name |
| `declares code that is not a function` | `code: "…"` | `code: (s) => …` |
| `names no model` | Empty `model` | A live-checked id, or `{ from: "key" }` |
| `has no prompt` | A model node without a `prompt` | Add the instruction, as a string or `(s) => string` |
| `writes at most two keys, positionally` | A model, mcp or agent node with 3+ writes | `[text]` or `[text, images/data/detail]`. Split any extra fields out in a `code` node after it |
| `both looks at and overwrites` | `sees: ["img"]` and `writes: [_, "img"]` | Write the drawn images to a new key |
| `names skill "x", which is not in the runner's registry` / `loaded no skills` | A model node lists a skill the runner didn't load | Pass `skills: loadSkills()` to the runner, or fix the name (`ensemble skills` lists them) |
| `uses MCP server "x", which the runner does not declare` | Missing `mcpServers.x` | Declare `{ command, args }`, found via `ensemble servers <q>` |
| `names no tool` | Empty `mcp.tool` | A tool name, or `{ from: "key" }` |
| `MCP server "x" needs a command (a local process) or a url` / `has both` | A server spec with neither or both | `{ command, args }` locally, `{ url }` for a hosted one |
| `MCP server "x" … auth (oauth) uses client_credentials, so it needs clientSecret` (and similar `auth (…) needs …`) | An auth mode missing a field | Add the field it names, as `"${NAME}"` |
| `auth (mtls) needs an https:// or wss:// url` | mTLS on plain http/ws | Use TLS |
| `mcp "x": needs NAME, which is not set` (run time) | A `${NAME}` the secret resolver could not find | Set it, or pass `secretResolver` |
| `mcp "x": needs a login — run: npx ensemble mcp login x --url …` (run time) | An OAuth server with no stored login | Run that command once; runs never open a browser |
| `mcp "x": needs more access (scopes: …)` (run time) | 403 insufficient_scope on a person's login | Run the login command again; the wider scopes are remembered |
| `⚠ … has a literal secret in …` (warning) | A token or password written inline | Write `"${NAME}"` and set NAME in the environment |
| `names no agent — give it a key of the runner's agents: { … }` | An agent node with an empty `agent` | Name a declared agent |
| `delegates to agent "x", which the runner does not declare` | Missing `agents.x`, or a typo (the message lists `Declared:`) | Declare it: `agents: { x: { protocol: "a2a", url: "https://…" } }`, or fix the name |
| `has a prompt that is neither text nor a function` / `has an empty prompt` | A bad `prompt` on an agent node | Write the request, or leave `prompt` out to send the node's reads |
| `an agent node writes at most two keys, positionally: [text] or [text, detail]` | 3+ writes on an agent node | Take what you need out of `detail` in a `code` node after it |
| `agent "x" has protocol … — say how it is reached: protocol: "a2a" (a hosted agent, by url), "acp" (a local agent, launched as a command) or "mcp" (an agent offered as a tool)` | No `protocol`, or an unknown one. The message guesses from the fields (`This one looks like protocol: "a2a"`) | Add the `protocol` it names |
| `agent "x" needs url — where the agent lives` / `which is not a url` / `an A2A agent is reached over http(s)://` | An a2a agent without a usable `url` | A full `https://…` address |
| `agent "x" has card "…", which is not a url` (or `endpoint`) | A bad `card` or `endpoint` | A url, absolute or relative to `url` |
| `has binding "…" — use "JSONRPC" or "HTTP+JSON", or leave it out (gRPC is not spoken)` | An unknown binding | One of the two, or none |
| `has version "…" — use "1.0" or "0.3", or leave it out to read it from the card` | An unknown A2A version | One of the two, or none |
| `agent "x" auth (…) needs …` | An auth mode missing a field, as for a remote MCP server | Add the field it names, as `"${NAME}"` |
| `agent "x" needs command — the program that speaks ACP on stdio, e.g. command: "opencode", args: ["acp"]` | An acp agent without a `command` | Name the program |
| `has args that are not a list of strings` | `args: "acp"` | `args: ["acp"]` |
| `has permissions … — use "reject" (the default), "allow", or { allow: ["read", "search"] }` | A bad permission policy | One of the three forms |
| `allows "x", which is not an ACP tool kind. Kinds: read, edit, delete, move, search, execute, think, fetch, switch_mode, other` | A typo in `{ allow: [...] }` | Use the listed kinds |
| `has mcpServers that is not a list — name the runner's servers to hand over: mcpServers: ["fs"]` | An acp agent's `mcpServers` is not an array of names | A list of keys of the runner's `mcpServers` |
| `agent "x" is handed MCP server "s", which the runner does not declare` | A name in an acp agent's `mcpServers` with no declaration | Declare `s` in the runner's `mcpServers`, or fix the name |
| `agent "x" cannot be handed MCP server "s": …` (also at run time) | The server cannot travel to the agent: `it is a WebSocket server, and ACP forwards stdio, http and sse servers only`; `its auth (oauth) cannot be handed to another program — use bearer, basic, an api_key header or headers`; or, known only at the handshake, `the agent does not advertise mcpCapabilities.http, so it cannot connect to a url server` | Hand over a local (`command`) server, or a `url` server with header-borne auth to an agent that takes http or sse servers |
| `asks for a terminal — this client never offers one` | `terminal` on an acp agent | Remove it. The agent runs commands with its own tools, gated by `permissions` |
| `agent "x" needs server — a key of the runner's mcpServers` / `uses MCP server "s", which the runner does not declare` | An mcp agent without a declared server | Declare the server in `mcpServers`, or fix the name |
| `agent "x" needs tool — the name of the tool that IS the agent` | An mcp agent without `tool` | Name the tool |
| `⚠ agent "x" has a literal secret in env["KEY"] — write it as "${NAME}" and set NAME in the environment` (warning) | A key written inline in an acp agent's `env` | `env: { KEY: "${NAME}" }` |
| `⚠ agent "x" sends credentials to … without TLS — use https://` (warning) | An a2a agent with auth or headers on plain http, not on localhost | Use `https://` |
| `edge N (a→b): "x" is not a node` | A typo in `from` or `to` | Fix the name |
| `has both on and when` | Mixed branch forms | Meaning goes in `on`, arithmetic in `when`. Pick one |
| `cannot parse on:` / `"!" cannot be combined` / `is not a number` | Bad `on:` syntax | Grammar: `k=opt`, `k`, `!k`, `k>=0.7` |
| `leaves "x", which is not a decide node` | An `on:` edge leaving a work, code or model node | Use `when: (s) => s.k === "opt"` for keys written earlier, or move the edge onto the decide node |
| `reads "k", which "x" does not ask` | `on:` names a question of another node | Branch where the question is asked, or use `when:` |
| `uses "=", which only a choice answers` | `on: "urgent=yes"` on a noul | `on: "urgent"` or `on: "urgent>=0.7"` |
| `has no option "o". Declared:` | A typo in an option name | Use one of the declared names exactly |
| `thresholds "k", a score` | `on: "quality>=1.5"` | `when: (s) => Number(s.quality) >= 1.5`. A score is a number |
| `thresholds "k", a choice` | `on: "team>=0.5"` | `on: "team=billing"`. To use confidence, set `gate` |
| `asks "k" but nothing handles "a", "b"` | Options without an edge, where the run would silently end | Wire each one. Add a bare default edge only if one shared fallback is really intended |
| `a noul, but nothing handles an answer of …` / `just above …` | Threshold edges on a noul leave part of the 0–1 range with no edge, so the run would fall through to the exit there | Add the edge the message names (`on: "k<0.8"`, or the missing band), or a default edge from that node with no `on`/`when`. Only reported when the fall-through is provable: no forks, no `when:`, no already-exhaustive choice at the node |
| `reads "k" but nothing writes it` | A key with no origin | If it comes from the caller, add it to `inputs`. If a node should produce it, add it to that node's `writes`. Often a typo: compare with the "Written in this runner" list |
| `in its when() but nothing writes it` | A `when` touches a missing key | Same fix. Also check `s.k` spelling in the predicate |
| `result: "k" is never written` | Bad `result` | Name a key that a final node writes |
| `unreachable from "entry"` | Nodes that no edge or gate leads to | Wire them in, or delete them |
| `has N forking edge(s) and M ordinary — a node's edges are all forks` | Mixed `fork: true` and plain edges on one node | Mark them all `fork: true`, or move the ordinary edges to another node |
| `is join: "all" but only one edge leads there` / `no edge leads there` | A join with fewer than two incoming edges | Point each lane's last edge at it, or drop the join |
| `entry "x" is a join` | The entry node is a join | Start from a plain node |
| `forks to "a" and "b", but both lanes reach "x"` | Two lanes share a node that isn't a join | Mark it `join: "all"` if the lanes should meet there, or give each lane its own node |
| `but the lanes both touch "k" — concurrent lanes must write and read disjoint keys` | One lane writes a key another lane writes or reads | Write to separate keys and combine them after the join |
| `memory key "k" is never written` | A declared memory key with no writer | Add it to a node's `writes`, or declare it in `inputs` instead |
| `"k" is both an input and memory` | Same key in both lists | Pick one: inputs arrive each run, memory carries over |

## Failures that validate cannot see (found by dryrun or a live run)

| Symptom | Cause | Fix |
|---|---|---|
| `x.x` nested in state, or a later `when` always false | One write key got an object | Return the bare value |
| `declares writes a, b but returned string` | Several write keys, non-object return | Return `{ a, b }` |
| `returned no b` | The multi-write object is missing a key | Return every declared key |
| A loop runs to `maxSteps` | A back-edge without `maxLoops`, or a `when` that never flips | Add `maxLoops` plus a following exit edge |
| `result` is `undefined` | The path taken never wrote the `result` key | Make every exit node write it |
| `takes its tool from "k", which is "none"` | A `tool=none` answer reached an mcp node | Route `on: "tool=none"` somewhere else first |
| A safety edge is skipped on unsure answers | A `gate` on the same node fires before any edge | Split the node into screen (overrides) → route (gated choice), or send the gate to the same safe exit |
| A `when:` key shows `readBy: []` in `graph.json` data | `&&` / `||` / `?:` short-circuited during the probe, so validation never saw that key | Read every key into a variable before combining them |
| An edge never taken in `--explore` | Dead wiring, a shadowing edge above it, or a `when` the stubs never tripped | Reorder, delete, or confirm the `when` with `--answer` |
| `asked "k" but the decider returned no answer for it` | Whatever is mounted on the `Decider` seam — a stub, a cache, a fallback model — left a question out (`DeciderAnswerError`, reaching the caller as `RunFailed.cause`) | Answer every question handed in, keyed as asked. Declaring `fallback` routes it instead of failing |
| `asked "k" and the decider said something the graph cannot route: …` | The answer is outside the closed question: an option that was never declared, a level or probability out of range, or the wrong answer type. The run would have exited having done nothing (`DeciderAnswerError`) | Fix the decider — a stub must return the declared option names and types. An answer that does not fit is no answer, so it takes the node's `fallback` when there is one |
| `no OpenRouter key — set OPENROUTER_API_KEY` | A live run reached a decide or model node with no key (`JevError` / `OpenRouterError`) | Set `OPENROUTER_API_KEY`, or pass `openrouter: { apiKey }` on the runner. It is the only key: Jev is reached through OpenRouter too |
| `jev: out of credits — add some at https://openrouter.ai/credits (HTTP 402)` | The OpenRouter account is empty. Not retried | Top up the account; one balance pays for decisions and generation alike |

## Delegation: an agent step that fails

The declaration messages (`agent "x" needs …`, `has protocol …`) are in the
validate table above. This section is what `check` and a run say.

Almost every one is an `AgentError`: the step's `error` starts
`agent "<name>": `, the caller gets it as `RunFailed.cause`, and the step keeps
what the agent had done before it stopped (`meta.status`, `served`,
`toolCalls`, `permissions`, `usage`). The text of a half-finished reply is on
`RunFailed.cause.partial.text`, not in `run.json`. The one exception is a
failure of the MCP server under an `mcp` agent, which starts `mcp "<server>": `.

### From `check`

| Message contains | What it means | Fix |
|---|---|---|
| `agent "x" runs "cmd", which is not on PATH here — install it, or give the full path as command` | acp: the command is not installed on this machine | Install it, or give the full path |
| `NAME is not set — needed by agent "x"` | A `${NAME}` the agent's `auth`, `headers`, `env` or `args` uses | Set it in the environment |
| `agent "x" declares security (…) and the runner gives it no auth — add auth to agents.x if calls are refused` (a note) | a2a: the card names security schemes and the declaration has no `auth` | Add `auth`, unless the agent serves anonymous callers |
| `node "n" launches agent "x" as a local process over ACP (…); permission requests are answered "reject"` (a note) | acp: what a run will start, and the policy | Read it: is that the command and the policy you meant? |
| `agent "x" is a local process (acp): it cannot start in the cloud, use a hosted agent (protocol: "a2a") or an agent offered as a tool of a remote MCP server (protocol: "mcp" on a url server)` (a warning, from hosted ensemble's check) | An `acp` agent in a runner checked in hosted ensemble | For a hosted run, declare the agent with `a2a`, or `mcp` on a remote server. The `acp` declaration runs with the local library |
| `MCP server "s" is a local process (stdio): it cannot start in the cloud, use a remote server (url)` (a warning, from hosted ensemble's check) | An `mcp` agent whose server is a local command, checked in hosted ensemble | A remote (`url`) server for a hosted run |
| Any of the a2a card messages below | `check` reads the card the way a run does | As below |

### From a run

| Message contains | What it means | Fix |
|---|---|---|
| `needs NAME, which is not set` | A `${NAME}` in the agent's `auth`, `headers`, `env` or `args` could not be resolved | Set it, or pass `secretResolver`. `check` reports it as `NAME is not set — needed by agent "x"` |
| `could not reach <url>: …` | a2a: no connection to the card or the endpoint | Check the `url`; hosted runs reach public addresses only |
| `no Agent Card found — tried … An A2A agent publishes one at /.well-known/agent-card.json; set card: "<url>" on the agent if it is elsewhere` | Nothing at the well-known paths | Set `card`, or point `url` at the card itself (a url ending in `.json`) |
| `answered, but not with an Agent Card — set card: "<the card's url>" on the agent` | The address served something else (a web page, another JSON) | Set `card` |
| `its card offers GRPC, and this client speaks JSONRPC and HTTP+JSON — ask the agent's owner to enable the JSON-RPC binding` | No binding in common | The owner enables JSON-RPC or HTTP+JSON |
| `its card offers no <binding> interface (offered: …) — drop binding, or pick one it offers` | `binding` asks for one the card lacks | Drop `binding` |
| `offers A2A 0.3 over HTTP+JSON only, which this client does not speak — it needs the JSON-RPC binding or A2A 1.0` | An old dialect on the one binding it is not spoken on | The owner enables JSON-RPC, or upgrades |
| `its card sends requests to <url>, a different origin from <home> — credentials are not forwarded there on a card's say-so. If that address is right, set endpoint: "<url>" on the agent` | The card names another origin and the agent has `auth` or `headers` | Set `endpoint` once you have checked the address |
| `its card names "…" as its address, which is not a url — set endpoint: "<url>" on the agent` | A broken card | Set `endpoint` |
| `the server rejected the bearer token (HTTP 401)` / `the server wants credentials (HTTP 401, Basic) — add auth to its spec` | Wrong or missing credentials | Fix the secret, or add `auth` to `agents.x`. For OAuth: `npx ensemble mcp login x <runner file>` |
| `<url> refused: …` | The agent answered with an error (a JSON-RPC error or an HTTP status) | Read the rest of the message; it is the agent's own |
| `the task stopped at input-required: … — the agent is asking a question, and nothing inside a run can answer it (the task was cancelled). Put what it needs in the node's prompt or reads, or ask a person first with a by: "human" node and pass their answer in` | The agent wants more before it continues, and one node execution is one message | Send what it asked for up front, or put a `by: "human"` node before the agent node |
| `the task stopped at auth-required: … — the agent needs a credential it was not given (the task was cancelled). Authorise it out of band, or add auth to agents.x` | The agent needs access to something on your behalf | Authorise it where the agent says, or add `auth` |
| `the task ended failed: …` (or `rejected`, `canceled`) | The agent's own task ended badly | The text after the colon is the agent's reason |
| `did not finish within Nms — raise timeoutMs on the agent if it needs longer (task … cancelled)` | a2a: the agent's `timeoutMs` (default 10 minutes) passed | Raise `timeoutMs`, or ask for less. `cancel not confirmed` means the agent did not acknowledge the cancel |
| `was aborted (task … cancelled)` / `was aborted — the turn was cancelled` | `stepTimeout`, the budget or the caller's `signal` stopped the run | Expected. The task or turn was cancelled on the agent's side too |
| `could not start "cmd" — it is not installed or not on PATH` | acp: the command does not exist here. `check` says `runs "cmd", which is not on PATH here — install it, or give the full path as command` | Install it, or give the full path |
| `the agent exited (N) before answering: …` | acp: the process died; the tail of its stderr follows | Run the command by hand to see why |
| `initialize did not answer within 30000ms — is "cmd" an ACP agent? (e.g. opencode acp)` | acp: the program started but does not speak ACP on stdio | Add the argument that puts it in ACP mode (`args: ["acp"]`) |
| `speaks ACP protocol version 2, and this client speaks 1 — use a release of the agent that still offers v1` | A version mismatch | Use a release that offers v1 |
| `the agent wants a login before it opens a session … A run cannot log in for it: run the agent's own login once in a terminal (or give it its key through env: { KEY: "${NAME}" }), then run again` | acp: the agent is not logged in | Log in once by hand, or pass its key through `env` |
| `did not finish within Nms — the turn was cancelled. Raise timeoutMs on the agent if it needs longer` | acp: `timeoutMs` passed | Raise it, or ask for less in one turn |
| `the agent refused to continue (stop reason: refusal) — rephrase the prompt, or route this request elsewhere` | acp: the model behind the agent refused | Rephrase, or route that kind of request to another branch |
| `stopped at max_tokens before it finished, so its reply is incomplete — ask for less in one turn, or raise the agent's own limit` (or `max_turn_requests`) | acp: the agent hit its own limit | Narrow the prompt, or raise the limit in the agent's config |
| `session/new failed: …` | acp: the agent refused to open a session, for a reason other than a login | The rest of the message is the agent's own |
| `ended the turn with stop reason "…", which ACP v1 does not define (end_turn, max_tokens, max_turn_requests, refusal, cancelled)` | acp: a non-standard agent | Report it to the agent's owner; use another agent |
| `the agent cancelled the turn` | acp: the agent answered `cancelled` and nothing here asked it to | Run the command by hand to see why |
| `the tool <server>/<tool> failed: …` | mcp: the tool that is the agent returned `isError: true`. For `agento mcp`: an unfinished run, or `OPENROUTER_API_KEY is not set in the agento server's environment` | The text is the tool's own |
| `mcp "s": tools/call timed out after 30000ms` | mcp: the agent took longer than its server's `timeoutMs` (30 s by default) | Raise `timeoutMs` on the `mcpServers` entry, e.g. `300_000` |
| `mcp "s": needs NAME, which is not set` / `mcp "s": needs a login — run: npx ensemble mcp login s --url …` | mcp: the server under the agent lacks a secret or a login | As for any MCP server |
| `answered without a task id while the task was "…", so there is nothing to wait on` (after `<url> refused:`) | a2a: the agent returned an unfinished task with no id | A broken agent: report it to its owner |

### Not errors, and still to act on

The step completed. These are read from `run.json`, the reply, or the disk.

| Symptom | What it means | Fix |
|---|---|---|
| The reply says it was not allowed to edit, and `meta.permissions` shows `outcome: "rejected"` | acp: the policy answered the agent's request. `permissions: "reject"` is the default | Expected. To let it, name the kinds it may use: `permissions: { allow: ["edit"] }`. `"allow"` says yes to everything it asks |
| Files changed or a command ran, and `meta.permissions` is empty | acp: **the agent acted without asking**, so the policy never got a say. `opencode acp` does this as it ships | Set the agent's OWN configuration to ask, through `env` (opencode: `env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"ask","bash":"ask","webfetch":"ask"}}' }`), and give it a `cwd` you are willing to expose |
| The reply is short, or skips part of the task, right after a rejected permission | acp: the agent ended its turn at the refusal (seen with opencode once configured to ask) | The `decide` node after the agent catches it. Route the weak reply to one retry with a narrower prompt, or to a hand-off |
| `meta.toolCalls` is empty although the agent clearly worked | The agent did not report its tool calls, or the protocol has no way to (a2a, mcp) | Nothing to fix in the runner. Judge the reply, not the tool list |
| The reply mentions `fs/read_text_file is not offered by this client` or `path is outside the session directory` | acp: the agent asked for a client file method that is off, or for a path outside `cwd` | `fs: { read: true }` / `{ write: true }`, and set `cwd` to the directory it should work in |
| A delegated step shows `cost: 0` and `meta.cost: "unknown"` | The protocol reported no cost (A2A and MCP never do; an ACP agent may not) | Expected. It is not free: the spend is on the agent's side and outside the run's `budget`. Bound it with `stepTimeout`, `timeoutMs`, the agent's own cap and `maxLoops` |
| A hosted run's cost is lower than the agents' own bills | Hosted ensemble counts only calls through its OpenRouter proxy; an agent's own reported cost is not added | Expected. Ask the agent's owner what a call costs |

## A person in the loop

| Message or symptom | What it means | Fix |
|---|---|---|
| `is answered by a person and has a gate` | A gate on a `by: "human"` node | A person's answer has no confidence. Remove the gate; route on the answer with `on:` edges |
| `has by: "…" — omit it for the decider, or write by: "human"` | A typo, or another value | Only `"human"` exists |
| `declares comment but is not by: "human"` | A note key on a decider node | Only a person leaves a note |
| `writes its comment to "k", which is also a question key` | The note would overwrite an answer | Give the note its own key |
| `that lane asks a person at "x" — a run can pause on only one lane` | A human node between a fork and its join | Move the question after the join |
| `falls back to "x", which is not a node` | Bad `fallback` | Name an existing node, usually a person or a hold |
| `"k" is yes or no, not …` / `is one of …, not …` / `is a level from 0 to N` / `got no answer — answer every question` | The person's answer doesn't fit the closed question (`HumanAnswerError`) | Fix the integration that built the answer. It deliberately does not take the fallback |
| `the graph changed since this run paused` (`ResumeError`) | The runner was edited between pause and resume | Resume with the graph that paused it, or start a new run |
| `this run paused in "a", not "b"` | Resumed with the wrong runner | Use the runner named in the snapshot |
| `ensemble run` exits 3 | The run paused for a person and there was no terminal to ask | Expected. Run the printed `ensemble resume … --answer …` |
| `took: "fallback"` in a step | The decider could not answer, and the node declared a fallback | Expected. Read the step's `error` for why |

## calibrate and supervise

| Message or symptom | What it means | Fix |
|---|---|---|
| `case N tests X, which reads k — add "k" to its inputs` | A case lacks a key the node reads, maybe one a model node normally writes | Put that key in the case's `inputs`. For a model-written key, use the text the model would produce |
| `expects "k", which no decide node asks` | Wrong key | Use `node.key` as listed by `ensemble graph … \| jq '.nodes[].questions'` |
| `which more than one node asks — write it as node.key` | A bare key is ambiguous | Use `node.key` |
| `is a choice — expect one of …` / `a noul — expect true or false` / `a score — expect a level from 0 to N` | The label has the wrong type | Option name, boolean, or 0-based integer level |
| `has set "…" — a case is "dev" (tuned against) or "holdout" (looked at once)` | A third set name | Cases are tuned against (`dev`, the default) or frozen (`holdout`) |
| `gap` shows a drop of 0.1+ between dev and holdout | The questions were fitted to the dev cases | Rewrite the boundaries (`not_for`) from the holdout misses, then get NEW holdout cases — the old ones are now dev |
| the watcher never mentions what a tick produced | Default: `recent` carries supervisor-written facts only | `watch: { evidence: "facts+text" }`, and only where the tick's output is trusted |
| `did not finish within Nms` | `stepTimeout` fired: a handler, model or tool call hung | Find the slow call in the step's `node`. Raise the limit only if that call is legitimately slow |
| status `failing`, alert `N ticks in a row did not complete` | `maxStreak` consecutive ticks failed | Read the `run` lines in `journal.jsonl` for the failing step's `error` |
| alert `the watcher returned … — it must return "continue", "alert" or "stop"` | The watcher's `result` isn't one of the three | Make every watcher exit write one of the three strings, and set `result` or end on a node that returns it |
| a `rest` event, then nothing for hours | `budget.perDay` is spent. It sleeps until the oldest spend is 24 h old | Expected. Raise `perDay`, or cut the cost per tick |
| memory resets after a restart | No `journal` directory, or `resume: false` | Pass the same `journal` path every time |
| memory never changes | The runner writes the key on a path that fails, or not at all | Only completed ticks update memory. Check the `run` lines for that node's `error` |
| `next()` receives `interrupted` after a restart | The process stopped mid-tick; the journal shows steps with no checkpoint after them | Look at `interrupted.steps` before asking for the tick again: a `work` step there may already have had its effect. `finished: true` means every effect happened and only the memory update was lost |
| `run.cost.total` is higher than the completed steps add up to | A step reported a cost and then threw; that money was still spent | Expected. Report cost as early as it is known, so a failure cannot hide it |
| `is held by process N, which is still running` | Another supervisor owns this journal | Stop it, or use another `journal` path. A dead holder's lock is taken over automatically |
| stopped with `SIGTERM received — stopping after the tick in flight` | A deploy or ctrl-C | Expected: the tick finished and was checkpointed. Restart with the same `journal` to resume |
