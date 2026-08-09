---
name: ensemble
description: "Author and run multi-model agent scenes with @ghostmind-dev/ensemble. Use when the user wants several AI models working together on a goal — a jury/second opinion from other vendors, a score-gated improve-until-good loop, a research→critique→write pipeline, or any multi-agent workflow where each node can be a different model (via OpenRouter) or a tool-using agent with MCP servers and scoped skills. Trigger on: 'ensemble', 'scene', 'multi-model', 'jury', 'ask several models', 'agent graph/workflow/team', or requests to build/modify/run a .ts scene file. Covers writing scenes, validating, running, watching live, reading results, and revising a scene based on what a run produced."
---

# ensemble

`@ghostmind-dev/ensemble` runs **scenes**: multi-model agent graphs described in one
TypeScript file. Each node is either a direct OpenRouter model call (any vendor) or a
tool-using agent that loops over MCP and built-in tools. Nodes share a typed state blackboard,
wired by conditional edges that are plain TypeScript predicates. You — the model
reading this — are expected to **author scenes, run them, read the results, and
revise the scene when the results say so.**

## 0 · Check the setup (once per session)

```bash
which ensemble || npm ls @ghostmind-dev/ensemble   # installed? (global bin or local dep)
echo ${OPENROUTER_API_KEY:+set}                    # required for model nodes
node -p "require('./package.json').type"           # MUST be "module"
```

- Not installed → `npm i -g @ghostmind-dev/ensemble` (or `npm i @ghostmind-dev/ensemble` in-project).
- `OPENROUTER_API_KEY` unset → stop and ask the user; model nodes cannot run without it.
- **`"type": "module"` missing from the project's package.json** → add it. Scene files are
  ES modules; without it Node loads them as CommonJS and the `import` fails. (Alternative:
  name scenes `.mts`.) This is the single most common first-run failure.
- Node must be ≥ 22.6 (native TypeScript type stripping).
- **Nothing else to install.** `OPENROUTER_API_KEY` is the only credential; there is no
  external agent or subprocess.

## 1 · The scene format

One `.ts` file, default-exporting `scene({ … })`:

```ts
import { scene } from "@ghostmind-dev/ensemble";

export default scene({
  name: "research-and-critique",            // kebab/snake, becomes the run id
  defaults: { model: "openrouter/anthropic/claude-sonnet-5" },

  nodes: {
    researcher: {
      model: "openrouter/google/gemini-2.5-flash",   // ANY vendor, per node
      prompt: "Research the goal. Be concrete.",
      outputs: ["findings"],                // state keys harvested from its reply
    },
    critic: {
      model: "openrouter/anthropic/claude-haiku-4.5",
      inputs: ["findings"],                 // sees ONLY these state keys
      outputs: ["verdict", "notes"],
    },
    inspector: {
      runtime: "agent",                     // tool-calling loop: built-ins + MCP
      skills: ["graphify"],                 // allowlist; everything else denied
      inputs: ["findings"],
      outputs: ["report"],
    },
    writer: { inputs: ["findings", "notes"], outputs: ["result"] },
  },

  groups: { review: ["critic", "inspector"] },  // run concurrently, fan-in barrier

  edges: [
    { from: "researcher", to: "review" },
    { from: "review", to: "writer",     when: (s) => s["verdict"] === "accept" },
    { from: "review", to: "researcher", when: (s) => s["verdict"] === "reject", maxLoops: 2 },
  ],

  entry: "researcher",
  exit: "writer",
});
```

Rules that matter when authoring:

- **`inputs`/`outputs` are the entire data-flow AND access-control model.** A node
  sees the goal plus exactly its declared `inputs` — nothing else. Independence is a
  feature: jury nodes get NO inputs so they can't anchor on each other.
- **`runtime: "model"` is the default** — one OpenRouter call, fast, streams.
  Model nodes may NOT declare `skills`/`mcp`/`tools` (validation error).
- **`runtime: "agent"`** loops: it calls tools, reads results, calls more, until it can
  answer. Built-in tools are read-only (`read_file`, `list_files`, `glob`, `grep`,
  `fetch_url`) — there is no bash/write/edit. Add MCP servers with `mcp: ["name"]`.
  `maxTurns` (default 12) bounds the loop.
- **Agent nodes cost real money.** Every prior tool result is resent each turn, so a
  vague job ("audit everything") compounds fast — one example went $0.44 → $0.05 just
  by narrowing the prompt. Give agent nodes a narrow, bounded job.
- **Agent nodes doing heavy tool work need the output contract restated at the END of
  their prompt** ("after you finish using tools, your FINAL message must end with the
  required json block"). Deep in a loop, the model stays in "keep working" mode.
- **Conditions are real code**: `when: (s) => Number(s["score"]) < 8`. Wrap numeric
  comparisons in `Number()` — models sometimes emit `"7"` as a string. A throwing
  predicate fails the run.
- **`maxLoops` on every cycle.** Also global caps: 50 node runs, 20 min (override
  with `--max-runs` / `--timeout`).
- Two nodes in the same group must not write the same output key (validation error).
- Cast asymmetrically: cheap models do the work, a strong model holds the gate.

## 2 · The workflow: validate → run → read → revise

```bash
ensemble validate scenes/my.ts          # FREE. Always run before spending tokens.
ensemble run scenes/my.ts "<the goal>"  # execute; per-node cost/tokens printed
ensemble serve                          # browser: live canvas, streaming, state tab,
                                        # source editor (validate-before-save)
```

After a run, read the artifacts — this is how you observe and decide what to change:

```bash
cat .ensemble/runs/<timestamp>-<scene>/state.json   # the full blackboard
cat .ensemble/runs/<timestamp>-<scene>/result.md    # rendered per key
```

**The revise loop** (do this rather than accepting a weak result): read `state.json`,
identify the weak link (bad verdict logic? a node whose output was thin? gate never
passing?), edit the scene — prompt, model choice, an extra node, a different
threshold — re-`validate`, re-`run`. Scenes are cheap to iterate; most runs cost
cents and validation is free.

Watch for the `node:lossy` warning in run output: it means a node wrote its real
answer as prose and put only a summary in its JSON block — strengthen that node's
prompt ("the value must contain the FULL content").

## 3 · Patterns to reach for

**Jury / second opinion** — N vendors answer independently (no `inputs`!), run as a
parallel group, one foreman synthesises with `consensus` / `dissent` / `strongest` /
`answer` outputs. Tell the foreman "do not invent conflict."

**Score gate (improve-until-good)** — worker → judge that emits a NUMBER `score` +
`feedback`; edge `when: (s) => Number(s["score"]) < TARGET, maxLoops: N` loops
feedback back into the worker (`inputs: ["feedback", "score"]`). This is also the
auto-research skeleton: make the judge a `runtime: "agent"` node that actually runs
the experiment and reports a measured metric.

**Pipeline with rejection** — research → parallel review (critic + factchecker) →
write, with `verdict === "reject"` looping back capped by `maxLoops`.

Working examples with real run logs live in the package repo under `examples/`.

## 4 · Discovery commands

```bash
ensemble models [filter]   # 300+ OpenRouter models reachable
ensemble skills            # skill registry available to agent nodes
ensemble mcp               # which MCP servers ACTUALLY connected (not just declared)
ensemble view scenes/my.ts # topology in the terminal; --mermaid / --html for sharing
```

## 5 · Pitfalls

- **MCP transports**: stdio, Streamable HTTP (incl. stateless), and SSE (auto-fallback)
  all work. **Auth**: none, header token, or OAuth via `ensemble login <server>` — a
  server needing it shows `needs_auth` in `ensemble mcp` with the command to run.
- **Inheritance can be switched off** with a `sources` block in ensemble.json
  (`claudeSkills`/`opencodeSkills`/`agentsSkills`/`claudeMcp`: false) plus
  `skillDirs: ["./team-skills"]` for your own locations.
- **MCP servers are declared in `ensemble.json`** (project) or
  `~/.config/ensemble/ensemble.json` (global), then opted into per node with
  `mcp: ["name"]`. Config is **cwd-relative** — run from the directory holding it.
  `ensemble mcp` connects each server and lists its tools; declared ≠ connected.
- Skills use Claude Code's own `SKILL.md` format and locations, so existing skills work.
- Scenes must live where you run: relative import `@ghostmind-dev/ensemble` requires the
  package installed in that project (or globally linked).
- Agent nodes' file tools are confined to the cwd — run from the project root.
- If a run ends `exceeded maxNodeRuns`, a cycle has no working exit condition — check
  that the gate's state key is actually being written by the node you think.

## 6 · Library use (embedding in code)

```ts
import { loadScene, loadRegistry, runScene } from "@ghostmind-dev/ensemble";
const scn = await loadScene("scenes/my.ts", loadRegistry());
const result = await runScene(scn, goal, {
  onEvent: (e) => { if (e.type === "node:delta") process.stdout.write(e.delta); },
});
if (result.ok) console.log(result.state);
```
