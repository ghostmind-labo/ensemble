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

Two layers, project and global. Project wins. Because config is **cwd-relative**,
this example must be run from its own directory — unlike 01 and 02, which have no
config and run from the repo root.

```
~/.config/ensemble/ensemble.json     ← MCP servers, GLOBAL (all projects)
~/.claude/skills/<name>/SKILL.md     ← skills, GLOBAL
.claude/skills/<name>/SKILL.md       ← skills, THIS PROJECT

my-project/
├── ensemble.json                    ← MCP servers, THIS PROJECT   ← used here
├── .claude/skills/<name>/SKILL.md   ← skills, THIS PROJECT        ← used here
└── audit.mts                         ← the scene
```

Project entries win over global ones. `ensemble skills` and `ensemble mcp` show you
the merged result, with a `project:` / `global:` tag on each so you know where a given
one came from.

This example is deliberately **project-scoped** — its `ensemble.json` and
`.claude/skills/` are right here in the folder, so you can read them.

### MCP servers → `ensemble.json`

```json
{
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

> `ensemble mcp` connects every declared server and lists the tools it exposes.
> Run it before writing a scene that depends on one — declared is not connected.

### Skills → a folder with a `SKILL.md`

```
.claude/skills/release-notes/SKILL.md
```

```markdown
---
name: release-notes
description: House style for writing release notes. Use when summarising changes…
---
# Release notes house style
…
```

A node opts in by name: `skills: ["release-notes"]`. The file's body is inlined into
that node's system prompt — and no other node's.

---

## From zero — every command

```bash
# 1 · the tool
npm i -g @ghostmind-dev/ensemble
export OPENROUTER_API_KEY=sk-or-...

# 2 · this example (config is cwd-relative, so run from HERE)
cd examples/03-full-stack   # no npm install — audit.mts needs no package.json

# 3 · confirm the registries BEFORE spending anything
ensemble skills             # should list release-notes as project:.claude
ensemble mcp                # should show:  fs  connected  local
ensemble validate audit.mts  # free

# 4 · go
ensemble run audit.mts "Audit this project for anything a user would need to know"
ensemble serve .            # or watch it live in the browser
```

Step 3 is the habit worth forming. `ensemble mcp` actually connects each server and reports what happened — `connected`, `failed` with the real error, `disabled`, or
`needs_auth`. Declared ≠ working.

---

## What actually happened

```
▶ plan     gemini-2.5-flash                    174→295 tok · $0.0008 ·  3.1s
  → inspect
▶ inspect  claude-sonnet-5  [fs MCP + built-ins]
   ⚒ fs__list_directory   5ms · [DIR] .claude [FILE] README.md [FILE] audit.mts …
   ⚒ read_file            9ms · // The full stack in one scene: both runtimes …
   ⚒ glob                 1ms · no files match **/tsconfig*.json
   ⚒ grep                 4ms · README.md:23: ~/.config/ensemble/ensemble.json …
   … ~25 tool calls across several turns
  → write
▶ write    claude-haiku-4.5 [release-notes skill]

done 3 node run(s) · $0.05
```

**The loop is real.** `inspect` kept calling tools — mixing the `fs` MCP server's
`fs__list_directory` with the built-in `read_file`, `glob`, and `grep` — and stopped
on its own once it could answer. Tools the model requested together ran concurrently.

**The MCP node really used the filesystem**, quoting the actual `package.json` and
reporting that a glob for `tsconfig*.json` found nothing. **The skill really shaped
the output** — the `write` node produced notes in the house style, and no other node
could see that skill.

**Zero subprocesses.** `pgrep opencode` during the run: 0.

---

## What agent nodes actually cost

An agent node is not one call — it is one call *per turn*, and **every prior tool
result is resent each time**. That compounds fast.

The first version of this example cost **$0.44**, with `inspect` alone consuming
**175,446 input tokens** across ~25 tool calls. Two things fixed it:

1. **Capping tool output.** A 100 KB file read is ~25k tokens; resent over ten turns
   that is 250k tokens from a single `read_file`. Built-ins now cap at 20 KB, and the
   loop clamps *any* tool result — including an MCP server's, which is someone else's
   code — to 8 KB before it enters the conversation.
2. **Narrowing the node's job.** "Audit everything" invites the model to read the whole
   repo. "Check package.json and README only" does not.

Same scene, after: **$0.05**, `inspect` at 16,204 input tokens.

**The rule:** give agent nodes a narrow, bounded job. `maxTurns` (default 12) is the
hard stop, but the prompt is what keeps you well under it.

### One behaviour to know about

An early run **failed**: `inspect` did all its tool work, then narrated in prose and
never emitted the required json block — twice, so the run halted.

The fix is in `audit.mts`:

```ts
"CRITICAL: after you finish using tools, your FINAL message must end with",
"the required fenced json block. Tool calls do not satisfy this — the",
"json block is a separate, final answer containing your written findings.",
```

A model deep in a tool-calling loop is in "keep working" mode; the output contract
sits far back in the context. **Agent nodes doing heavy tool work need their contract
restated at the end of the prompt.** Model nodes almost never do.

## Cost

~$0.05 per run with a narrowed goal. The `inspect` node is ~80% of it — it is the one
doing real work through tools. Widen its job and it grows quickly; see above.
