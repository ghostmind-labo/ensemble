// `ensemble init` exists to make an editor resolve scenes. The test therefore
// runs the REAL TypeScript compiler over a scaffolded project — checking the
// files exist would prove nothing about the thing that was broken.
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, packageRoot } from "../src/init.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d, join as __j } from "node:path";
/** Repo root, so scenes written into temp dirs can import by absolute path. */
const REPO = __d(__d(__f(import.meta.url)));

const TSC = __j(REPO, "node_modules", ".bin", "tsc");
const box = mkdtempSync(join(tmpdir(), "ensemble-init-"));

// ── 1 · scaffolds the files an editor needs ────────────────────────────────
const first = initProject(box, { starter: true });
for (const f of ["tsconfig.json", "deno.json", ".gitignore", "scenes/starter.mts"]) {
  assert.ok(existsSync(join(box, ".ensemble", f)), `${f} created`);
}
const link = join(box, ".ensemble", "node_modules", "@ghostmind-dev", "ensemble");
assert.ok(lstatSync(link).isSymbolicLink(), "package symlinked for resolution");
assert.equal(readFileSync(link + "/package.json", "utf8").length > 0, true, "symlink resolves");
assert.equal(first.skipped.length, 0);
console.log("ok · 1 scaffolds tsconfig, deno.json, .gitignore, starter scene, package symlink");

// ── 2 · idempotent: a second run touches nothing ───────────────────────────
writeFileSync(join(box, ".ensemble", "tsconfig.json"), '{"mine":true}', "utf8");
const second = initProject(box, {});
assert.ok(second.skipped.some((f) => f.endsWith("tsconfig.json")), "existing file skipped");
assert.equal(readFileSync(join(box, ".ensemble", "tsconfig.json"), "utf8"), '{"mine":true}', "not clobbered");
const forced = initProject(box, { force: true });
assert.ok(forced.created.some((f) => f.endsWith("tsconfig.json")), "--force rewrites");
assert.notEqual(readFileSync(join(box, ".ensemble", "tsconfig.json"), "utf8"), '{"mine":true}');
console.log("ok · 2 idempotent — existing files kept unless --force");

// ── 3 · the starter scene type-checks CLEAN with real tsc ──────────────────
const run = (): string => {
  try {
    execFileSync(TSC, ["--noEmit", "-p", "tsconfig.json"], { cwd: join(box, ".ensemble"), encoding: "utf8" });
    return "";
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? e);
  }
};
assert.equal(run(), "", "the scaffolded starter scene must type-check with no errors");
console.log("ok · 3 starter scene type-checks clean (import resolves — the original bug)");

// ── 4 · typed state actually reaches `when` — the point of the fix ─────────
writeFileSync(
  join(box, ".ensemble", "scenes", "probe.mts"),
  `import { scene, z } from "@ghostmind-dev/ensemble";
export default scene({
  name: "probe",
  defaults: { model: "openrouter/a/b" },
  state: { score: z.number(), verdict: z.enum(["accept", "reject"]) },
  nodes: { j: { outputs: ["score"] }, w: { outputs: ["x"] } },
  edges: [
    { from: "j", to: "w", when: (s) => s.score === "high" },
    { from: "j", to: "w", when: (s) => s.verdict === "maybe" },
  ],
  entry: "j", exit: "w",
});
`,
  "utf8",
);
const errs = run();
assert.match(errs, /'number' and 'string' have no overlap/, "a number/string compare must be caught");
assert.match(errs, /"accept" \| "reject"/, "the enum must reach the predicate");
console.log("ok · 4 schemas type `when` predicates — wrong comparisons are compile errors");

console.log("\nall init tests pass");
