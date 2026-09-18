# Finding models, skills and MCP servers

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
what still has to be set. A remote-only server (no stdio package) can't be used,
because this client speaks stdio.

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
