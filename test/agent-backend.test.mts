// Agent backends: the coding loop itself as a mountable object.
//
// A FAKE binary stands in for the real CLI — it echoes its argv and env, so we
// can assert exactly what would have been invoked without spending a cent or
// needing opencode installed. No model is called.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentBackend, AGENT_BACKENDS } from "../src/agents/index.ts";
import { opencodeBackend } from "../src/agents/opencode.ts";
import { RUNTIMES } from "../src/runtimes/index.ts";
import { loadScene, validateSpec, SceneError } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene } from "../src/engine.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const work = mkdtempSync(join(tmpdir(), "ensemble-backend-"));
process.chdir(work);

// ── 1 · a backend's NAME becomes a runtime name ────────────────────────────
assert.ok(RUNTIMES["opencode"], "registering a backend registers a runtime");
assert.equal(RUNTIMES["opencode"]?.needsModel, true);
assert.ok(AGENT_BACKENDS["opencode"], "and it is listed as a backend");
assert.ok(RUNTIMES["opencode"]?.fields["dir"], "shared fields are declared once, on the generated runtime");
console.log("ok · 1 registerAgentBackend mounts a full runtime under the backend's name");

// ── 2 · opencode builds the argv and config we verified against its schema ──
const built = opencodeBackend.command({
  model: "openrouter/anthropic/claude-sonnet-5",
  prompt: "do the thing",
  cwd: "/tmp/proj",
  timeoutMs: 1000,
  skillDirs: ["/skills/house-style"],
  mcp: [{ name: "pg", type: "local", enabled: true, source: "t", command: ["npx", "pg-mcp"] }],
  spec: {},
});
assert.deepEqual(built.argv, [
  "opencode", "run", "--dir", "/tmp/proj",
  "--model", "openrouter/anthropic/claude-sonnet-5",
  "--format", "json", "--auto", "do the thing",
]);
assert.equal(built.argv[5], "openrouter/anthropic/claude-sonnet-5",
  "the scene's model ref passes through verbatim — no translation layer");

const cfg = JSON.parse(built.env?.["OPENCODE_CONFIG_CONTENT"] ?? "{}");
assert.equal(cfg.permission, "allow", "headless: nothing may wait for a human");
assert.deepEqual(cfg.skills, { paths: ["/skills/house-style"] },
  "the scene's skill grant reaches the rented agent, not just our own loop");
assert.deepEqual(cfg.mcp, { pg: { type: "local", command: ["npx", "pg-mcp"], enabled: true } },
  "and so do its MCP servers");
assert.equal(built.env?.["OPENCODE_DISABLE_PROJECT_CONFIG"], "1",
  "a stray opencode.json in the project must not change what a node does");
console.log("ok · 2 opencode argv + injected config carry the scene's grants across");

// ── 3 · a missing binary is caught by validate, not at run time ────────────
registerAgentBackend({
  name: "ghostagent",
  summary: "a backend whose binary is not installed",
  bin: "definitely-not-installed-xyz",
  install: "npm i -g nothing",
  command: () => ({ argv: ["definitely-not-installed-xyz"] }),
  parse: (r) => ({ text: r.stdout }),
});
const problemsOf = (spec: unknown): string[] => {
  try { validateSpec(spec, "x.mts", loadRegistry()); return []; }
  catch (e) { return e instanceof SceneError ? e.problems : [String(e)]; }
};
assert.match(
  problemsOf({
    name: "t", entry: "n", exit: "n",
    defaults: { model: "openrouter/test/model" },
    nodes: { n: { runtime: "ghostagent", outputs: ["x"] } },
  }).join(";"),
  /is not on PATH — install it with: npm i -g nothing/,
  "the free pre-flight names the install command",
);
console.log("ok · 3 a missing binary fails validate, with the fix in the message");

// ── 4 · a real subprocess, end to end, through the engine ──────────────────
// The fake CLI answers with the fenced json the output contract demands — the
// point being that a rented agent is held to the SAME contract as our own loop.
const fake = join(work, "fake-agent");
// The event shape here is REAL — captured from opencode 1.18.21's --format json,
// not invented. Everything hangs off `part`; a parser that reads top-level
// `text`/`usage` (as an earlier one did) silently extracts nothing.
//
// printf '%s', not echo: /bin/sh's echo expands backslash escapes, which would
// break the JSON across lines before the parser ever saw it.
writeFileSync(fake, `#!/bin/sh
printf '%s\\n' '{"type":"step_start","part":{"type":"step-start"}}'
printf '%s\\n' "{\\"type\\":\\"argv-probe\\",\\"argv\\":\\"$*\\",\\"skills\\":\\"$OC_TEST_SKILLS\\"}"
printf '%s\\n' '{"type":"text","part":{"type":"text","text":"I made the change.\\n\\n\`\`\`json\\n{\\"verdict\\": \\"done\\"}\\n\`\`\`"}}'
printf '%s\\n' '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":120,"output":8},"cost":0.004}}'
`, "utf8");
chmodSync(fake, 0o755);

mkdirSync(join(work, ".claude/skills/house-style"), { recursive: true });
writeFileSync(join(work, ".claude/skills/house-style/SKILL.md"),
  "---\nname: house-style\ndescription: house\n---\n\nGREY.\n", "utf8");

registerAgentBackend({
  name: "fakeagent",
  summary: "a fake CLI for tests",
  bin: fake,
  command: ({ prompt, skillDirs }) => ({
    argv: [fake, prompt],
    env: { OC_TEST_SKILLS: skillDirs.join(",") },
  }),
  parse: opencodeBackend.parse,
});

writeFileSync(join(work, "s.mts"), `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "rented",
  defaults: { model: "openrouter/test/model", skills: ["house-style"] },
  state: { verdict: z.string() },
  nodes: { build: { runtime: "fakeagent", prompt: "Fix the parser.", outputs: ["verdict"] } },
  entry: "build", exit: "build",
});
`, "utf8");

const run = await runScene(await loadScene(join(work, "s.mts"), loadRegistry()), "make it pass", {});
assert.equal(run.ok, true, JSON.stringify(run));
assert.equal(run.state["verdict"], "done",
  "the engine's own extractOutputs parsed the rented agent's reply — same contract");

const costs = JSON.parse(readFileSync(join(run.runDir, "costs.json"), "utf8"));
assert.equal(costs.nodes.build.cost, 0.004, "reported cost is accounted per node");
assert.equal(costs.nodes.build.tokensIn, 120);
console.log("ok · 4 a backend node runs, honours the output contract, and reports cost");

// ── 5 · a rented node is journalled like any other, so resume works ────────
const journal = JSON.parse(readFileSync(join(run.runDir, "journal.json"), "utf8"));
assert.ok(journal, "the run is journalled like any other — resume works unchanged");
console.log("ok · 5 a rented node is journalled like every other node");

console.log("\nall agent-backend tests pass");
