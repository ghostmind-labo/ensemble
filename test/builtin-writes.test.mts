// The write half of the built-in toolset: write_file, edit_file, bash.
//
// These are the tools that can change the world, so the tests are mostly about
// what they REFUSE. No model is called; no key, no spend.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUILTIN_TOOLS } from "../src/tools/builtin.ts";

const root = mkdtempSync(join(tmpdir(), "ensemble-writes-"));
const tool = (name: string) => {
  const t = BUILTIN_TOOLS.find((x) => x.name === name);
  assert.ok(t, `built-in "${name}" is registered`);
  return t;
};
const run = (name: string, args: Record<string, unknown>): Promise<string> =>
  Promise.resolve(tool(name).run(args, root));

// ── 1 · write_file writes, creates parents, and reports what it did ────────
assert.match(await run("write_file", { path: "a/b/c.txt", content: "hello" }), /wrote a\/b\/c\.txt \(5 chars\)/);
assert.equal(readFileSync(join(root, "a/b/c.txt"), "utf8"), "hello");
console.log("ok · 1 write_file creates parent directories");

// ── 2 · edit_file: unique snippet only, and it says why when it refuses ────
await run("write_file", { path: "e.txt", content: "one\ntwo\ntwo\nthree\n" });
assert.match(await run("edit_file", { path: "e.txt", find: "two", replace: "2" }),
  /occurs more than once/, "an ambiguous edit is refused, not guessed at");
assert.equal(readFileSync(join(root, "e.txt"), "utf8"), "one\ntwo\ntwo\nthree\n", "and nothing was written");
assert.match(await run("edit_file", { path: "e.txt", find: "nope", replace: "x" }), /snippet not found/);
assert.match(await run("edit_file", { path: "missing.txt", find: "a", replace: "b" }),
  /no such file.*use write_file to create it/);
assert.match(await run("edit_file", { path: "e.txt", find: "one\ntwo", replace: "1\n2" }), /edited e\.txt/);
assert.equal(readFileSync(join(root, "e.txt"), "utf8"), "1\n2\ntwo\nthree\n");
console.log("ok · 2 edit_file demands a unique snippet and refuses cleanly");

// ── 3 · every write tool is confined to the root ──────────────────────────
const outside = resolve(root, "..", "ESCAPED.txt");
for (const [name, args] of [
  ["write_file", { path: "../ESCAPED.txt", content: "x" }],
  ["write_file", { path: outside, content: "x" }],
  ["edit_file", { path: "../ESCAPED.txt", find: "a", replace: "b" }],
] as Array<[string, Record<string, unknown>]>) {
  await assert.rejects(
    async () => { await run(name, args); },
    /path escapes the project root/,
    `${name} refused ${String(args["path"])}`,
  );
}
assert.equal(existsSync(outside), false, "nothing was written outside the root");
console.log("ok · 3 write_file and edit_file cannot leave the root");

// ── 4 · bash returns exit status as data, not as an exception ─────────────
assert.match(await run("bash", { command: "echo hi" }), /\[exit 0\]\nhi/);
assert.match(await run("bash", { command: "echo oops >&2; exit 3" }), /\[exit 3\]\noops/,
  "a failing command is a RESULT — that is the signal the agent asked for");
assert.match(await run("bash", { command: "pwd" }), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  "bash runs from the project root");
assert.equal(await run("bash", { command: "   " }), "command must not be empty");
console.log("ok · 4 bash reports exit status as data and runs from the root");

// ── 5 · the timeout kills the WHOLE PROCESS GROUP, not just the shell ─────
// The trap: killing only the shell leaves the grandchild running with the pipes
// still open, so the parent hangs past its own timeout waiting for EOF.
const started = Date.now();
const out = await run("bash", { command: `sleep 30 & echo $! > gc.pid; sleep 30`, timeout: 1 });
const elapsed = Date.now() - started;
assert.match(out, /timed out after 1s \(killed\)/);
assert.ok(elapsed < 5_000, `returned promptly, took ${elapsed}ms`);

const gcPid = Number(readFileSync(join(root, "gc.pid"), "utf8").trim());
assert.ok(Number.isInteger(gcPid) && gcPid > 0, "the grandchild recorded its pid");
await new Promise((r) => setTimeout(r, 200));
assert.throws(() => process.kill(gcPid, 0), /ESRCH/,
  `grandchild ${gcPid} survived the timeout — the kill did not reach the process group`);
console.log("ok · 5 the bash timeout kills the whole process group");

// ── 6 · research mode withdraws bash and overrides the write tools ────────
const { researchCapability, researchTools } = await import("../src/research.ts");
assert.deepEqual(researchCapability.withdraws?.({} as never), ["bash"],
  "a proposer that can shell out can rewrite its own evaluator");

mkdirSync(join(root, "r"), { recursive: true });
writeFileSync(join(root, "r/artefact.js"), "// under study\n", "utf8");
const scoped = researchTools({ edit: "r/artefact.js" } as never);
assert.deepEqual(scoped.map((t) => t.name).sort(), ["edit_file", "write_file"],
  "research ships same-named tools, so they REPLACE the general built-ins");
await assert.rejects(
  async () => { await scoped[0]!.run({ path: "r/other.js", content: "x" }, root); },
  /refused: research\.edit allows only/,
  "the scoped write still refuses anything but the artefact",
);
console.log("ok · 6 research withdraws bash and overrides the write tools by name");

console.log("\nall builtin-write tests pass");
