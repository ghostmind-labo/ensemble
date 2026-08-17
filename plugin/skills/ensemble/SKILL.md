---
name: ensemble
description: "Author and run multi-model agent scenes with @ghostmind-dev/ensemble. Use when the user wants several AI models working together on a goal — a jury/second opinion from other vendors, a score-gated improve-until-good loop, a research→critique→write pipeline, or any multi-agent workflow where each node can be a different model (via OpenRouter) or a tool-using agent with MCP servers and scoped skills. Trigger on: 'ensemble', 'scene', 'multi-model', 'jury', 'ask several models', 'agent graph/workflow/team', or requests to build/modify/run a scene (.mts) file. Covers writing scenes, validating, running under a cost cap, resuming a stopped run, watching live, reading results, and revising a scene based on what a run produced."
---

# ensemble

`@ghostmind-dev/ensemble` runs **scenes**: multi-model agent graphs described in one
TypeScript file. Each node is either a direct OpenRouter model call (any vendor) or a
tool-using agent that loops over MCP and built-in tools. Nodes share a state
blackboard, wired by conditional edges that are plain TypeScript predicates.

You — the model reading this — are the intended operator. The loop you own:
**author a scene → `validate` (free) → `run` → read the run artifacts → revise the
scene when the results say so.** Do not accept a weak result when a one-line change
to a prompt, model, or threshold would fix it.

## 0 · Check the setup (once per session)

```bash
which ensemble || npm ls @ghostmind-dev/ensemble   # global bin or local dep
echo ${OPENROUTER_API_KEY:+set}                    # the ONLY required credential
```

- Not installed → `npm i -g @ghostmind-dev/ensemble`.
- `OPENROUTER_API_KEY` unset → stop and ask the user; nothing runs without it.
- **Name scenes `.mts`.** Then no package.json is needed — a directory containing only
  `my.mts` works, and the `@ghostmind-dev/ensemble` import resolves against the global
  install (a project-local install, if present, wins). Use `.ts` only where the
  project already has `"type": "module"`.
- Node ≥ 22.6. No other install, no subprocess, no external agent.

## 1 · The scene format

```ts
// review.mts — one file is the whole workflow
import { scene } from "@ghostmind-dev/ensemble";

export default scene({
  name: "research-and-critique",            // kebab/snake; becomes the run id
  defaults: { model: "openrouter/anthropic/claude-sonnet-5" },

  nodes: {
    researcher: {
      model: "openrouter/google/gemini-2.5-flash",   // ANY vendor, per node
      prompt: "Research the goal. Be concrete.",
      outputs: ["findings"],                // state keys harvested from its reply
    },
    critic: {
      model: "openrouter/anthropic/claude-haiku-4.5",
      inputs: ["findings"],                 // sees the goal + ONLY these keys
      outputs: ["verdict", "notes"],
    },
    inspector: {
      runtime: "agent",                     // tool-calling loop: built-ins + MCP
      mcp: ["github"],                      // MCP servers this node may use
      skills: ["graphify"],                 // skill bodies inlined into its prompt
      maxTurns: 8,                          // tool-loop budget (default 12)
      inputs: ["findings"],
      outputs: ["report"],
    },
    writer: { inputs: ["findings", "notes", "report"], outputs: ["result"] },
  },

  groups: { review: ["critic", "inspector"] },  // run concurrently, fan-in barrier

  edges: [
    { from: "researcher", to: "review" },
    { from: "review", to: "writer",     when: (s) => s["verdict"] === "accept" },
    { from: "review", to: "researcher", when: (s) => s["verdict"] === "reject", maxLoops: 2 },
  ],

  entry: "researcher",
  exit: "writer",     // its first output is printed as the run's Result
});
```

### How data flows (know this before authoring)

Every node receives: the run's **goal**, plus the current value of each declared
`inputs` key — nothing else. The engine automatically appends an output contract to
each node's prompt telling it to end with a fenced json block containing exactly its
`outputs` keys; the engine parses that block into state (one automatic retry if the
model gets it wrong, then the run fails loudly). A node with no `outputs` is legal —
its reply is recorded but nothing is harvested.

### Rules that matter

- **`inputs`/`outputs` are the data-flow AND access-control model.** Independence is
  a feature: jury nodes get NO inputs so they can't anchor on each other.
- **`runtime: "model"` is the default** — one OpenRouter call, fast, streams. Model
  nodes may NOT declare `skills`/`mcp`/`tools`/`maxTurns` tooling (validation error).
- **`runtime: "agent"`** loops — calls tools, reads results, calls more, until it
  answers. Built-ins are read-only: `read_file`, `list_files`, `glob`, `grep`,
  `fetch_url`; there is **no bash/write/edit** by design. Disable one with
  `tools: { grep: false }`. Add MCP servers per node with `mcp: ["name"]`.
- **Agent nodes cost real money.** Recent tool results are resent each turn (results
  older than 6 calls are auto-pruned to stubs); a vague job ("audit everything") still
  compounds — a real example dropped $0.44 → $0.05 just by narrowing the prompt. Give
  agent nodes a narrow, bounded job. On its final turn — `maxTurns` reached or the
  cost cap crossed — an agent loses its tools and must answer from what it has: a
  best-effort answer lands in state instead of a hard failure.
- **Restate the output contract at the END of an agent node's prompt** ("after you
  finish using tools, your FINAL message must end with the required json block").
  Deep in a tool loop the model stays in "keep working" mode and will narrate instead.
- **Conditions are real code**: `when: (s) => Number(s["score"]) < 8`. Wrap numeric
  comparisons in `Number()` — models sometimes emit `"7"` as a string. A throwing
  predicate fails the run naming the edge.
- **`maxLoops` on every cycle.** Global rails: 50 node runs, 20 min wall clock, and
  an optional hard cost cap (`--max-runs` / `--timeout` / `--budget 0.50`;
  `ENSEMBLE_BUDGET` caps every run on the machine). Running out of matching edges at
  (or without) the exit is a clean finish; anywhere else it is an error naming the
  stuck node.
- Two nodes in the same parallel group must not write the same output key
  (validation error — it would be a silent race).
- **Cast asymmetrically**: cheap/fast models for volume work, one strong model at
  the gate or synthesis step. `ensemble models [filter]` lists what's reachable.

## 2 · The operating loop: validate → run → read → revise

```bash
ensemble validate review.mts                        # FREE — always run before spending
ensemble run review.mts "<the goal>" --budget 0.50  # hard cost cap — set one when iterating
ensemble resume .ensemble/runs/<id> --budget 1.00   # continue a stopped run, don't restart
ensemble serve                         # browser: live canvas, streaming tokens, spend
                                       # ticker + Costs tab, state tab, source editor
```

A run prints a `cost by node` breakdown at the end (failed runs included). Read the
artifacts after every run — this is how you decide what to change:

```bash
cat .ensemble/runs/<timestamp>-<scene>/state.json   # the full blackboard
cat .ensemble/runs/<timestamp>-<scene>/result.md    # every key rendered
cat .ensemble/runs/<timestamp>-<scene>/costs.json   # per-node spend — who burned it
cat .ensemble/runs/<timestamp>-<scene>/journal.json # graph position — what resume uses
```

**A stopped run is never a dead end.** Budget spent, node failed, ctrl-C, timeout —
`ensemble resume <run-dir>` continues from the checkpoint, skipping everything already
paid for and writing into the same run dir (one cumulative `costs.json`). So the
cheapest way to work an expensive scene is deliberately: `--budget` low, read the
partial state, resume with a higher cap only if it earned it. Budgets apply to the
*cumulative* total, `maxLoops` counters survive the stop, and editing the scene
between attempts is allowed (resume warns that edge-keyed loop counters may shift).

**Revise rather than accept.** Weak output → find the weak link in `state.json`
(thin findings? gate never passing? judge too lenient?) and change the scene: a
prompt, a model, a threshold, an extra node. Validation is free and most runs cost
cents — iterating is the intended use.

Warnings to act on:
- `node:lossy` — the node wrote its real answer as prose and put only a summary in
  its json block; strengthen that node's contract ("the value must contain the FULL
  content, not a summary").
- `exceeded maxNodeRuns` — a cycle has no working exit; check the gate's state key
  is actually written by the node you think writes it.
- `budget exhausted` — the run stopped at the cap, position journalled; read
  `costs.json` for the burner, then either narrow that node's job or continue with
  `ensemble resume <run-dir> --budget <higher>`. Never restart from scratch.

## 3 · Patterns to reach for

**Jury / second opinion** — N vendors answer independently (no `inputs`!), run as a
parallel group, one foreman synthesises with `consensus` / `dissent` / `strongest` /
`answer` outputs. Tell the foreman "do not invent conflict."

**Score gate (improve-until-good)** — worker → judge that emits a NUMBER `score` +
`feedback`; edge `when: (s) => Number(s["score"]) < TARGET, maxLoops: N` loops the
feedback back into the worker (`inputs: ["feedback", "score"]`). For auto-research,
make the judge a `runtime: "agent"` node that runs the experiment and reports a
measured metric instead of an opinion.

**Pipeline with rejection** — research → parallel review (critic + factchecker) →
write, with `verdict === "reject"` looping back, capped by `maxLoops`.

**Orchestrator + teams (council)** — composes the others at scale: one framing node
writes `frame`/`constraints` that every later node reads (never re-litigated);
parallel teams (recon → competing options → red-team) feed an adjudicator gate that
loops the options team with `feedback` until a scored bar passes; a production team
writes sections a publisher merges. Cast the money at the orchestration points
(framer, gate, publisher), cheap models on the teams.

Working examples with real run logs: `examples/` in the repo
(`ghostmind-labo/ensemble`) — 01 jury, 02 score gate, 03 full stack (MCP + skills),
04 decision council (orchestrator, 4 teams, gate, 15 nodes).

## 4 · Skills and MCP (mostly zero-config)

**Both registries are inherited.** Check before configuring anything:

```bash
ensemble skills    # skills found, tagged project:/global:/custom:
ensemble mcp       # servers CONNECTED (not just declared) + every tool they expose
```

- **Skills**: same `SKILL.md` format and directories as Claude Code
  (`.claude/skills/`, `~/.claude/skills/`, `.opencode/`, `.agents/` variants). A
  node's `skills: ["name"]` inlines those files into its system prompt — that node's
  only, by construction.
- **MCP servers**: four sources, first definition wins —
  `./ensemble.json` → `./.mcp.json` (Claude Code's) →
  `~/.config/ensemble/ensemble.json` → `~/.claude.json` (Claude Code's). Servers the
  user already wired into Claude Code work with no reconfiguration.
- **Transports**: stdio, Streamable HTTP (incl. stateless), SSE auto-fallback.
- **Auth**: none, header token, or **OAuth**: `ensemble mcp login <server>` opens the
  browser, catches the redirect, stores tokens in `~/.config/ensemble/auth.json`.
  Once per server. `ensemble mcp logout <server>` forgets. A server needing it shows
  `needs auth` in `ensemble mcp` with the exact command. Headless: set
  `ENSEMBLE_NO_BROWSER=1` and give the user the printed URL.
- **Never hardcode a secret in ensemble.json** — it is meant to be committed. Use
  `"Authorization": "Bearer ${MY_TOKEN}"`; `${VAR}` / `${VAR:-default}` expand from
  the environment or a gitignored `.env` beside the config (auto-loaded; exported
  vars win). An unset variable is reported by name before connecting.
- Declaring a server: `{ "mcp": { "fs": { "type": "local", "command": ["npx", "-y",
  "@modelcontextprotocol/server-filesystem", "."] } } }` — then `mcp: ["fs"]` on the
  node. Config is cwd-relative: run from the directory that holds it.
- **Isolation**: a `sources` block (`claudeSkills`/`opencodeSkills`/`agentsSkills`/
  `claudeMcp`: false, `skillDirs: ["./team-skills"]`) turns inheritance off for repos
  that must not depend on the machine. Custom dirs are scanned first.

## 5 · Tuning agent behaviour (advanced)

The operating instructions every agent node receives can be replaced per project:

```bash
ENSEMBLE_AGENT_PROMPT=/path/to/block.md ensemble run scene.mts "goal"
```

The file replaces the built-in "how to use your tools" block (keep the literal
`{toolCount}` placeholder). The repo's `bench/` is an autoresearch loop that
measures candidates against 12 code-graded tasks and keeps only variants that beat
the incumbent by more than the measured noise floor. Reach for this only if a user
has a specific, repeated complaint about agent-node behaviour — the default is tuned.

## 6 · Library use (embedding in code)

```ts
import { loadScene, loadRegistry, runScene, readJournal } from "@ghostmind-dev/ensemble";

const scn = await loadScene("review.mts", loadRegistry());
const result = await runScene(scn, goal, {
  budget: 0.5,                 // optional hard cost cap (USD)
  // resumeFrom: readJournal(".ensemble/runs/<id>"),   // continue a stopped run
  onEvent: (e) => {
    if (e.type === "node:delta") process.stdout.write(e.delta);  // live tokens
    if (e.type === "node:tool")  console.log("⚒", e.tool);       // agent tool calls
    if (e.type === "node:end")   console.log(e.node, e.cost);
  },
});
if (result.ok) console.log(result.state);   // the blackboard
```

The terminal and browser render this same typed `RunEvent` stream — an embedding
sees exactly what they see.
