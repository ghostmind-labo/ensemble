# CLAUDE.md

`@ghostmind-dev/ensemble` — a library that makes **one calibrated decision** and
routes to code the user wrote. It asks [Jev](https://docs.typesafe.ai)
(TypeSafe's System One classifier: yes/no, one-of-N, or a rubric position) and
emits the graph and the run as JSON. TypeScript ESM on Node ≥ 22.18, **zero
runtime dependencies**, one credential: `TYPESAFE_API_KEY`.

It does not call models, hold prompts, run tool loops, ship skills, serve HTTP,
or draw anything. Those were all removed on purpose. If a change would add one
back, that is the change to question.

## Project map

Nine files, and each one has a single job.

- `src/questions.ts` — `choice` / `score` / `noul`, their answer types, and the API limits enforced at authoring time
- `src/jev.ts` — the decider: one `fetch` to `POST /v1/systemone`, plus the `Decider` seam
- `src/spec.ts` — the vocabulary you write down: nodes, edges, handlers, the `on:` grammar, `probeReads`
- `src/validate.ts` — the proof. Returns problems as strings, never throws
- `src/graph.ts` — `graph.json`
- `src/execute.ts` — the cursor, `run.json`, and the `RunEvent` stream
- `src/report.ts` — the terminal reporter (one consumer of `RunEvent`, not the only possible one)
- `src/runner.ts` — ties them into a callable; `src/index.ts` — the public surface
- `src/cli.ts` — `validate` / `graph` / `run`

`examples/` — three runnable runners, each with a header comment saying what it
demonstrates. `test/` — one `*.test.mts` per suite, auto-discovered by
`test/run.mts`.

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
| `node src/cli.ts <cmd>` | The CLI from this checkout — use this, not a globally installed `ensemble` |

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

There are three node kinds (`decide`, `work`, `code`), two branch forms (`on:`
for meaning, `when:` for arithmetic) and three questions. Each is a closed set,
and the closed-ness is the feature — it is what lets `validate` prove
exhaustiveness and `graph` emit a complete document. Adding a fourth of anything
needs a reason that survives that argument.

If it is added anyway: a node kind needs an `isX` guard in `spec.ts`, a
`writesOf`/`readsOf` branch, a `validate` check, a `graph` cost class, and an
`execute` arm.
</important>

<important if="you are changing validation or the data graph">

State keys have exactly two origins: the runner's `inputs` (plus `goal`, always)
and a node's writes — a decide node writes one key per question. `validate`
proves every key a node reads, and every key a `when()` touches, has one. A
`when` is opaque code, so its reads are discovered by running it against a
recording proxy (`probeReads`), never by parsing source.

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

<important if="you are working on Jev questions, criteria, or thresholds">

Jev is documented as unreliable at counting, arithmetic and date ordering, and
loses accuracy on multi-hop questions and on state padded with irrelevant
detail. So: numbers belong in `when:`/`code`, `reads` stays a hard filter, and
questions stay atomic — asking five narrow ones costs one round trip because
they run in parallel. Use `not_for` to draw the boundary against the neighbouring
option. See https://docs.typesafe.ai/model-jaggedness/jev-1.13.
</important>

<important if="you are committing, branching, or shipping">

The v2 rewrite lives on `v2`; `main` still holds the old orchestration product
and is reached only through a PR. Everything deleted in the rewrite — the
viewer, `serve.ts`, the runtime zoo, autoresearch, the plugin — is recoverable
from `main`, and autoresearch in particular is parked rather than abandoned.
This repo's own `/.ensemble/` is gitignored.
</important>
