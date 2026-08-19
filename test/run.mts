/**
 * The suite runner.
 *
 * Each test is spawned as its own PROCESS, not imported: the suites chdir into
 * temp projects, set env vars, and replace global fetch, so sharing one process
 * would let them corrupt each other. Isolation is cheap and the failures stay
 * readable.
 *
 * Every suite is offline — OpenRouter is mocked — so `npm test` costs nothing
 * and needs no API key.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);

const only = process.argv[2];
const suites = readdirSync(here)
  .filter((f) => f.endsWith(".test.mts"))
  .filter((f) => !only || f.includes(only))
  .sort();

// The graders that keep the bench honest live with the bench.
const extra = only ? [] : [join(repo, "bench", "checker.test.mts")];
const files = [...suites.map((f) => join(here, f)), ...extra];

let failed = 0;
for (const file of files) {
  const name = file.replace(`${repo}/`, "");
  const started = Date.now();
  const res = spawnSync(process.execPath, [file], { cwd: repo, encoding: "utf8" });
  const ms = Date.now() - started;

  if (res.status === 0) {
    const last = (res.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
    console.log(`✓ ${name.padEnd(34)} ${String(ms).padStart(5)}ms  ${last}`);
  } else {
    failed++;
    console.log(`✗ ${name.padEnd(34)} ${String(ms).padStart(5)}ms`);
    console.log((res.stdout ?? "").split("\n").slice(-25).join("\n"));
    console.log((res.stderr ?? "").split("\n").slice(-25).join("\n"));
  }
}

console.log(
  failed === 0
    ? `\n${files.length} suites passed`
    : `\n${failed} of ${files.length} suites FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
