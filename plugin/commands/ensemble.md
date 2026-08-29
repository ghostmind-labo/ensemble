---
description: Author or run a multi-model agent scene with @ghostmind-dev/ensemble
argument-hint: "[what the ensemble should do, or a scene file + goal]"
---

The user wants to work with `@ghostmind-dev/ensemble` — multi-model agent scenes. Their
arguments (if any): $ARGUMENTS

**0a. Route before doing anything else.** Is the user trying to make ONE measurable
   thing better, where a command can score it? Then this is autoresearch, not a scene:

   - to explain the method, when it applies, or why it refuses something →
     load the **`autoresearch`** skill (the concept)
   - to actually build, launch, resume or interpret a loop →
     load the **`autoresearch-build`** skill (the implementation)

   Never hand-author a propose/evaluate loop as a scene. The sealed mode exists so the
   scaffolding is not a variable between experiments.

   Otherwise, use the **ensemble** skill (bundled with this plugin) and follow its
   workflow:

0. If the `ensemble` MCP tools are available (run_scene, run_status, …), prefer them
   over the CLI — runs start async and can be peeked, stopped, and resumed as tools.
1. Check setup (`ensemble` binary or local install, `OPENROUTER_API_KEY`).
2. If they're describing a workflow to build: author a scene file (name it `.mts` — no package.json needed),
   choosing the right pattern (jury, score gate, pipeline) and casting models
   deliberately — cheap models for volume work, a strong model at the gate.
3. `ensemble validate` it (free) before any run; `ensemble skills` / `ensemble mcp` show what agent nodes can use.
4. Run it with their goal — set `--budget` when iterating or when cost matters — then
   read `.ensemble/runs/<id>/state.json` and report the result, including per-node
   cost from `costs.json`. If a run stopped early (budget, failure, timeout),
   continue it with `ensemble resume <run-dir>` rather than restarting.
5. If the result is weak, revise the scene (prompts, models, thresholds, topology)
   and re-run. Offer `ensemble serve` if the user wants to watch live.
