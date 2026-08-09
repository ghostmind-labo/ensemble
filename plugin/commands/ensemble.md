---
name: ensemble
description: Author or run a multi-model agent scene with @ghostmind-dev/ensemble
---

Use the **ensemble** skill (bundled with this plugin) to handle this request.

The user wants to work with `@ghostmind-dev/ensemble` — multi-model agent scenes. Their
arguments (if any): $ARGUMENTS

Follow the skill's workflow:

1. Check setup (`ensemble` binary or local install, `OPENROUTER_API_KEY`).
2. If they're describing a workflow to build: author a scene file (name it `.mts` — no package.json needed),
   choosing the right pattern (jury, score gate, pipeline) and casting models
   deliberately — cheap models for volume work, a strong model at the gate.
3. `ensemble validate` it (free) before any run; `ensemble skills` / `ensemble mcp` show what agent nodes can use.
4. Run it with their goal, then read `.ensemble/runs/<id>/state.json` and report the
   result — including per-node cost.
5. If the result is weak, revise the scene (prompts, models, thresholds, topology)
   and re-run. Offer `ensemble serve` if the user wants to watch live.
