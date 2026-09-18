#!/usr/bin/env node
/**
 * summarize — what a pile of run.json files says, in one screen.
 *
 * One run tells you what happened once. Tuning a gate or a threshold needs the
 * shape across many: how often each edge is taken, how confident each question
 * usually is, how often a gate fires, where runs fail and what they cost. This
 * reads run documents only (plain JSON), so it needs no library and no key.
 *
 * Usage
 *   node summarize.mts [path ...]     files or directories (default .ensemble/runs)
 *     --runner <name>                 only runs of this runner
 *     --graph <sha256:…>              only runs of this exact graph version
 *     --low <0..1>                    list decisions under this confidence (default 0.6)
 *     --json                          machine-readable output
 */
import { parseArgs } from "node:util";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface StepAnswer { type: string; value: string | number; confidence?: number }
interface Step {
  node: string; kind: string; ms: number; cost: number; took: string | null; error?: string;
  answers?: Record<string, StepAnswer>;
  gate?: { on: string; passed: boolean; min: number; measured: number };
}
interface RunDoc {
  run: { id: string; runner: string; graph: string; goal: string; status: string; cost: { total: number } };
  steps: Step[];
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    runner: { type: "string" },
    graph: { type: "string" },
    low: { type: "string", default: "0.6" },
    json: { type: "boolean", default: false },
  },
});

function collect(path: string, out: string[]): void {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) collect(join(path, entry), out);
  } else if (path.endsWith(".json") && !path.endsWith("graph.json")) {
    out.push(path);
  }
}

const files: string[] = [];
for (const path of positionals.length ? positionals : [".ensemble/runs"]) collect(path, files);

const runs: RunDoc[] = [];
for (const file of files) {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as RunDoc;
    if (!doc.run || !Array.isArray(doc.steps)) continue;
    if (values.runner && doc.run.runner !== values.runner) continue;
    if (values.graph && doc.run.graph !== values.graph) continue;
    runs.push(doc);
  } catch {
    /* not a run document */
  }
}

if (runs.length === 0) {
  process.stderr.write(`no run.json found in ${positionals.join(", ") || ".ensemble/runs"}\n`);
  process.exit(1);
}

const count = <K extends string>(xs: K[]) =>
  xs.reduce<Record<string, number>>((acc, x) => ((acc[x] = (acc[x] ?? 0) + 1), acc), {});
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`;
const low = Number(values.low);

const steps = runs.flatMap((r) => r.steps.map((s) => ({ run: r.run, step: s })));
const status = count(runs.map((r) => r.run.status));
const graphs = count(runs.map((r) => `${r.run.runner} ${r.run.graph}`));
const edges = count(steps.map(({ step }) => step.took ?? "(exit)"));
const paths = count(runs.map((r) => r.steps.map((s) => s.node).join(" → ")));
const costs = runs.map((r) => r.run.cost.total);

// Per question: value distribution and confidence. Prefixed by runner when
// several are mixed, because two runners can both have a classify.team.
const mixed = new Set(runs.map((r) => r.run.runner)).size > 1;
const qname = (runner: string, node: string, key: string) => `${mixed ? `${runner}:` : ""}${node}.${key}`;
const questions: Record<string, { values: Record<string, number>; confidence: number[]; numeric: number[] }> = {};
const lowOnes: Array<{ run: string; goal: string; q: string; value: unknown; confidence: number }> = [];
for (const { run, step } of steps) {
  for (const [key, answer] of Object.entries(step.answers ?? {})) {
    const q = (questions[qname(run.runner, step.node, key)] ??= { values: {}, confidence: [], numeric: [] });
    if (typeof answer.value === "number") q.numeric.push(answer.value);
    else q.values[answer.value] = (q.values[answer.value] ?? 0) + 1;
    // A noul's value IS its certainty: distance from 0.5, scaled to 0..1.
    const confidence = answer.confidence ?? (answer.type === "noul" ? Math.abs(Number(answer.value) - 0.5) * 2 : 1);
    q.confidence.push(confidence);
    if (confidence < low) lowOnes.push({ run: run.id, goal: run.goal, q: qname(run.runner, step.node, key), value: answer.value, confidence });
  }
}

const gates = steps.filter(({ step }) => step.gate);
const gateStats = Object.entries(
  gates.reduce<Record<string, { fired: number; total: number; measured: number[] }>>((acc, { step }) => {
    const g = (acc[`${step.node} on ${step.gate!.on} ≥ ${step.gate!.min}`] ??= { fired: 0, total: 0, measured: [] });
    g.total++;
    if (!step.gate!.passed) g.fired++;
    g.measured.push(step.gate!.measured);
    return acc;
  }, {}),
);
const failures = steps.filter(({ step }) => step.error).map(({ run, step }) => ({ run: run.id, node: step.node, error: step.error }));
const slow = Object.entries(
  steps.reduce<Record<string, number[]>>((acc, { step }) => ((acc[step.node] ??= []).push(step.ms), acc), {}),
).map(([node, ms]) => ({ node, meanMs: Math.round(mean(ms)), n: ms.length }));

if (values.json) {
  process.stdout.write(
    `${JSON.stringify({ runs: runs.length, status, graphs, edges, paths, cost: { total: costs.reduce((a, b) => a + b, 0), mean: mean(costs), max: Math.max(...costs) }, questions, gates: Object.fromEntries(gateStats), lowConfidence: lowOnes, failures, timing: slow }, null, 2)}\n`,
  );
  process.exit(0);
}

const out: string[] = [];
out.push(`${runs.length} runs · ${Object.entries(status).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
if (Object.keys(graphs).length > 1) {
  out.push(`  ⚠ ${Object.keys(graphs).length} graph versions mixed. Filter with --graph to compare like with like`);
}
out.push(`cost  total $${costs.reduce((a, b) => a + b, 0).toFixed(5)} · mean $${mean(costs).toFixed(5)} · max $${Math.max(...costs).toFixed(5)}`);

out.push("\npaths");
for (const [path, n] of Object.entries(paths).sort((a, b) => b[1] - a[1]).slice(0, 10)) out.push(`  ${pct(n, runs.length).padStart(4)}  ${path}`);

out.push("\nedges taken (join to graph.json edges[].id)");
out.push(`  ${Object.entries(edges).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}×${n}`).join("  ")}`);

out.push("\nquestions");
for (const [name, q] of Object.entries(questions)) {
  const dist = q.numeric.length
    ? `mean ${mean(q.numeric).toFixed(2)} · min ${Math.min(...q.numeric).toFixed(2)} · max ${Math.max(...q.numeric).toFixed(2)}`
    : Object.entries(q.values).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(" · ");
  const under = q.confidence.filter((c) => c < low).length;
  out.push(`  ${name.padEnd(28)} ${dist}   conf ${mean(q.confidence).toFixed(2)}${under ? `  (${under} under ${low})` : ""}`);
}

if (gateStats.length) {
  out.push("\ngates");
  for (const [gate, g] of gateStats) {
    out.push(`  ${gate.padEnd(34)} fired ${g.fired}/${g.total} (${pct(g.fired, g.total)}) · measured mean ${mean(g.measured).toFixed(2)}`);
  }
}

if (lowOnes.length) {
  out.push(`\nleast confident (< ${low})`);
  for (const l of lowOnes.sort((a, b) => a.confidence - b.confidence).slice(0, 10)) {
    out.push(`  ${l.confidence.toFixed(2)}  ${l.q}=${String(l.value)}  ${l.run}  "${l.goal.slice(0, 60)}"`);
  }
}

if (failures.length) {
  out.push("\nfailures");
  for (const f of failures.slice(0, 10)) out.push(`  ${f.run}  ${f.node}: ${String(f.error).slice(0, 120)}`);
}

out.push("\nslowest nodes");
for (const s of slow.sort((a, b) => b.meanMs - a.meanMs).slice(0, 5)) out.push(`  ${s.node.padEnd(20)} ${s.meanMs}ms mean over ${s.n}`);

process.stdout.write(`${out.join("\n")}\n`);
