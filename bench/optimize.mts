/**
 * Autoresearch loop for the agent scaffolding prompt.
 *
 * The Karpathy pattern: propose a change, measure it, **keep or revert**, repeat,
 * and leave an audit trail. The mutable artefact here is the tool-guidance block
 * that every `runtime: "agent"` node receives (see buildSystem in
 * src/runtimes/agent.ts); the metric is bench/tasks.mts.
 *
 * Two things make this trustworthy rather than noise-chasing:
 *
 *   1. **Every measurement is an average of N sweeps.** A single sweep of the
 *      same prompt has scored 9/12 and 12/12 — comparing single runs would
 *      "discover" improvements that are pure luck.
 *   2. **A candidate must beat the incumbent by more than the noise floor.**
 *      Measured spread is ~1 point of score (~100 objective), so the default
 *      threshold is deliberately above zero. Ties revert.
 *
 *   node bench/optimize.mts --iterations=5 --repeat=3
 */
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bench, type BenchResult } from "./run.mts";
import { callModel } from "../src/runtimes/model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(HERE, "prompts");
const LOG = join(HERE, "log.jsonl");

const arg = (name: string, fallback: number): number => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.split("=")[1]) : fallback;
};

const ITERATIONS = arg("iterations", 5);
const REPEAT = arg("repeat", 3);
/** Objective points a candidate must gain to be believed. ~1 score point. */
const THRESHOLD = arg("threshold", 100);
const PROPOSER = process.env["OPTIMIZER_MODEL"] ?? "openrouter/anthropic/claude-sonnet-5";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function summarise(r: BenchResult): string {
  return (
    `score ${r.score.toFixed(2)}/${r.total} · ${r.turns.toFixed(1)} turns · ` +
    `objective ${r.objective.toFixed(1)}`
  );
}

/** What the proposer is told about the incumbent's weaknesses. */
function feedback(r: BenchResult): string {
  if (r.failures.length === 0) {
    return (
      `Every task passed, so correctness is saturated. The remaining objective is ` +
      `EFFICIENCY: ${r.turns.toFixed(1)} total turns across ${r.total} tasks ` +
      `(${r.toolCalls.toFixed(1)} tool calls). Reduce turns without losing a single ` +
      `correct answer — batching independent calls into one turn is the main lever.`
    );
  }
  return [
    "Tasks that failed in at least one repetition:",
    ...r.failures.map((f) => `- ${f.id}: probes ${f.probes}\n  answer began: "${f.answer.replace(/\s+/g, " ").slice(0, 200)}"`),
  ].join("\n");
}

async function propose(current: string, result: BenchResult, history: string[]): Promise<string | undefined> {
  const res = await callModel({
    model: PROPOSER,
    system: [
      "You improve the operating instructions given to a tool-using AI agent.",
      "",
      "You will receive the current instruction block, how it scored on a fixed",
      "benchmark, and what went wrong. Produce a REVISED block.",
      "",
      "Hard requirements:",
      "- Output ONLY the revised markdown block. No preamble, no code fences, no commentary.",
      "- Keep the `## Working with your {toolCount} tool(s)` heading and the literal",
      "  `{toolCount}` placeholder — it is substituted at runtime.",
      "- Stay under 220 words. This block is prepended to EVERY agent call, so length",
      "  is a permanent tax on every run.",
      "- Give operating guidance only. Do NOT give the agent an identity or persona,",
      "  and do not mention specific benchmark tasks — it must generalise.",
      "- Make a focused, motivated change addressing the reported weakness. Do not",
      "  rewrite wholesale for its own sake.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          "## Current instruction block",
          "",
          current,
          "",
          "## Benchmark result",
          "",
          summarise(result),
          "",
          feedback(result),
          history.length > 0 ? `\n## Already tried and rejected (do not repeat)\n\n${history.join("\n")}` : "",
        ].join("\n"),
      },
    ],
  });

  if (res.error || !res.text.trim()) return undefined;
  // Strip a stray fence if the model added one despite instructions.
  return res.text.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/, "").trim();
}

function log(entry: Record<string, unknown>): void {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
}

// -----------------------------------------------------------------------------
mkdirSync(PROMPTS, { recursive: true });
const baselineFile = join(PROMPTS, "baseline.md");
const bestFile = join(PROMPTS, "best.md");

if (!existsSync(baselineFile)) {
  console.error("missing bench/prompts/baseline.md — extract the built-in block first");
  process.exit(1);
}

let bestPrompt = readFileSync(baselineFile, "utf8");
console.log(c.bold(`\nbaseline`) + c.dim(`  ${REPEAT} sweeps × ${bestPrompt.split("\n").length} lines`));

let best = await bench(baselineFile, REPEAT);
console.log(`  ${summarise(best)} ${c.dim(`spread ${best.spread}`)}`);
log({ event: "baseline", ...{ score: best.score, objective: best.objective, turns: best.turns, spread: best.spread } });

const rejected: string[] = [];
let accepted = 0;

for (let i = 1; i <= ITERATIONS; i++) {
  console.log(c.bold(`\niteration ${i}/${ITERATIONS}`));

  const candidate = await propose(bestPrompt, best, rejected);
  if (!candidate) {
    console.log(c.dim("  proposer returned nothing — skipping"));
    continue;
  }

  const candidateFile = join(PROMPTS, `candidate-${i}.md`);
  writeFileSync(candidateFile, candidate, "utf8");

  const result = await bench(candidateFile, REPEAT);
  const delta = result.objective - best.objective;
  const verdict = delta > THRESHOLD ? "accept" : "revert";

  console.log(
    `  ${summarise(result)} ${c.dim(`Δ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`)} ` +
      (verdict === "accept" ? c.green("KEEP") : c.red("revert")),
  );

  log({
    event: verdict,
    iteration: i,
    score: result.score,
    objective: result.objective,
    turns: result.turns,
    delta,
    threshold: THRESHOLD,
    prompt: candidate,
  });

  if (verdict === "accept") {
    bestPrompt = candidate;
    best = result;
    accepted++;
    writeFileSync(bestFile, candidate, "utf8");
    rejected.length = 0; // a new incumbent invalidates the old rejection list
  } else {
    // Give the proposer a one-line memory so it stops re-suggesting this.
    rejected.push(`- (Δ${delta.toFixed(0)}) ${candidate.split("\n").find((l) => l.startsWith("-"))?.slice(0, 110) ?? "variant"}`);
  }
}

console.log(c.bold(`\ndone`) + ` — ${accepted} accepted of ${ITERATIONS}`);
console.log(`  final: ${summarise(best)}`);
if (accepted > 0) {
  console.log(c.green(`  winner written to bench/prompts/best.md`));
  console.log(c.dim(`  promote it: cp bench/prompts/best.md over the block in src/runtimes/agent.ts`));
} else {
  console.log(c.dim(`  baseline held — nothing beat it by more than ${THRESHOLD} objective`));
}
console.log(c.dim(`  audit trail: bench/log.jsonl\n`));
process.exit(0);
