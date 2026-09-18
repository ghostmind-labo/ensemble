// The proof. Every case here is a bug that would otherwise run, look fine, and
// be wrong — an unwired branch falling through to the exit, a key nothing
// writes arriving as undefined. Offline: validate never calls out.
import assert from "node:assert/strict";
import { choice, noul, runner, score, validate, type RunnerSpec } from "../src/index.ts";

const says = (problems: string[], pattern: RegExp): boolean => problems.some((p) => pattern.test(p));
const kind = () => choice("What kind?", { photo: null, diagram: null, logo: null });

const sound = (): RunnerSpec => ({
  name: "t",
  work: { a: () => 1, b: () => 2, c: () => 3 },
  nodes: {
    pick: { decide: { kind: kind() }, reads: ["goal"] },
    photo: { work: "a", writes: ["out"] },
    diagram: { work: "b", writes: ["out"] },
    logo: { work: "c", writes: ["out"] },
  },
  edges: [
    { from: "pick", to: "photo", on: "kind=photo" },
    { from: "pick", to: "diagram", on: "kind=diagram" },
    { from: "pick", to: "logo", on: "kind=logo" },
  ],
  entry: "pick",
});

// ── 1 · a sound runner has nothing to say ───────────────────────────────────
assert.deepEqual(validate(sound()), []);
assert.deepEqual(runner(sound()).validate(), [], "the same check hangs off the runner");
console.log("ok · 1 a sound runner validates clean");

// ── 2 · an unhandled option is named, not merely counted ────────────────────
const missing = sound();
missing.edges = missing.edges!.slice(0, 2);
assert.ok(says(validate(missing), /nothing handles "logo"/), validate(missing).join("\n"));
assert.ok(says(validate(missing), /fall through to the exit/));
console.log("ok · 2 an unhandled choice option is reported by name");

// ── 3 · a bare edge is the declared default, and settles exhaustiveness ─────
const withDefault = sound();
withDefault.edges = [...withDefault.edges!.slice(0, 2), { from: "pick", to: "logo" }];
assert.deepEqual(validate(withDefault), []);
console.log("ok · 3 a bare edge counts as the default branch");

// ── 4 · an on: branch must leave the node that answered it ──────────────────
const elsewhere = sound();
elsewhere.edges!.push({ from: "photo", to: "logo", on: "kind=logo" });
assert.ok(says(validate(elsewhere), /is not a decide node/));
assert.ok(says(validate(elsewhere), /use when:/), "the message names the fix");

const unasked = sound();
unasked.edges![0] = { from: "pick", to: "photo", on: "mood=photo" };
assert.ok(says(validate(unasked), /"pick" does not ask/));
console.log("ok · 4 on: must leave the decide node, and name a question it asks");

// ── 5 · the question type has to match the branch form ──────────────────────
const asThreshold = sound();
asThreshold.edges![0] = { from: "pick", to: "photo", on: "kind>=0.7" };
assert.ok(says(validate(asThreshold), /thresholds "kind", a choice/));

const scored: RunnerSpec = {
  ...sound(),
  nodes: {
    ...sound().nodes,
    pick: { decide: { kind: kind(), hard: score("How hard?", ["easy", "hard"]) }, reads: ["goal"] },
  },
};
scored.edges = [...scored.edges!, { from: "pick", to: "photo", on: "hard>=1.5" }];
assert.ok(says(validate(scored), /a score. A score is a number/));
assert.ok(says(validate(scored), /when: \(s\) => s\.hard >= 1\.5/), "it writes the replacement out");

const asOption: RunnerSpec = {
  ...sound(),
  nodes: { ...sound().nodes, pick: { decide: { kind: kind(), sure: noul("Sure?") }, reads: ["goal"] } },
};
asOption.edges = [...asOption.edges!, { from: "pick", to: "photo", on: "sure=yes" }];
assert.ok(says(validate(asOption), /only a choice answers/));
console.log("ok · 5 a branch form that does not fit its question type is refused");

// ── 6 · the confidence gate ─────────────────────────────────────────────────
const gateNoul: RunnerSpec = {
  ...sound(),
  nodes: {
    ...sound().nodes,
    pick: {
      decide: { kind: kind(), sure: noul("Sure?") },
      reads: ["goal"],
      gate: { on: "sure", min: 0.7, to: "photo" },
    },
  },
};
assert.ok(says(validate(gateNoul), /a noul reports no confidence/));

const gateUnknown = sound();
gateUnknown.nodes["pick"] = { decide: { kind: kind() }, reads: ["goal"], gate: { on: "mood", min: 0.7, to: "photo" } };
assert.ok(says(validate(gateUnknown), /gates on "mood", which it does not ask/));

const gateNowhere = sound();
gateNowhere.nodes["pick"] = { decide: { kind: kind() }, reads: ["goal"], gate: { on: "kind", min: 2, to: "nope" } };
assert.ok(says(validate(gateNowhere), /gates to "nope", which is not a node/));
assert.ok(says(validate(gateNowhere), /confidence is between 0 and 1/));
console.log("ok · 6 gates must name a confident question, a real target, and a real threshold");

// ── 7 · a decide node must declare what it sends ────────────────────────────
const noReads = sound();
noReads.nodes["pick"] = { decide: { kind: kind() }, reads: [] };
assert.ok(says(validate(noReads), /declares no reads/));
assert.ok(says(validate(noReads), /the filter is the feature/));
console.log("ok · 7 a decide node must name the state it sends");

// ── 8 · a work node must resolve to a registered handler ────────────────────
const noHandler = sound();
noHandler.nodes["photo"] = { work: "nope", writes: ["out"] };
assert.ok(says(validate(noHandler), /not in the work map/));
assert.ok(says(validate(noHandler), /Registered: "a", "b", "c"/));
console.log("ok · 8 an unregistered work name is caught with the list of real ones");

// ── 9 · the data graph: every key read has an origin ────────────────────────
const orphanRead = sound();
orphanRead.nodes["pick"] = { decide: { kind: kind() }, reads: ["goal", "house_rules"] };
assert.ok(says(validate(orphanRead), /reads "house_rules" but nothing writes it/));
assert.ok(says(validate(orphanRead), /inputs: \["…"\]/), "the message names the one-line fix");

// declaring it as an input is that fix
const declared = sound();
declared.inputs = ["house_rules"];
declared.nodes["pick"] = { decide: { kind: kind() }, reads: ["goal", "house_rules"] };
assert.deepEqual(validate(declared), []);

// and a `when` predicate is held to the same standard, though it is opaque code
const orphanWhen = sound();
orphanWhen.edges!.push({ from: "photo", to: "logo", when: (s) => Number(s["mystery"]) > 1 });
assert.ok(says(validate(orphanWhen), /reads "mystery" in its when\(\)/));
console.log("ok · 9 keys read by a node OR by a when() must have an origin");

// ── 10 · structure: entry, reachability, node kind ──────────────────────────
const badEntry = sound();
badEntry.entry = "nowhere";
assert.ok(says(validate(badEntry), /entry "nowhere" is not a node/));

const stranded = sound();
stranded.nodes["ghost"] = { work: "a", writes: ["out"] };
assert.ok(says(validate(stranded), /unreachable from "pick": "ghost"/));

const twoKinds = sound();
twoKinds.nodes["photo"] = { work: "a", code: () => 1, writes: ["out"] } as never;
assert.ok(says(validate(twoKinds), /is both work and code/));

const noKind = sound();
noKind.nodes["photo"] = { writes: ["out"] } as never;
assert.ok(says(validate(noKind), /is none of decide \/ work \/ code/));
console.log("ok · 10 entry, reachability and node kind are all checked");

console.log("10 cases");
