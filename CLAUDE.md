# CLAUDE.md

`@ghostmind-dev/ensemble` — a library that makes **one calibrated decision** and
routes to code the user wrote. It asks [Jev](https://docs.typesafe.ai)
(TypeSafe's System One classifier: yes/no, one-of-N, or a rubric position) and
emits the graph and the run as JSON. TypeScript ESM on Node ≥ 22.18, **zero
runtime dependencies**, one credential: `TYPESAFE_API_KEY`.

It calls generative models through **OpenRouter only** — one endpoint, one key,
one billing line, every vendor. Do not add `openai`, `@anthropic-ai/sdk` or
`@google/genai`: they would each be a runtime dependency (the package has zero),
each need their own key and cost format, and OpenRouter already returns
`usage.cost` in USD per call, which is what makes a budget cap possible at all.
A vendor-exclusive feature belongs in a user's own `work` handler, which is
exactly what that seam is for.

It still holds no prompts of its own, runs no tool loop, ships no skills, serves
no HTTP, and draws nothing. Those were removed on purpose; a change that adds one
back is the change to question.

## Project map

Fifteen files, and each one has a single job.

- `src/questions.ts` — `choice` / `score` / `noul`, their answer types, and the API limits enforced at authoring time
- `src/jev.ts` — the decider: one `fetch` to `POST /v1/systemone`, plus the `Decider` seam
- `src/openrouter.ts` — the caller: generation, vision, image output, the live model catalogue, and the `Caller` seam
- `src/skills.ts` — the Agent Skills standard, read from disk; `skillOptions` for a choice
- `src/mcp.ts` — a hand-rolled stdio JSON-RPC client. One tool call per node, never a loop
- `src/registry.ts` — discovery: the official MCP registry, a skills index, and `preflight`
- `src/spec.ts` — the vocabulary you write down: nodes, edges, handlers, the `on:` grammar, `probeReads`
- `src/validate.ts` — the proof. Returns problems as strings, never throws
- `src/graph.ts` — `graph.json`
- `src/execute.ts` — the cursor, `run.json`, and the `RunEvent` stream
- `src/calibrate.ts` — does a decision work: accuracy, calibration gap and gate prices against labelled cases, one decide node at a time
- `src/supervise.ts` — the brainstem: a runner as a loop that lives for days. Memory, budgets, rest, journal and resume, a watcher runner
- `src/report.ts` — the terminal reporter (one consumer of `RunEvent`, not the only possible one)
- `src/runner.ts` — ties them into a callable; `src/index.ts` — the public surface
- `src/cli.ts` — `validate` / `graph` / `run` / `calibrate` / `check` / `skills` / `servers`

`examples/` — seven runnable runners, each with a header comment saying what it
demonstrates. `06-watch` is a watcher runner that also supervises `01-triage`
when executed directly; `07-senses` forks three lanes, joins them, and remembers. `test/` — one `*.test.mts` per suite, auto-discovered by
`test/run.mts`.

`plugin/` + `.claude-plugin/marketplace.json` — the Claude Code plugin (marketplace
`ghostmind-ensemble`, plugin `ensemble`). It is **not** part of the npm package
(`files` excludes it), so the library still ships no skills. Its three skills teach
an agent to use the library: `ensemble-build` (use case → validated runner, with
`scripts/dryrun.mts`, a $0 executor), `ensemble-questions` (question design) and
`ensemble-runs` (reading and tuning runs, with `scripts/summarize.mts`).

The skills present ensemble as a **structure** (a graph, a shared state with a proven
data flow, and a run record), not as a closed toolbox. They install it as a library
and drive it through `package.json` scripts and a `run.mts` that imports the runner;
they never tell anyone to install `ensemble` globally. Inside a `work` handler or
`code` node the user's runner may import any library, SDK or agent framework, and a
runner is just a script that can be called without the CLI. The zero-dependency and
OpenRouter-only rules bind this package, never the runners built with it. Don't write
skill prose that tells an agent it can't use something.

Every `src/*.ts` opens with a doc comment explaining *why* the module exists,
not what it does. Match that when adding one.

<important if="you need to run commands to build, test, typecheck, or exercise the CLI">

| Command | What it does |
|---|---|
| `npm test` | Full suite (runs `npm run build` first via `pretest`) |
| `node test/run.mts <substring>` | Run matching suites only, no rebuild |
| `node test/<name>.test.mts` | Run one suite directly |
| `npm run typecheck` | `tsc --noEmit` over `src/` |
| `npm run build` | `rm -rf dist && tsc -p tsconfig.build.json` |
| `node src/cli.ts <cmd>` | The CLI from this checkout. It is never installed globally: users reach it through `package.json` scripts |

`npx tsc` does **not** work here; use `./node_modules/.bin/tsc`.
</important>

<important if="you are about to run a scene, a runner, or anything that would reach the API">

`validate` and `graph` are free and offline — reach for them first, and never
launch a paid run unless the user asked for it. A decide step costs about
$0.00002, so the risk is small, but the rule stands. `--budget <usd>` caps a run
that does need to happen.
</important>

<important if="you are writing or modifying a test">

- Suites are spawned as separate **processes** (they set env vars and replace fetch) — never import one suite from another.
- Every suite must stay offline: pass a stub `decider`, or a mock `fetch` through `jev({ fetch })`. CI runs with no key and must spend nothing.
- A new file matching `test/*.test.mts` is picked up automatically; no registration.
- Assertions use `node:assert/strict`; print `ok · N …` per numbered case, and a final `N cases` line.
</important>

<important if="you are changing graph.json or run.json">

**These two documents are the product.** Someone else's renderer and someone
else's agent read them, so their field names, shapes and ordering are a public
contract — `test/graph.test.mts` asserts the shapes precisely, and that is
deliberate. A change there is a change to somebody's code: bump `version` and
the `$schema` url rather than reshaping v1.

Invariants worth protecting: flat `nodes[]`/`edges[]` with stable ids, no layout
or styling, descriptions normalised to objects so readers never branch on
string-vs-object, and `steps[].took` joining a run to `graph.edges[].id`.
</important>

<important if="you are adding a node kind, an edge form, or a question type">

There are five node kinds (`decide`, `work`, `code`, `model`, `mcp`), two branch forms
(`on:` for meaning, `when:` for arithmetic), one form of parallelism (`fork` on an
edge, `join` on a node) and three questions. Each is a closed set,
and the closed-ness is the feature — it is what lets `validate` prove
exhaustiveness and `graph` emit a complete document. Adding a fourth of anything
needs a reason that survives that argument.

`model` was the fourth, added after the fact, and the reason it earned its place
is the standard to beat: perception forced it (Jev is text-only, so anything that
must LOOK needs a generative call), and putting it in a node made the emitted
graph MORE complete than hiding it in an opaque handler would have — `graph.json`
can now say which model, whether it sees, and what it costs.

If one is added anyway: a node kind needs an `isX` guard in `spec.ts`, a
`writesOf`/`readsOf` branch, a `validate` check, a `graph` cost class, an
`execute` arm, and a badge in `report.ts`.
</important>

<important if="you are touching lanes, forks, joins, or anything concurrent">

Parallelism is exactly two facts: a forking edge fires alongside the other forks
from its node (each on its own lane), and a join node runs once after every lane
has arrived. A node's edges are all forks or none. `validate` proves that lanes
between a fork and its join share no node and touch no common state key (writes
against writes AND writes against reads), so the merge never depends on timing.
The scheduler in `execute.ts` fires joins only when no lane is running, and the
first reason to stop wins (`halt`). A failing lane aborts its siblings through the
one shared controller. Do not add a variable-width fan-out: that is a handler's
job, and the graph could no longer say what runs.
</important>

<important if="you are changing validation or the data graph">

State keys have exactly three origins: the runner's `inputs` (plus `goal`, always),
its `memory` (keys carried in from the previous tick by `supervise`, which must have
a writer) and a node's writes — a decide node writes one key per question, and a model node
writes positionally (`[text]` or `[text, images]`). Everywhere else, ONE write key
takes the return value whole and several destructure it; returning `{ rounds: n }`
for `writes: ["rounds"]` nests it as `rounds.rounds`, which validation cannot
catch, so examples must be *run* in tests, not merely validated.

`validate` proves every key a node reads, and every key a `when()` touches, has
an origin. A `when` is opaque code, so its reads are discovered by running it
against a recording proxy (`probeReads`), never by parsing source.

`imageKeys()` derives which state keys hold pictures, and `validate` refuses to
let one reach a decide node — Jev takes text only, and a base64 frame where the
judgement should be is the single worst thing that can happen to a perception
graph.

Error messages name the fix. Keep it that way — `inputs: ["…"]` in the message
is the reason the check is useful rather than annoying.
</important>

<important if="you are tempted to add live rendering, a TUI, a viewer, or a report">

Don't. A browser viewer, an SSE server and a mermaid/markdown exporter were all
removed from this repo in the v2 rewrite, and re-adding one is the exact
regression to avoid. The seam is `RunEvent` (three events) and the two JSON
documents; anything visual consumes those and lives outside this package.
`src/report.ts` is the one shipped consumer, and it stays a single line rewritten
in place, not a screen.
</important>

<important if="you are about to state a model id, a price, a capability, or how Jev behaves">

**Check the source. Do not answer from memory — it is probably stale.**

Both vendors move faster than this repo does. Model ids appear and retire, prices
change, and a model that could not see images last month can today. Jev itself is
versioned, and its documented weaknesses are published per version.

| What you need | Where it actually is |
|---|---|
| Every model, live: ids, prices, modalities, context | `curl -s https://openrouter.ai/api/v1/models \| jq '.data[] \| select(.id=="…")'` |
| Which models SEE | `.architecture.input_modalities` contains `"image"` |
| Which models DRAW | `.architecture.output_modalities` contains `"image"` |
| What a model costs | `.pricing.prompt` / `.completion` / `.image_output`, USD per token as strings |
| The whole TypeSafe doc set | https://docs.typesafe.ai/llms.txt — fetch this first, it indexes every page |
| How to shape questions | https://docs.typesafe.ai/concepts/how-to-build-with-system-one |
| Jev's current weaknesses | https://docs.typesafe.ai/model-jaggedness/jev-1.13 — **check for a newer version first** |
| Primitive limits and fields | https://docs.typesafe.ai/primitives/choice · `/score` · `/noul` · `/advanced` |

Never hardcode a model id into `src/`. Examples may name one for readability, but
the library resolves them through `catalog()` and `shortlist()` at run time, which
is the only reason those helpers exist.
</important>

<important if="you are working on skills, MCP, or anything a model must be CAPABLE of">

**A model node never needs tool-calling support.** The `mcp` node makes the call
itself and writes the result to the blackboard; skills are inlined as text. So a
model with no tool support, or a tiny specialised one, still sits downstream of
every tool and skill. Never add a check for whether a model supports tools —
`preflight` deliberately does not, and `test/registry.test.mts` pins that.

Capability constrains only what a model must do ITSELF: `sees:` needs
`vision`, a second write key needs `draws`. Those are checked by `preflight`
against the live catalogue, never by `validate`, which must stay offline.

Skills follow the Agent Skills open standard (https://agentskills.io/specification):
`name` (≤64, lowercase, hyphens, matching the folder) and `description` (≤1024)
are required; `license`, `compatibility`, `metadata`, `allowed-tools` are not.
`validateSkill` enforces it. Do not invent fields.

The MCP registry is a specified API and is treated as one; skills.sh is NOT —
it is an undocumented endpoint, so `searchSkills` returns [] on any failure and
nothing that runs may depend on it.
</important>

<important if="you are working on Jev questions, criteria, or thresholds">

Jev is documented as unreliable at counting, arithmetic and date ordering, and
loses accuracy on multi-hop questions and on state padded with irrelevant
detail. So: numbers belong in `when:`/`code`, `reads` stays a hard filter, and
questions stay atomic — asking five narrow ones costs one round trip because
they run in parallel. Use `not_for` to draw the boundary against the neighbouring
option. See https://docs.typesafe.ai/model-jaggedness/jev-1.13.
</important>

<important if="you are changing the public API, the CLI, or run.json / graph.json">

The plugin's skills document the API in prose, and nothing tests prose. When a
field, a node kind, a CLI flag or an error message changes, update
`plugin/skills/ensemble-build/references/{api,errors}.md` in the same commit.
Then check that `node plugin/skills/ensemble-build/scripts/dryrun.mts
examples/<each>.mts --explore` still passes. Keep `plugin/.claude-plugin/plugin.json`
`version` equal to `package.json`'s.
</important>

<important if="you are committing, branching, or shipping">

The v2 rewrite lives on `v2`; `main` still holds the old orchestration product
and is reached only through a PR. Everything deleted in the rewrite — the
viewer, `serve.ts`, the runtime zoo, autoresearch, the old plugin — is recoverable
from `main` (the v1 plugin under `plugin/` was replaced wholesale, not revised), and autoresearch in particular is parked rather than abandoned.
This repo's own `/.ensemble/` is gitignored.
</important>
