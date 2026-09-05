// The skill is documentation an AGENT acts on, so a stale claim in it is a bug
// that ships. These tests pin the parts that drift when the code changes: the
// runtime/field table, the register functions, and the example model refs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIMES } from "../src/runtimes/index.ts";
import * as api from "../src/index.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

const SKILL = join(REPO, "plugin/skills/ensemble/SKILL.md");
const skill = readFileSync(SKILL, "utf8");

// -- 1 . every registered runtime appears in the skill, with its real badge ---
for (const [name, rt] of Object.entries(RUNTIMES)) {
  assert.ok(
    skill.includes(`\`${name}\``) || skill.includes(`"${name}"`),
    `runtime "${name}" is registered but never named in SKILL.md — an agent will not know it exists`,
  );
  assert.ok(
    skill.includes(rt.badge),
    `runtime "${name}" badge ${rt.badge} is missing from SKILL.md`,
  );
}
console.log(`ok - 1 all ${Object.keys(RUNTIMES).length} runtimes are documented with their badges`);

// -- 2 . every field a runtime accepts is named in the skill ------------------
// The whole point of the table is that a field its runtime does not accept is a
// validation error, so an undocumented field is one an agent will never use.
const missing: string[] = [];
for (const [name, rt] of Object.entries(RUNTIMES)) {
  for (const field of Object.keys(rt.fields)) {
    if (!skill.includes(`\`${field}\``)) missing.push(`${name}.${field}`);
  }
}
assert.deepEqual(missing, [], `fields accepted by a runtime but absent from SKILL.md: ${missing.join(", ")}`);
console.log("ok - 2 every runtime field is documented");

// -- 3 . the skill does not document fields that do not exist ----------------
// The reverse drift, and the more dangerous one: an agent that writes
// `maxTurns` on an opencode node gets a validation error it cannot explain.
const CLAIMED: Record<string, string[]> = {
  model: ["model", "prompt", "temperature"],
  agent: ["model", "prompt", "temperature", "skills", "mcp", "tools", "maxTurns"],
  opencode: ["model", "prompt", "skills", "mcp", "timeout", "dir"],
  ask: ["question", "always"],
  fn: ["fn"],
  experiment: ["note"],
  refine: ["candidate", "score", "minimize", "threshold", "patience", "target"],
};
for (const [name, claimed] of Object.entries(CLAIMED)) {
  const actual = Object.keys(RUNTIMES[name]?.fields ?? {}).sort();
  assert.deepEqual(
    [...claimed].sort(), actual,
    `SKILL.md's table for "${name}" is out of date — it says [${claimed.sort()}], the runtime accepts [${actual}]`,
  );
}
console.log("ok - 3 the documented field table matches the registry exactly");

// -- 4 . every register function the skill names is actually exported ---------
for (const fn of ["registerRuntime", "registerAgentBackend", "registerTool",
                  "registerEdgeKind", "registerCapability"]) {
  assert.ok(skill.includes(fn), `SKILL.md never mentions ${fn}`);
  assert.equal(typeof (api as Record<string, unknown>)[fn], "function",
    `SKILL.md names ${fn} but it is not exported from the package`);
}
assert.ok(api.fileRunStore && typeof api.fileRunStore === "object",
  "SKILL.md tells the reader to wrap fileRunStore, so it must be exported");
console.log("ok - 4 every register function named in the skill is exported");

// -- 5 . the two autoresearch skills exist and route to each other -----------
const concept = readFileSync(join(REPO, "plugin/skills/autoresearch/SKILL.md"), "utf8");
const build = readFileSync(join(REPO, "plugin/skills/autoresearch-build/SKILL.md"), "utf8");
assert.match(concept, /autoresearch-build/, "the concept skill must point at the implementation skill");
assert.match(build, /`autoresearch`/, "the build skill must point at the concept skill");
assert.match(skill, /autoresearch-build/, "the ensemble skill must route to the build skill");

const manifest = JSON.parse(readFileSync(join(REPO, "plugin/.claude-plugin/plugin.json"), "utf8"));
assert.deepEqual(
  [...manifest.skills].sort(),
  ["./skills/autoresearch", "./skills/autoresearch-build", "./skills/ensemble"],
  "every skill directory must be registered in plugin.json",
);
console.log("ok - 5 all three skills exist, cross-reference, and are registered");

console.log("\nall skill-accuracy tests pass");
