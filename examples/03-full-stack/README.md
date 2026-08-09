# 03 — Full Stack

**Both runtimes, an MCP server, and a skill, in one scene** — and a measured answer to
"what am I actually buying with `runtime: "agent"`?"

```
plan ──────────► inspect ──────────► write
runtime "model"  runtime "agent"     runtime "agent"
gemini-2.5-flash sonnet-5            haiku-4.5
no tools         mcp: ["fs"]         skills: ["release-notes"]
~176 tokens      reads real files    applies house style
```

---

## Where everything lives

This is the part that isn't obvious. **ensemble owns none of it** — MCP servers and
skills are opencode's registries, and opencode looks in two places: your project, and
your home directory.

```
~/.config/opencode/opencode.json     ← MCP servers, GLOBAL (all projects)
~/.claude/skills/<name>/SKILL.md     ← skills, GLOBAL
~/.config/opencode/skills/<name>/    ← skills, GLOBAL (alternative location)

my-project/
├── opencode.json                    ← MCP servers, THIS PROJECT   ← used here
├── .opencode/skills/<name>/SKILL.md ← skills, THIS PROJECT        ← used here
├── package.json                     ← needs "type": "module"
└── audit.ts                         ← the scene
```

Project entries win over global ones. `ensemble skills` and `ensemble mcp` show you
the merged result, with a `project:` / `global:` tag on each so you know where a given
one came from.

This example is deliberately **project-scoped** — its `opencode.json` and
`.opencode/skills/` are right here in the folder, so you can read them.

### MCP servers → `opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "fs": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

Then a node opts in by name: `mcp: ["fs"]`. Every other server is denied for that node.

> ⚠️ MCP servers you configured in **Claude Code are invisible here.** opencode keeps
> its own registry. `ensemble mcp` tells you what actually connected — use it before
> writing a scene that depends on one.

### Skills → a folder with a `SKILL.md`

```
.opencode/skills/release-notes/SKILL.md
```

```markdown
---
name: release-notes
description: House style for writing release notes. Use when summarising changes…
---
# Release notes house style
…
```

A node opts in by name: `skills: ["release-notes"]`. The generated opencode agent is
deny-all plus that one allowlist entry.

---

## From zero — every command

```bash
# 1 · the tool
npm i -g @ghostmind-dev/ensemble
export OPENROUTER_API_KEY=sk-or-...

# 2 · agent nodes need opencode (model nodes do NOT)
npm i -g opencode-ai        # or: brew install sst/tap/opencode

# 3 · this example
cd examples/03-full-stack
npm i                       # package.json already has "type": "module"

# 4 · confirm the registries BEFORE spending anything
ensemble skills             # should list release-notes as project:.opencode
ensemble mcp                # should show:  fs  connected  local
ensemble validate audit.ts  # free

# 5 · go
ensemble run audit.ts "Audit this project for anything a user would need to know"
ensemble serve .            # or watch it live in the browser
```

Step 4 is the habit worth forming. `ensemble mcp` boots opencode and reports what
actually connected — `connected`, `failed` with the real error, `disabled`, or
`needs_auth`. Declared ≠ working.

---

## What actually happened

```
▶ plan     gemini-2.5-flash                176→254 tok · $0.0007 ·   2.4s
  → inspect
▶ inspect  claude-sonnet-5   [fs MCP]        2→2833 tok · $0.03   · 1m 26s
  → write
▶ write    claude-haiku-4.5  [release-notes] 5→644 tok · $0.0047 ·  10.3s

done 3 node run(s) · $0.04
```

**The MCP node really used the filesystem.** From its findings:

> *"I found no `tsconfig.json` anywhere in it (a glob search for `tsconfig*.json`
> returned no matches). Its own `package.json` is `{"name": "ensemble-example-full-stack",
> "private": true, …}`"*

It quoted the real file. That is a genuine tool call, not a guess.

**The skill really shaped the output.** The `write` node produced release notes in the
house style — status first, one line per item, `v0.1.1` with the leading `v` — because
`release-notes/SKILL.md` told it to, and no other node could see that skill.

---

## The honest cost of `runtime: "agent"`

Measured on this machine, same model, same six-word prompt, only the runtime differing:

| | context sent | cost |
|---|---|---|
| `runtime: "model"` | **134 tokens** | **$0.0002** |
| `runtime: "agent"` | **8,773 tokens** | **$0.011** |

That's **65× the context and ~55× the cost** before your prompt does any work. The
8,773 tokens are opencode's system prompt, its tool schemas, the skill index, and
environment context. That scaffolding *is* what makes tool-calling work — it is not
waste when the node needs tools. It is pure waste when the node only needs to think.

**Which is exactly why `runtime` is per node.** In this scene, `plan` costs $0.0007
because it never touches opencode. If all three nodes were agents, the planning step
alone would cost ~15× more for the identical answer.

### One behaviour to know about

The first run of this example **failed**: `inspect` did all its tool work, then
narrated its findings in prose and never emitted the required json block — twice, so
the run halted.

The fix is in `audit.ts`, and it is worth understanding rather than copying:

```ts
"CRITICAL: after you finish using tools, your FINAL message must end with",
"the required fenced json block. Tool calls do not satisfy this — the",
"json block is a separate, final answer containing your written findings.",
```

opencode's own system prompt tells the model it is a coding agent that works through
tools. Our output contract asks for a structured final answer. On a long tool-using
turn the first instruction wins unless you say otherwise. **Agent nodes that do heavy
tool work need their output contract stated explicitly.** Model nodes almost never do
— there is no competing instruction.

## Cost

~$0.04 per run, ~1m 40s. The `inspect` node is 85% of both — it is the one doing real
work through tools.
