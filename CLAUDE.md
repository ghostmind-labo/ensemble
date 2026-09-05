# CLAUDE.md

`@ghostmind-dev/ensemble` — a CLI and library that runs multi-model agent **scenes**: a graph of nodes (each any model, any runtime) wired by conditional edges, executed over OpenRouter. TypeScript ESM on Node ≥ 22.18 (scenes are `.mts` loaded by Node's native type stripping); the only runtime deps are `@modelcontextprotocol/sdk`, `yaml` and `zod`, and the only credential is `OPENROUTER_API_KEY`.

## Project map

- `src/` — the whole implementation. `dsl.ts` (scene format) · `scene.ts` (load + validate) · `engine.ts` (the cursor that walks the graph) · `runtimes/` (model, agent, fn, ask, opencode, experiment, refine) · `agents/` (rented CLI backends) · `tools/builtin.ts` · `mcp.ts` + `mcp-serve.ts` · `serve.ts` + `view.ts` (viewer) · `store.ts` (run artifacts) · `research.ts` + `autoresearch.ts` · `cli.ts`
- `test/` — one `*.test.mts` per suite, auto-discovered by `test/run.mts`
- `bench/` — hand-rolled autoresearch loop that optimises the `runtime: "agent"` prompt
- `dev/.ensemble/scenes/` — the tracked dev sandbox: the scenes you iterate against
- `examples/` — numbered, runnable examples, each with its own README
- `scenes/` — two checkout-local scenes that import `../src/index.ts` directly
- `plugin/` — the Claude Code plugin that ships with the package (`skills/ensemble/SKILL.md` is the agent-facing spec)
- `ui/index.html` — the entire browser viewer, one dependency-free file
- `bin/ensemble.js` — bin launcher: prefers `dist/`, falls back to `src/*.ts`

Every `src/*.ts` opens with a doc comment explaining *why* the module exists, not what it does. Match that when adding one.

<important if="you need to run commands to build, test, lint, or exercise the CLI">

| Command | What it does |
|---|---|
| `npm test` | Full suite (runs `npm run build` first via `pretest`) |
| `node test/run.mts <substring>` | Run matching suites only, no rebuild |
| `node test/<name>.test.mts` | Run one suite directly |
| `npm run typecheck` | `tsc --noEmit` over `src/` |
| `npm run build` | `rm -rf dist && tsc -p tsconfig.build.json` |
| `npm run bench` | Run the agent-prompt benchmark |
| `npm run bench:optimize` | Run the autoresearch optimisation loop |
| `npm run bench:test` | The graders that keep the bench honest |
| `node src/cli.ts <cmd>` | The CLI from this checkout — use this, not a globally installed `ensemble` |
| `node src/cli.ts serve dev/.ensemble/scenes --port 7777` | Live viewer + run console |

`node src/cli.ts --help` lists every subcommand and flag.
</important>

<important if="you are about to execute a scene, a run, a bench, or anything that calls a model">

Runs cost money. `validate`, `view`, and `replay <run-dir>` are free and offline — reach for them first, and never launch a paid run unless the user asked for it. `--budget <usd>` caps a run that does need to happen.
</important>

<important if="you are writing or modifying a test">

- Suites are spawned as separate **processes** (they chdir into temp projects, set env vars, and replace global `fetch`) — never import one suite from another.
- Every suite must stay offline: mock OpenRouter, set a dummy `OPENROUTER_API_KEY`. CI runs with no key and must spend nothing.
- A new file matching `test/*.test.mts` is picked up automatically; no registration.
- Assertions use `node:assert/strict` and print an `ok - N …` line per numbered case.
</important>

<important if="you are adding a runtime, an edge kind, a capability block, or a store">

The rule of this codebase: everything is an object, and adding a capability means adding an object (or a property to one) — never a branch in the engine. New runtimes register in `src/runtimes/index.ts` (declaring their `fields`, `check`, and `park`/`call`); edge kinds in `src/edges.ts`; scene-level blocks in `src/capabilities.ts`. The validator composes each node's legal surface from those declarations.
</important>

<important if="you are changing runtimes, node fields, or the public API surface">

`plugin/skills/ensemble/SKILL.md` is documentation an agent acts on, and `test/skill-accuracy.test.mts` pins it to the code — every registered runtime, its badge, and every field it accepts must appear there. Update the skill in the same change, and mirror anything user-facing in `README.md`.
</important>

<important if="you are changing validation, `inputs`/`outputs`, or the data graph">

State keys have exactly three origins: `goal`, a node's declared `outputs`, and the scene's declared `inputs`. `validate` proves every key a node (or a `when`) reads has one, and the error message names the fix. See `src/dataflow.ts`.
</important>

<important if="you are adding or editing imports in src/ or test/">

Relative imports carry the `.ts` extension (`./registry.ts`) — `rewriteRelativeImportExtensions` rewrites them at build. Scenes import from `"@ghostmind-dev/ensemble"`, resolved at run time by the hook in `src/resolver.ts`; `z` is re-exported from `src/index.ts` so a scene needs no `node_modules`.
</important>

<important if="you are working on the browser viewer or `ensemble serve`">

`ui/index.html` is the whole UI: one file, no build step, no dependencies. `src/serve.ts` is `node:http`, binds 127.0.0.1 only, and streams `src/events.ts` events over SSE — the terminal reporter consumes the same vocabulary, so the two can't drift.
</important>

<important if="you are touching run artifacts, journals, resume, or replay">

A run writes `state.json`, `costs.json`, `journal.json`, `events.jsonl` and `result.md` into `.ensemble/runs/<stamp>-<scene>/` via the store object in `src/store.ts` — the engine never writes files itself. `events.jsonl` is the tape `replay` feeds back through the real engine.
</important>

<important if="you are committing, branching, or shipping">

Work happens on `dev`; `main` is only reached through a PR. This repo's own `/.ensemble/` is gitignored, but `dev/.ensemble/scenes/` is tracked — those scenes are fixtures.
</important>
