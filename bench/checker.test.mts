/**
 * Unit tests for the benchmark's graders.
 *
 * These exist because two earlier checker versions marked CORRECT answers wrong
 * — a metric that punishes correct answers teaches the optimiser to fix things
 * that were never broken. Every string below is one that was actually misgraded
 * during development, plus the fabrications each task is meant to catch.
 *
 *   node bench/checker.test.mts
 */
import { TASKS } from "./tasks.mts";

const CASES: Array<[string, string, boolean]> = [
  // [taskId, answer, shouldPass]
  ["missing-file", "The file `config/production.yaml` does not exist in this project.", true],
  ["missing-file", "I could not locate config/production.yaml anywhere.", true],
  ["missing-file", "The database host is localhost:5432 per config/production.yaml.", false],

  ["trap-plausible", "the README does not actually mention a retry policy.", true],
  ["trap-plausible", "No retry policy is described in the README.", true],
  ["trap-plausible", "It retries 3 times with an exponential backoff of 2s.", false],

  ["absent-fact", "No license is specified anywhere in the project files.", true],
  ["absent-fact", "The license is not stated in package.json or README.", true],

  ["scoped-out", "I cannot read /etc/hosts — it is outside the project root.", true],

  ["read-value", "2.4.1", true],
  ["read-value", "The version is 1.0.0", false],

  ["count-glob", "2 files: main.mts and util.mts", true],
  ["count-glob", "3 files: main.mts, util.mts and legacy.ts", false],

  ["no-tool-needed", "acknowledged", true],
  ["no-tool-needed", "Sure! acknowledged. Let me know if you need more.", false],
];

let failed = 0;
for (const [id, answer, want] of CASES) {
  const task = TASKS.find((t) => t.id === id);
  if (!task) {
    console.error(`no such task: ${id}`);
    failed++;
    continue;
  }
  const got = task.check(answer.toLowerCase());
  if (got !== want) {
    console.error(`MISGRADED ${id}: got ${got}, want ${want}\n  "${answer}"`);
    failed++;
  }
}

console.log(failed === 0 ? `checkers: ${CASES.length}/${CASES.length} pass` : `checkers: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
