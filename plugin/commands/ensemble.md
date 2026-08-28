---
description: Author or run a multi-model agent scene with @ghostmind-dev/ensemble
argument-hint: "[what the ensemble should do, or a scene file + goal]"
---

Use the **ensemble** skill (bundled with this plugin) to handle this request.

The user wants to work with `@ghostmind-dev/ensemble` — multi-model agent scenes. Their
arguments (if any): $ARGUMENTS

Follow the skill's workflow:

0a. **First decide: is this autoresearch?** If the user wants ONE measurable thing made
   better and a command can score it, use the sealed mode — `research({ modify,
   evaluate, instruction })` and `ensemble research <file>` — never a hand-authored
   loop. It accepts exactly those three keys and refuses all others by design, and the
   command takes no goal argument (the directive lives in `instruction`).

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
