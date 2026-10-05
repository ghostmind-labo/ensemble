# Finding models, skills, MCP servers and agents

A runner only names what exists. Look things up live; never type an id, a price
or a capability from memory, because all three change weekly.

## Models (OpenRouter)

At authoring time, to name a fixed model:

```sh
# every model that can SEE, cheapest input first
curl -s https://openrouter.ai/api/v1/models | jq -r '
  .data[] | select(.architecture.input_modalities | index("image"))
  | "\(.pricing.prompt | tonumber * 1e6 | . * 100 | round / 100)\t\(.id)"' | sort -n | head -20

# every model that can DRAW (outputs images)
curl -s https://openrouter.ai/api/v1/models | jq -r '.data[] | select(.architecture.output_modalities | index("image")) | .id'

# one model's card
curl -s https://openrouter.ai/api/v1/models | jq '.data[] | select(.id=="<id>") | {id, context_length, architecture, pricing}'
```

Prices are USD per token, as strings. Multiply by 1e6 for the per-million figure
people quote. A price of `0` usually means a meta-router with no fixed price, not
something free.

At run time, to keep the graph durable, resolve the id in a `code` node:

```ts
const pool = shortlist(await catalog(), { vision: true, maxPromptUsdPerM: 1, minContext: 32_000 })
  .filter((m) => m.promptUsd > 0);
```

Then use `model: { from: "that_key" }`. Pattern 5 in `patterns.md` shows the full
shape.

Match the capability to the job. `sees:` needs `vision`, and a second write key
needs `draws`. Nothing else constrains the model: it **never** needs tool support,
because `mcp` nodes make the calls.

## Skills (Agent Skills standard)

```sh
npx ensemble skills            # visible here, spec-checked (✗ = fix needed)
npx ensemble skills pdf        # filter
npx ensemble skills --remote x # public index. Unofficial and may be down, so never depend on it
```

`loadSkills()` searches `.ensemble/skills` and `.claude/skills` in the project,
then `~/.ensemble/skills` and `~/.claude/skills`, then installed Claude plugins.
The nearest definition wins.

A skill is `<name>/SKILL.md` with frontmatter containing `name` (lowercase and
hyphens, 64 characters or fewer, matching the folder) and `description` (1024
characters or fewer). Optional fields: `license`, `compatibility`, `metadata`,
`allowed-tools`. Don't invent other fields.

To give a runner a skill that doesn't exist yet, write it into
`.ensemble/skills/<name>/SKILL.md` in the project. It is then local, enumerable
and shows up as a `choice` option through `skillOptions()`.

## MCP servers (official registry)

```sh
npx ensemble servers github    # search; shows the launch command and ⚠ missing env vars
```

In code: `const [entry] = await searchServers("filesystem"); toServerSpec(entry)`
gives `{ command, args, env }` for `mcpServers`, and `missingEnv(entry)` lists
what still has to be set. For a remote-only server it gives `{ url, transport }`,
which may still ask for a login (`npx ensemble mcp login <server>`).

To choose a tool on a server, list its tools once while writing the runner and
freeze them into the file:

```ts
import { connect, toolOptions } from "@ghostmind-dev/ensemble";
const session = await connect("fs", { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] });
console.log(JSON.stringify(toolOptions(await session.listTools()), null, 2));
session.close();
```

Paste the result into a `choice` in the runner. Don't call `listTools()` at
module scope: that would start a process just to validate the file.

When the use case needs a server, record in the hand-over which env vars it needs,
and whether `npx` has to download it on first run.

## Agents (A2A cards, the ACP registry, the MCP registry)

An `agent` node names an entry of the runner's `agents`. There is no single
directory of agents: where to look depends on the protocol. Which protocol fits
is in the skill's `SKILL.md` ("When a step is an agent").

**OpenRouter lists models, not agents.** It has no public directory of agents
to search. What its documentation does have is "interns" (agents a person
creates on OpenRouter, listed only for their own API key) and a beta
`openrouter:subagent` server tool (a model hands a task to a smaller worker
model inside one call). Neither is a place to find someone else's agent, so the
three sources below are the ones to use.

**A2A: the agent's own card.** There is no central A2A list, by design: each
agent publishes its own card at its own address. Get the address from whoever
runs the agent, then read the card:

```sh
npx ensemble agents card https://agent.example.com        # JSON on stdout; the agents: { … } line to paste on stderr
npx ensemble agents card https://agent.example.com --header authorization="Bearer $TOKEN"   # a card behind auth
```

The card is looked for at `<url>/.well-known/agent-card.json`; a url ending in
`.json` is taken as the card itself. In code:
`await agentCard("researcher", { protocol: "a2a", url })` returns
`{ name, description, version, interfaces, streaming, skills, security, raw }`.
Read `interfaces` (this client speaks `JSONRPC` and `HTTP+JSON`) and `security`
(what `auth` to declare) before writing the declaration.

**ACP: the protocol's registry.** One published JSON file lists the agents that
speak ACP and how each is launched:
https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json

```sh
npx ensemble agents            # every agent, with the declaration that launches it
npx ensemble agents code       # filter by id, name or description
```

An entry distributed through `npx` or `uvx` prints a declaration that works as
written (`{ protocol: "acp", command: "npx", args: ["-y", "<package>", …] }`);
one distributed as a binary says so, and is installed first and then named by
its command. In code: `const [entry] = await searchAgents("code");
toAgentSpec(entry)` gives the declaration, or `undefined` for a binary. Any
program that speaks ACP on stdio works whether or not it is listed.

The registry says how to launch an agent, not how it behaves. Before declaring
one, find out what it does without asking and how its own configuration is set
to ask (the safety rule in `SKILL.md`). Two have been run with this client,
`agento acp` and `opencode acp`: their declarations are in `api.md` §3
("Tested declarations").

**MCP: a tool that is an agent.** Some servers offer an agent as one tool (a
prompt in, an answer out). Find the server in the official MCP registry with
`npx ensemble servers <q>`, declare it in `mcpServers`, list its tools once as
shown above, and name the tool:
`{ protocol: "mcp", server: "tools", tool: "ask_agent", input: "prompt" }`,
where `input` is the argument the message goes in. `agento mcp` serves agento
that way, with the tool `run_task` (`api.md` §3).

**Which agents to prefer.** The ones supported out of the box are open source
and use OpenRouter as their only model provider, so `OPENROUTER_API_KEY` is the
one key and the one bill: `agento` and `opencode` first. An approved,
version-pinned catalog of them is planned; until it exists, an agent is
installed by hand and declared.

**The commands, all of them:**

| Command | What it does |
|---|---|
| `npx ensemble agents [query]` | Search the ACP registry; print each agent and the declaration that launches it |
| `npx ensemble agents card <url> [--header k=v]` | Read an A2A agent's card |
| `npx ensemble agents list <runner file>` | The agents a runner declares: name, protocol, where, and the auth mode or permission policy. Never a secret |
| `npx ensemble servers [query]` | Search the MCP registry, for an agent offered as a tool |
| `npx ensemble mcp login <agent or server> <runner file>` | Log in once to an OAuth A2A agent or MCP server |
| `npm run check -- <runner file>` | Confirm each declared agent can be reached from here |

Record in the hand-over what has to be installed, which secret or login each
agent needs, and whether it reports a cost.
