// The `on:` grammar — the whole vocabulary for branching on meaning. Every
// form here has to survive, because each one becomes a labelled edge in the
// emitted graph and a documented promise to whoever renders it.
import assert from "node:assert/strict";
import { branchHolds, parseBranch } from "../src/index.ts";

// ── 1 · an option branch ────────────────────────────────────────────────────
assert.deepEqual(parseBranch("kind=photo"), { kind: "option", key: "kind", option: "photo" });
assert.deepEqual(parseBranch("  kind = photo  "), { kind: "option", key: "kind", option: "photo" });
// An option may contain anything but leading/trailing space — including dashes.
assert.deepEqual(parseBranch("kind=text-heavy"), { kind: "option", key: "kind", option: "text-heavy" });
console.log("ok · 1 key=option parses, and tolerates whitespace");

// ── 2 · the bare and negated noul forms default to 0.5 ──────────────────────
assert.deepEqual(parseBranch("needs_text"), { kind: "threshold", key: "needs_text", op: ">=", value: 0.5 });
assert.deepEqual(parseBranch("!needs_text"), { kind: "threshold", key: "needs_text", op: "<", value: 0.5 });
console.log("ok · 2 bare is >= 0.5, ! is < 0.5");

// ── 3 · explicit thresholds, all four operators ─────────────────────────────
for (const [text, op, value] of [
  ["p>=0.7", ">=", 0.7],
  ["p>0.7", ">", 0.7],
  ["p<=0.3", "<=", 0.3],
  ["p<0.3", "<", 0.3],
] as const) {
  assert.deepEqual(parseBranch(text), { kind: "threshold", key: "p", op, value });
}
console.log("ok · 3 >=, >, <= and < all parse with an explicit threshold");

// ── 4 · malformed branches fail loudly, at authoring time ───────────────────
assert.throws(() => parseBranch("!p>=0.7"), /cannot be combined/);
assert.throws(() => parseBranch("p>=banana"), /is not a number/);
assert.throws(() => parseBranch("9lives=x"), /cannot parse/);
assert.throws(() => parseBranch(""), /cannot parse/);
console.log("ok · 4 a malformed on: throws rather than silently never matching");

// ── 5 · evaluation against a blackboard ─────────────────────────────────────
const holds = (on: string, state: Record<string, unknown>) => branchHolds(parseBranch(on), state);

assert.equal(holds("kind=photo", { kind: "photo" }), true);
assert.equal(holds("kind=photo", { kind: "diagram" }), false);
assert.equal(holds("kind=photo", {}), false, "an unwritten key matches nothing");

assert.equal(holds("p", { p: 0.5 }), true, "the bare form is inclusive at 0.5");
assert.equal(holds("p", { p: 0.49 }), false);
assert.equal(holds("!p", { p: 0.49 }), true);
assert.equal(holds("p>=0.7", { p: 0.7 }), true);
assert.equal(holds("p>0.7", { p: 0.7 }), false);

// A key that is missing or not a number never matches — a branch must not fire
// on undefined, because that is exactly the silent failure this library exists
// to make impossible.
assert.equal(holds("p>=0.7", {}), false);
assert.equal(holds("p>=0.7", { p: "banana" }), false);
assert.equal(holds("!p", {}), false, "not even the negated form fires on an unwritten key");
console.log("ok · 5 branches evaluate, and never fire on a key nothing wrote");

console.log("5 cases");
