#!/usr/bin/env node
/**
 * dryrun — execute a runner end to end without spending anything.
 *
 * `ensemble validate` proves the graph's SHAPE, but some bugs only show when a
 * runner actually runs: a code node returning `{ rounds: n }` for
 * `writes: ["rounds"]` nests as `rounds.rounds`, a handler throws on a missing
 * key, a loop never exits. So an agent building a runner needs to *run* it, and
 * needs to do that before anyone pays for a real run.
 *
 * This swaps every paid seam for a stub:
 *   · decide nodes → scripted answers (default: first option, noul 0.1, score mid,
 *                    confidence 0.9 — so a gate passes unless you say otherwise)
 *   · model nodes  → "[dry <model>] <first 400 chars of the prompt>" (and a
 *                    1×1 image when the node draws)
 *   · mcp nodes    → a placeholder text, no server is started
 *   · work nodes   → YOUR handlers run for real, unless --stub-work
 *
 * It only imports the runner file, and the runner brings its own copy of
 * ensemble, so this script has no dependency on where the library is installed.
 *
 * Usage
 *   node dryrun.mts <runner.mts> [goal] [options]
 *
 *   --answer node.key=value   force an answer (repeatable). value is an option
 *                             name for a choice, a number for noul/score.
 *                             Append @conf to set confidence: team=orders@0.3
 *   --input k=v               seed a state key (repeatable)
 *   --explore                 run once per declared answer (every choice option,
 *                             noul low/high, score bottom/top, every gate
 *                             tripped) and report the path each took, then list
 *                             the edges no run ever took
 *   --stub-work               replace work handlers with placeholders too
 *   --json                    print the run document(s) to stdout
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type State = Record<string, unknown>;
type Question =
  | { type: "choice"; criteria: Record<string, unknown> }
  | { type: "score"; criteria: unknown[] }
  | { type: "noul" };
type AnyNode = Record<string, unknown> & { decide?: Record<string, Question>; writes?: string[] };
interface Step {
  n: number;
  node: string;
  kind: string;
  took: string | null;
  forked?: string[];
  error?: string;
  writes?: State;
  answers?: Record<string, { value: unknown }>;
}
interface RunDoc {
  run: { status: string };
  steps: Step[];
  state: State;
}
interface Runner {
  (inputs?: State, options?: Record<string, unknown>): Promise<{ result: unknown; run: RunDoc }>;
  spec: { name: string; nodes: Record<string, AnyNode>; edges?: Array<{ from: string; to: string }> };
  validate(): string[];
}

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    answer: { type: "string", multiple: true },
    input: { type: "string", multiple: true },
    explore: { type: "boolean", default: false },
    "stub-work": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

const [file, ...goalWords] = positionals;
if (!file) {
  process.stderr.write("usage: node dryrun.mts <runner.mts> [goal] [--answer node.key=value] [--explore]\n");
  process.exit(2);
}

// The stubs above only reach THIS runner. A handler that calls another runner,
// or the user's own client, would still reach the paid APIs, so they are refused
// at the network. Reading OpenRouter's model list is free and stays allowed,
// because a code node may shortlist from it.
const PAID = [/(^|\.)typesafe\.ai$/, /(^|\.)openrouter\.ai$/];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const freeCatalogue = method === "GET" && url.pathname.endsWith("/models");
  if (PAID.some((host) => host.test(url.hostname)) && !freeCatalogue) {
    throw new Error(
      `dryrun blocked a paid call to ${url.hostname}${url.pathname}. Something outside this runner's ` +
        `stubs (a composed runner, or the handler's own client) is calling out. Re-run with --stub-work.`,
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

const mod = (await import(pathToFileURL(resolve(file)).href)) as { default?: Runner };
const runner = mod.default;
if (typeof runner !== "function" || !runner.spec) {
  process.stderr.write(`${file} does not default-export a runner()\n`);
  process.exit(2);
}

const problems = runner.validate();
if (problems.length) {
  process.stderr.write(`✗ ${runner.spec.name} does not validate — fix these first:\n`);
  for (const p of problems) process.stderr.write(`  · ${p}\n`);
  process.exit(1);
}

const pairs = (list: string[] | undefined, what: string): Array<[string, string]> =>
  (list ?? []).map((pair) => {
    const at = pair.indexOf("=");
    if (at === -1) {
      process.stderr.write(`--${what} needs key=value, got "${pair}"\n`);
      process.exit(2);
    }
    return [pair.slice(0, at), pair.slice(at + 1)];
  });

const inputs: State = Object.fromEntries(pairs(values.input, "input"));
const goal = goalWords.join(" ") || String(inputs["goal"] ?? "dry run");
inputs["goal"] = goal;
const forcedBase = new Map(pairs(values.answer, "answer"));

/* ── stub the paid seams in place ── */
// The runner's callable closes over this same spec object, so replacing a node
// here is what the run sees. This process is throwaway; nothing is written back.
for (const [name, node] of Object.entries(runner.spec.nodes)) {
  const writes = node.writes ?? [];
  if ("mcp" in node) {
    const { server, tool } = node.mcp as { server: string; tool: unknown };
    const label = `[dry mcp ${server}/${typeof tool === "string" ? tool : "{from}"}]`;
    runner.spec.nodes[name] = {
      code: () => (writes.length > 1 ? { [writes[0]!]: label, [writes[1]!]: {} } : label),
      reads: (node.reads as string[]) ?? [],
      writes,
    };
  } else if ("work" in node && values["stub-work"]) {
    runner.spec.nodes[name] = {
      code: () =>
        writes.length > 1
          ? Object.fromEntries(writes.map((k) => [k, `[dry work ${String(node.work)} → ${k}]`]))
          : `[dry work ${String(node.work)}]`,
      reads: (node.reads as string[]) ?? [],
      writes,
    };
  }
}

const nodeOf = (questions: unknown): string =>
  Object.entries(runner.spec.nodes).find(([, n]) => n.decide === questions)?.[0] ?? "?";

function answerFor(node: string, key: string, q: Question, forced: Map<string, string>) {
  const raw = forced.get(`${node}.${key}`);
  const [want, conf] = raw === undefined ? [undefined, undefined] : raw.split("@");
  const confidence = conf !== undefined ? Number(conf) : 0.9;
  if (q.type === "choice") {
    const options = Object.keys(q.criteria);
    const choice = want || options[0]!;
    if (!options.includes(choice)) {
      process.stderr.write(`--answer ${node}.${key}=${choice}: not an option. Declared: ${options.join(", ")}\n`);
      process.exit(2);
    }
    const rest = (1 - confidence) / (options.length - 1);
    const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? Math.max(confidence, rest) : rest]));
    return { type: "choice", choice, confidence, probabilities };
  }
  if (q.type === "score") {
    const levels = q.criteria.length;
    const score = want ? Number(want) : (levels - 1) / 2;
    return { type: "score", score, confidence, probabilities: {}, legend: {} };
  }
  return { type: "noul", noul: want ? Number(want) : 0.1 };
}

const decider = (forced: Map<string, string>) => async (_state: unknown, questions: Record<string, Question>) => {
  const node = nodeOf(questions);
  const answers = Object.fromEntries(
    Object.entries(questions).map(([key, q]) => [key, answerFor(node, key, q, forced)]),
  );
  return { model: "dry-run", answers, usage: { input_tokens: 0, output_tokens: 0 }, cost: 0 };
};

const caller = async (request: { model: string; prompt: string }) => ({
  model: request.model,
  // Echo the prompt (up to 400 chars) so a dry run shows what the model would
  // have been told, which is how a missing key in a prompt shows up.
  text: `[dry ${request.model}] ${request.prompt.slice(0, 400)}`,
  images: [PIXEL],
  cost: 0,
  usage: { prompt_tokens: 0, completion_tokens: 0 },
});

async function once(forced: Map<string, string>, label: string) {
  try {
    const { result, run } = await runner({ ...inputs }, { decider: decider(forced), caller, maxSteps: 50 });
    return { label, run, result, error: undefined as string | undefined };
  } catch (error) {
    const partial = (error as { run?: RunDoc }).run;
    return { label, run: partial, result: undefined, error: (error as Error).message };
  }
}

const path = (run: RunDoc | undefined): string =>
  run ? run.steps.map((s) => s.node).join(" → ") : "(no steps)";

const cases: Array<[string, Map<string, string>]> = [["default", forcedBase]];
if (values.explore) {
  for (const [name, node] of Object.entries(runner.spec.nodes)) {
    const gate = node["gate"] as { on: string; min: number; to: string } | undefined;
    if (gate) cases.push([`${name} gate tripped`, new Map([...forcedBase, [`${name}.${gate.on}`, "@0"]])]);
    for (const [key, q] of Object.entries(node.decide ?? {})) {
      if (q.type === "choice") {
        for (const option of Object.keys(q.criteria)) {
          cases.push([`${name}.${key}=${option}`, new Map([...forcedBase, [`${name}.${key}`, option]])]);
        }
      } else if (q.type === "noul") {
        for (const v of ["0.1", "0.9"]) cases.push([`${name}.${key}=${v}`, new Map([...forcedBase, [`${name}.${key}`, v]])]);
      } else {
        const top = String(q.criteria.length - 1);
        for (const v of ["0", top]) cases.push([`${name}.${key}=${v}`, new Map([...forcedBase, [`${name}.${key}`, v]])]);
      }
    }
  }
}

let failed = 0;
const outcomes = [];
for (const [label, forced] of cases) {
  const outcome = await once(forced, label);
  outcomes.push(outcome);
  const status = outcome.error ? "✗" : outcome.run?.run.status === "completed" ? "✓" : "✗";
  if (status === "✗") failed++;
  process.stderr.write(`${status} ${label.padEnd(36)} ${path(outcome.run)}\n`);
  if (outcome.error) process.stderr.write(`    ${outcome.error.split("\n")[0]}\n`);
  else if (!values.explore) {
    for (const step of outcome.run?.steps ?? []) {
      if (step.writes && Object.keys(step.writes).length) {
        process.stderr.write(`    ${step.node} wrote ${JSON.stringify(step.writes).slice(0, 160)}\n`);
      }
    }
    process.stderr.write(`    result: ${JSON.stringify(outcome.result)?.slice(0, 200)}\n`);
  }
}

// Which declared edges did no dry run take? With --explore, an edge left over
// is either dead wiring or guarded by a when() the stub answers never tripped.
const taken = new Set(outcomes.flatMap((o) => o.run?.steps.flatMap((s) => [s.took, ...(s.forked ?? [])]) ?? []));
const idle = (runner.spec.edges ?? [])
  .map((edge, i) => ({ id: `e${i}`, edge }))
  .filter(({ id }) => !taken.has(id));
if (idle.length) {
  process.stderr.write(
    `  edges never taken: ${idle.map(({ id, edge }) => `${id} (${edge.from}→${edge.to})`).join(", ")}\n` +
      (values.explore ? "" : "  run with --explore to try every declared answer\n"),
  );
}

if (values.json) process.stdout.write(`${JSON.stringify(outcomes.map((o) => o.run), null, 2)}\n`);
process.stderr.write(
  `${failed ? "✗" : "✓"} ${runner.spec.name}: ${cases.length - failed}/${cases.length} dry run${cases.length === 1 ? "" : "s"} completed · $0\n`,
);
process.exit(failed ? 1 : 0);
