// The interactive-game capability: an `always` ask node re-parks every round,
// the pause carries the question GENERATED during the run, and state (the
// scoreboard) accumulates across resumes. Plays a complete 2-round quiz
// offline — mocked model, no key, no spend.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScene } from "../src/scene.ts";
import { loadRegistry } from "../src/registry.ts";
import { runScene, readJournal } from "../src/engine.ts";

import { fileURLToPath as __f } from "node:url";
import { dirname as __d } from "node:path";
const REPO = __d(__d(__f(import.meta.url)));

process.env.OPENROUTER_API_KEY = "test-key";
const work = mkdtempSync(join(tmpdir(), "ensemble-game-"));
writeFileSync(join(work, "game.mts"), `import { scene, z } from "${REPO}/src/index.ts";
export default scene({
  name: "minigame",
  defaults: { model: "openrouter/test/model" },
  state: {
    round: z.number(), done: z.enum(["yes", "no"]),
    trivia_question: z.string(), scoreboard: z.record(z.number()),
  },
  nodes: {
    intro:  { outputs: ["welcome"] },
    setup:  { runtime: "ask", question: "Players and subject?", inputs: ["welcome"], outputs: ["players", "subject"] },
    board:  { inputs: ["players"], outputs: ["round", "scoreboard", "done"] },
    quiz:   { inputs: ["subject", "round"], outputs: ["trivia_question", "correct_answer"] },
    collect:{ runtime: "ask", always: true, question: "Answers, in order!",
              inputs: ["round", "trivia_question"], outputs: ["answers"] },
    judge:  { inputs: ["answers", "correct_answer", "scoreboard", "round"],
              outputs: ["scoreboard", "round", "done"] },
    podium: { inputs: ["scoreboard"], outputs: ["finale"] },
  },
  edges: [
    { from: "intro", to: "setup" }, { from: "setup", to: "board" },
    { from: "board", to: "quiz" }, { from: "quiz", to: "collect" },
    { from: "collect", to: "judge" },
    { from: "judge", to: "quiz", when: (s) => s.done !== "yes", maxLoops: 1 },
    { from: "judge", to: "podium" },
  ],
  entry: "intro", exit: "podium",
});
`, "utf8");
process.chdir(work);

// --- a scripted quiz host: deterministic outputs per node, rounds counted ---
let quizRound = 0, judgeCall = 0;
function mockFetch(): void {
  globalThis.fetch = (async (_u: string, init: { body: string }) => {
    const text = (JSON.parse(init.body) as { messages: Array<{ content: string }> })
      .messages.map((m) => m.content).join("\n");
    // Dispatch on INPUT sections (### key), which are unambiguous — several
    // nodes share output keys, so keying on outputs mixed them up.
    let payload: Record<string, unknown>;
    if (text.includes('"welcome"')) payload = { welcome: "Welcome to the quiz!" };
    else if (text.includes("### answers")) { judgeCall++; payload = judgeCall === 1
      ? { scoreboard: { Ana: 1, Ben: 0 }, round: 2, done: "no" }
      : { scoreboard: { Ana: 1, Ben: 1 }, round: 3, done: "yes" }; }
    else if (text.includes('"trivia_question"')) { quizRound++; payload = { trivia_question: `Q${quizRound}?`, correct_answer: `A${quizRound}` }; }
    else if (text.includes('"finale"')) payload = { finale: "Ana wins 1-1... a tie!" };
    else payload = { round: 1, scoreboard: { Ana: 0, Ben: 0 }, done: "no" };
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: "\`\`\`json\n" + JSON.stringify(payload) + "\n\`\`\`" } }] })}\n\n`
      + `data: ${JSON.stringify({ usage: { prompt_tokens: 8, completion_tokens: 6, cost: 0.01 } })}\n\n` + `data: [DONE]\n\n`;
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) };
  }) as never;
}

const scn = await loadScene(join(work, "game.mts"), loadRegistry());

// ── 1 · the run parks on setup, with the host's welcome as context ─────────
mockFetch();
const p1 = await runScene(scn, "quiz night", {});
assert.equal(p1.ok, false);
assert.equal(p1.waiting?.node, "setup");
assert.match(p1.waiting?.context ?? "", /Welcome to the quiz/, "the pause carries the welcome");
console.log("ok · 1 parks on setup; pause context carries generated content");

// ── 2 · setup answered → round 1 question generated → parks on collect ─────
mockFetch();
const p2 = await runScene(scn, "quiz night", {
  resumeFrom: readJournal(p1.runDir),
  answers: { players: "Ana, Ben", subject: "space" },
});
assert.equal(p2.waiting?.node, "collect");
assert.match(p2.waiting?.context ?? "", /Q1\?/, "the GENERATED question reaches the answerer");
assert.deepEqual(p2.waiting?.outputs, ["answers"]);
console.log("ok · 2 round 1 parks on collect, generated question in the pause context");

// ── 3 · answers in → judged → `always` RE-PARKS for round 2 ────────────────
mockFetch();
const p3 = await runScene(scn, "quiz night", {
  resumeFrom: readJournal(p2.runDir),
  answers: { answers: "Ana: A1 — Ben: wrong" },
});
assert.equal(p3.ok, false, "must ask again for round 2 — the old bug played the game by itself");
assert.equal(p3.waiting?.node, "collect");
assert.match(p3.waiting?.context ?? "", /Q2\?/, "a FRESH question, not round 1's");
assert.equal((p3.state["scoreboard"] as Record<string, number>)["Ana"], 1, "round 1's point survived the pause");
console.log("ok · 3 `always` re-parks each round; score persists across pauses");

// ── 4 · final round answered → game completes with accumulated scoreboard ──
mockFetch();
const p4 = await runScene(scn, "quiz night", {
  resumeFrom: readJournal(p3.runDir),
  answers: { answers: "Ben: A2 — Ana: nope" },
});
assert.equal(p4.ok, true, `game should finish: ${JSON.stringify(p4)}`);
assert.deepEqual(p4.state["scoreboard"], { Ana: 1, Ben: 1 });
assert.match(String(p4.state["finale"]), /tie/);
// setup (presence-based) never re-asked: exactly the asymmetry `always` exists for.
const events = readFileSync(join(p4.runDir, "events.jsonl"), "utf8");
assert.equal((events.match(/"type":"node:ask","node":"setup"/g) ?? []).length, 1, "setup asked exactly once");
assert.equal((events.match(/"type":"node:ask","node":"collect"/g) ?? []).length, 2, "collect asked every round");
console.log("ok · 4 complete game: 2 rounds, 4 pauses total, scoreboard accumulated, finale delivered");

console.log("\nall ask-always (interactive game) tests pass");
