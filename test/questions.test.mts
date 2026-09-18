// The three builders: what they accept, what they refuse, and what an answer
// contributes to state. No network — these are pure constructors.
import assert from "node:assert/strict";
import {
  CHOICE_MAX_OPTIONS,
  choice,
  confidenceOf,
  noul,
  optionsOf,
  score,
  valueOf,
  type Answer,
} from "../src/index.ts";

// ── 1 · choice carries its option names into the type and the data ──────────
const team = choice("Which team?", { billing: null, orders: "Parcels", account: { what: "Sign-in" } });
assert.equal(team.type, "choice");
assert.deepEqual(optionsOf(team), ["billing", "orders", "account"]);
// The option union is inferred, so a typo in a branch is a compile error.
const picked: "billing" | "orders" | "account" = "orders";
assert.ok(optionsOf(team).includes(picked));
console.log("ok · 1 choice keeps its options, and infers them as a union");

// ── 2 · the API limits are enforced where the fix is free ───────────────────
assert.throws(() => choice("x", { only: null } as Record<string, null>), /at least 2 options/);
const many = Object.fromEntries(Array.from({ length: CHOICE_MAX_OPTIONS + 1 }, (_, i) => [`o${i}`, null]));
assert.throws(() => choice("x", many), /at most 255 options/);
assert.throws(() => score("x", ["only one"]), /between 2 and 10 levels/);
assert.throws(() => score("x", Array.from({ length: 11 }, (_, i) => `l${i}`)), /between 2 and 10 levels/);
console.log("ok · 2 choice and score refuse what the API would reject, at authoring time");

// ── 3 · score levels are positional; noul criteria are optional ─────────────
const quality = score("How good?", ["bad", "fine", "good"]);
assert.equal(quality.criteria.length, 3);
assert.deepEqual(optionsOf(quality), [], "a score has no branch labels — it is a number");

assert.equal(noul("Is it spam?").criteria, undefined);
assert.deepEqual(noul("Is it spam?", { true: "yes it is", false: "no it is not" }).criteria, {
  true: "yes it is",
  false: "no it is not",
});
console.log("ok · 3 score is positional, noul criteria are optional");

// ── 4 · valueOf is what lands on the blackboard; noul reports no confidence ──
const asChoice: Answer = { type: "choice", choice: "orders", confidence: 0.91, probabilities: { orders: 0.91 } };
const asScore: Answer = { type: "score", score: 1.3, confidence: 0.54, probabilities: { "1": 0.7 }, legend: {} };
const asNoul: Answer = { type: "noul", noul: 0.93 };

assert.equal(valueOf(asChoice), "orders");
assert.equal(valueOf(asScore), 1.3, "a score is the EXPECTED value, not the argmax");
assert.equal(valueOf(asNoul), 0.93);

assert.equal(confidenceOf(asChoice), 0.91);
assert.equal(confidenceOf(asScore), 0.54);
assert.equal(confidenceOf(asNoul), undefined, "a noul's value IS its certainty");
console.log("ok · 4 valueOf keeps state boring; only choice and score have confidence");

console.log("4 cases");
