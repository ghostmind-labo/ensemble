/**
 * Scores one candidate agent prompt against the benchmark.
 *
 * Calls `callAgent` directly rather than going through a scene: the thing under
 * test is the agent scaffolding, and a scene would add its own prompt and
 * output contract on top — noise in the measurement.
 *
 *   node bench/run.mts                 # score the built-in prompt (baseline)
 *   node bench/run.mts prompt.md       # score a candidate
 *   node bench/run.mts prompt.md --json
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callAgent } from "../src/runtimes/agent.ts";
import { BUILTIN_NAMES } from "../src/tools/builtin.ts";
import { TASKS, type Task } from "./tasks.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "fixture");

export interface TaskResult {
  id: string;
  pass: boolean;
  turns: number;
  toolCalls: number;
  cost: number;
  ms: number;
  answer: string;
  probes: string;
}

export interface BenchResult {
  score: number;
  total: number;
  /**
   * The optimiser's objective. Correctness dominates (100 each) and efficiency
   * breaks ties (-1 per turn). A prompt that is right in fewer turns wins; a
   * prompt that trades a correct answer for speed always loses.
   */
  objective: number;
  cost: number;
  turns: number;
  toolCalls: number;
  ms: number;
  /** max-min score across repetitions — the noise floor. */
  spread: number;
  runs: number;
  results: TaskResult[];
  failures: TaskResult[];
}

const MODEL = process.env["BENCH_MODEL"] ?? "openrouter/anthropic/claude-haiku-4.5";

async function runTask(task: Task, promptFile: string | undefined): Promise<TaskResult> {
  // The override is read inside callAgent via env, so set it per call.
  if (promptFile) process.env["ENSEMBLE_AGENT_PROMPT"] = promptFile;
  else delete process.env["ENSEMBLE_AGENT_PROMPT"];

  const started = Date.now();
  let toolCalls = 0;

  const res = await callAgent({
    model: MODEL,
    // Intentionally minimal: the scaffolding under test must carry the weight.
    system: "Answer the user's question about this project.",
    messages: [{ role: "user", content: task.goal }],
    mcp: [],
    builtins: BUILTIN_NAMES,
    skills: [],
    hub: undefined,
    root: FIXTURE,
    maxTurns: 10,
    onToolCall: () => {
      toolCalls++;
    },
  });

  const answer = (res.text ?? "").toLowerCase();
  return {
    id: task.id,
    pass: !res.error && task.check(answer),
    turns: res.turns,
    toolCalls,
    cost: res.cost,
    ms: Date.now() - started,
    answer: (res.text ?? res.error ?? "").slice(0, 400),
    probes: task.probes,
  };
}

/**
 * Runs the suite `repeat` times and averages.
 *
 * Single runs are noisy — the same prompt has scored 9/12 and 12/12 on
 * consecutive sweeps. An optimiser comparing single runs would happily "accept"
 * pure luck, so every measurement here is an average and the accept rule
 * (optimize.mts) requires the gain to clear the measured noise floor.
 */
export async function bench(promptFile?: string, repeat = 1): Promise<BenchResult> {
  if (repeat > 1) {
    const runs: BenchResult[] = [];
    for (let i = 0; i < repeat; i++) runs.push(await bench(promptFile, 1));
    const avg = (f: (r: BenchResult) => number): number => runs.reduce((n, r) => n + f(r), 0) / runs.length;
    const scores = runs.map((r) => r.score);
    return {
      score: avg((r) => r.score),
      total: runs[0]!.total,
      objective: avg((r) => r.objective),
      cost: runs.reduce((n, r) => n + r.cost, 0),
      turns: avg((r) => r.turns),
      toolCalls: avg((r) => r.toolCalls),
      ms: avg((r) => r.ms),
      spread: Math.max(...scores) - Math.min(...scores),
      runs: repeat,
      results: runs[0]!.results,
      // A task that failed in ANY repetition is worth showing the optimiser.
      failures: runs.flatMap((r) => r.failures).filter((f, i, all) => all.findIndex((x) => x.id === f.id) === i),
    };
  }

  // Tasks are independent — run them concurrently so a full sweep is ~1 task long.
  const results = await Promise.all(TASKS.map((t) => runTask(t, promptFile)));
  const sum = (f: (r: TaskResult) => number): number => results.reduce((n, r) => n + f(r), 0);

  const passed = results.filter((r) => r.pass).length;
  return {
    score: passed,
    total: results.length,
    objective: passed * 100 - sum((r) => r.turns),
    cost: sum((r) => r.cost),
    turns: sum((r) => r.turns),
    toolCalls: sum((r) => r.toolCalls),
    ms: Math.max(...results.map((r) => r.ms)),
    spread: 0,
    runs: 1,
    results,
    failures: results.filter((r) => !r.pass),
  };
}

// --- CLI ---------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("run.mts")) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const asJson = process.argv.includes("--json");
  const promptFile = args[0] ? resolve(args[0]) : undefined;

  const repeatArg = process.argv.find((a) => a.startsWith("--repeat="));
  const repeat = repeatArg ? Number(repeatArg.split("=")[1]) : 1;
  const result = await bench(promptFile, repeat);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nprompt: ${promptFile ?? "(built-in)"}  model: ${MODEL}\n`);
    for (const r of result.results) {
      const mark = r.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      console.log(
        `${mark} ${r.id.padEnd(14)} ${String(r.turns).padStart(2)} turns · ` +
          `${String(r.toolCalls).padStart(2)} tools · $${r.cost.toFixed(4)}`,
      );
      if (!r.pass) console.log(`    \x1b[2m${r.probes}\x1b[0m\n    \x1b[2m→ ${r.answer.replace(/\s+/g, " ").slice(0, 160)}\x1b[0m`);
    }
    console.log(
      `\nscore ${result.score.toFixed(2)}/${result.total} · ${result.turns.toFixed(1)} turns · ` +
        `${result.toolCalls.toFixed(1)} tool calls · $${result.cost.toFixed(4)} · ` +
        `objective ${result.objective.toFixed(1)}` +
        (result.runs > 1 ? ` · ${result.runs} runs, spread ${result.spread}` : "") + `\n`,
    );
  }
  process.exit(0);
}
