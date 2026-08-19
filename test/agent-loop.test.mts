// Offline verification of the agent-loop changes: tool-result pruning, the
// forced final turn (turn budget), and the cost ceiling. OpenRouter is mocked;
// no network, no spend.
import assert from "node:assert/strict";
import { callAgent } from "../src/runtimes/agent.ts";

const LONG = "x".repeat(1000);

/** A fake MCP hub exposing one tool that returns a long result. */
const hub = {
  toolsFor: () => [{ name: "lookup", description: "look something up", inputSchema: { type: "object" } }],
  call: async () => LONG,
};

function toolCallMessage(i) {
  return {
    choices: [{ message: { role: "assistant", content: null, tool_calls: [
      { id: `c${i}`, function: { name: "lookup", arguments: "{}" } },
    ] } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
  };
}
const answerMessage = {
  choices: [{ message: { role: "assistant", content: "FINAL ANSWER" } }],
  usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 },
};

/** Installs a fetch mock; records each request body; pops canned replies. */
function mockFetch(replies) {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const reply = replies.shift();
    return { ok: true, json: async () => reply };
  };
  return bodies;
}

process.env.OPENROUTER_API_KEY = "test-key";
const base = {
  model: "openrouter/test/model",
  messages: [{ role: "user", content: "go" }],
  mcp: ["fake"],
  builtins: [],
  skills: [],
  hub,
  root: process.cwd(),
};

// ── 1 · turn budget: last turn is forced tool-free and still answers ─────────
{
  const bodies = mockFetch([toolCallMessage(1), toolCallMessage(2), answerMessage]);
  const res = await callAgent({ ...base, maxTurns: 3 });

  assert.equal(res.turns, 3);
  assert.equal(res.text, "FINAL ANSWER");
  assert.equal(res.error, undefined, "forced final turn should prevent the maxTurns failure");
  assert.ok("tools" in bodies[0] && "tools" in bodies[1], "normal turns offer tools");
  assert.ok(!("tools" in bodies[2]), "final turn must not offer tools");
  const nudge = bodies[2].messages.filter((m) => typeof m.content === "string" && m.content.includes("FINAL turn"));
  assert.equal(nudge.length, 1, "final turn carries exactly one nudge");
  assert.ok(nudge[0].content.includes("turn budget"), "nudge names the turn budget");
  console.log("ok · turn budget forces a tool-free final answer");
}

// ── 2 · cost ceiling: crossing costLimit forces the final answer ─────────────
{
  const bodies = mockFetch([
    { ...toolCallMessage(1), usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.06 } },
    answerMessage,
  ]);
  const res = await callAgent({ ...base, maxTurns: 10, costLimit: 0.05 });

  assert.equal(res.turns, 2);
  assert.equal(res.text, "FINAL ANSWER");
  assert.ok(!("tools" in bodies[1]), "over-budget turn must not offer tools");
  const nudge = bodies[1].messages.find((m) => typeof m.content === "string" && m.content.includes("cost budget"));
  assert.ok(nudge, "nudge names the cost budget");
  console.log("ok · cost ceiling forces a tool-free final answer");
}

// ── 3 · pruning: only the newest 6 tool results stay full-size ───────────────
{
  const replies = [];
  for (let i = 1; i <= 8; i++) replies.push(toolCallMessage(i));
  replies.push(answerMessage);
  const bodies = mockFetch(replies);
  const res = await callAgent({ ...base, maxTurns: 12 });

  assert.equal(res.text, "FINAL ANSWER");
  const last = bodies[bodies.length - 1];
  const toolMsgs = last.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 8);
  const cleared = toolMsgs.filter((m) => m.content.startsWith("[cleared] "));
  const full = toolMsgs.filter((m) => m.content.length >= 1000);
  assert.equal(cleared.length, 2, "8 results − keep 6 → 2 cleared");
  assert.equal(full.length, 6, "newest 6 stay full-size");
  assert.deepEqual(toolMsgs.slice(0, 2), cleared, "the cleared ones are the oldest");
  console.log("ok · pruning keeps the newest 6 tool results, stubs the rest");
}

console.log("\nall agent-loop tests pass");
