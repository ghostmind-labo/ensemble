#!/usr/bin/env node
/**
 * The CLI — the development loop, not the product.
 *
 * The product is the library: a runner belongs inside your server, called as an
 * ordinary function. What you want from a terminal is narrower — prove a graph,
 * emit it, run it once to see what happens, and score its decisions against
 * cases someone labelled. validate and graph are free and offline.
 *
 * Everything that is data goes to stdout so it can be piped; everything that is
 * commentary goes to stderr. `ensemble graph x.mts | jq` is the point.
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRunner, type Runner } from "./runner.ts";
import { ResumeError, RunFailed, RunnerError, type Human, type HumanAnswer, type Paused, type RunOutcome } from "./execute.ts";
import type { GraphQuestion } from "./graph.ts";
import { calibrate, CalibrationError, type Calibration, type Case, type QuestionReport } from "./calibrate.ts";
import { money, reporter } from "./report.ts";
import { loadSkills, validateSkill } from "./skills.ts";
import { describeServer, isRunnable, missingEnv, preflight, searchServers, searchSkills } from "./registry.ts";

const version = (): string => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const path of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
      try {
        return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
      } catch {
        /* try the next one */
      }
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
};

const USAGE = `ensemble ${version()} — typed decisions, wired to your code

Usage
  ensemble validate <file>          Prove the graph. Free, offline.
  ensemble graph <file>             Emit graph.json to stdout. Free, offline.
  ensemble run <file> [goal]        Run it once; writes run.json. At a terminal, a
                                    by: "human" node asks you; otherwise the run
                                    pauses, writes paused.json, and exits 3.
  ensemble resume <file> <paused>   Continue a paused run: --answer key=value per
                                    question, or answer at the terminal.
  ensemble calibrate <file> <cases> Score its decisions against labelled cases
                                    (.jsonl or a .json array). ~$0.00002 a case.
                                    --holdout <file> scores a second, frozen set
                                    separately and reports the gap.
  ensemble check <file>             Can it run HERE? Model capabilities, keys,
                                    MCP servers. Reads the live catalogue.
  ensemble skills [query]           Skills visible here — and what to fix.
  ensemble servers [query]          MCP servers in the official registry, and
                                    which environment variables each still needs.
  ensemble version

Options
  -o, --out <path>   graph: write here instead of stdout
                     run:   write run.json here instead of .ensemble/runs/<id>/
      --json         run: print run.json to stdout instead of writing a file
                     calibrate: print the report as JSON
      --input k=v    run: seed a state key (repeatable)
      --remote       skills: search the public index instead of this machine
      --budget <usd> run, calibrate: stop once it costs more than this
      --max-steps <n> run: cap node executions (default 50)

The file must default-export a runner(). Scenes are .mts, loaded by Node's own
type stripping — Node 22.18 or newer.

  OPENROUTER_API_KEY the one key: Jev decides and models write through it.
                     Required by 'run' and 'calibrate'; 'validate' and 'graph'
                     never call out.
`;

const die = (message: string): never => {
  process.stderr.write(`ensemble: ${message}\n`);
  process.exit(1);
};

async function load(path: string | undefined): Promise<Runner> {
  if (!path) die("no file given — ensemble <command> <file.mts>");
  const full = resolve(path!);
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(full).href)) as { default?: unknown };
  } catch (error) {
    return die(`could not load ${path}: ${(error as Error).message}`);
  }
  if (!isRunner(module.default)) {
    return die(`${path} does not default-export a runner() — add \`export default runner({ … })\``);
  }
  return module.default;
}

function report(problems: string[], name: string): void {
  if (problems.length === 0) {
    process.stderr.write(`✓ ${name} is sound\n`);
    return;
  }
  process.stderr.write(`✗ ${name} — ${problems.length} problem${problems.length === 1 ? "" : "s"}\n`);
  for (const problem of problems) process.stderr.write(`  · ${problem}\n`);
  process.exit(1);
}

const pct = (n: number | null): string => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);

/** A description, as graph.json normalises it, down to one readable line. */
const said = (d: unknown): string => {
  if (!d || typeof d !== "object") return "";
  const what = (d as { what?: unknown }).what;
  return typeof what === "string" ? ` — ${what}` : "";
};

/**
 * Ask the person at this terminal. The development loop's own `human`: the
 * library ships no prompt, but the CLI is where someone is actually sitting.
 */
const terminal = (): Human => async ({ node, questions, asked, comment }) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`\n  ${node} needs an answer from you. What it is looking at:\n`);
    for (const [key, value] of Object.entries(asked)) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      process.stderr.write(`    ${key}: ${String(text).slice(0, 400)}\n`);
    }
    const answers: HumanAnswer["answers"] = {};
    for (const q of questions) answers[q.key] = await askOne(rl, q);
    const note = comment ? (await rl.question(`  a note for "${comment}" (enter to skip): `)).trim() : "";
    process.stderr.write("\n");
    return { answers, by: process.env["USER"] ?? "terminal", ...(note ? { comment: note } : {}) };
  } finally {
    rl.close();
  }
};

async function askOne(rl: ReturnType<typeof createInterface>, q: GraphQuestion): Promise<string | number | boolean> {
  const text = typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
  process.stderr.write(`\n  ${q.key}: ${text}\n`);
  for (;;) {
    if (q.type === "choice") {
      const options = q.options ?? [];
      options.forEach((o, i) => process.stderr.write(`    ${i + 1}. ${o.name}${said(o.description)}\n`));
      const raw = (await rl.question(`  pick 1–${options.length}: `)).trim();
      const byNumber = options[Number(raw) - 1]?.name;
      const byName = options.find((o) => o.name === raw)?.name;
      if (byNumber ?? byName) return (byNumber ?? byName)!;
    } else if (q.type === "noul") {
      const raw = (await rl.question("  yes or no: ")).trim().toLowerCase();
      if (["y", "yes", "true"].includes(raw)) return true;
      if (["n", "no", "false"].includes(raw)) return false;
    } else {
      const levels = q.levels ?? [];
      levels.forEach((l) => process.stderr.write(`    ${l.value}. ${said(l.description).slice(3) || `level ${l.value}`}\n`));
      const raw = Number((await rl.question(`  level 0–${levels.length - 1}: `)).trim());
      if (Number.isInteger(raw) && raw >= 0 && raw < levels.length) return raw;
    }
    process.stderr.write("  that is not one of the answers — try again\n");
  }
}

function printCalibration(c: Calibration): void {
  process.stderr.write(`${c.runner} · ${c.cases} cases · ${c.asked} asked · ${money(c.cost)}${c.stopped ? ` · stopped: ${c.stopped}` : ""}\n`);
  printQuestions(c.questions, c.holdout ? "dev" : undefined);
  if (c.holdout) printQuestions(c.holdout, "holdout");
  for (const g of c.gap ?? []) {
    const verdict = g.drop >= 0.1 ? "  ← tuned to the dev cases" : g.drop <= -0.1 ? "  ← holdout is easier" : "";
    process.stderr.write(`\n  ${g.node}.${g.key}  dev ${pct(g.dev)} → holdout ${pct(g.holdout)} (${g.drop >= 0 ? "-" : "+"}${pct(Math.abs(g.drop))})${verdict}\n`);
  }
  process.stderr.write(`\n  gap is |confidence − accuracy|: near 0 means a gate can be trusted.\n`);
}

function printQuestions(questions: QuestionReport[], set?: string): void {
  if (set) process.stderr.write(`\n${set.toUpperCase()}\n`);
  for (const q of questions) {
    const extra = q.brier !== undefined ? ` · brier ${q.brier}` : q.meanError !== undefined ? ` · off by ${q.meanError}` : "";
    process.stderr.write(
      `\n  ${q.node}.${q.key}  ${q.type} · n=${q.n} · right ${pct(q.accuracy)} · confidence ${q.confidence.toFixed(2)} · gap ${q.gap.toFixed(3)}${extra}\n`,
    );
    for (const gate of q.gates ?? []) {
      process.stderr.write(`    gate min ${gate.min.toFixed(1)} → keeps ${pct(gate.keeps)}, ${pct(gate.accuracy)} of those right\n`);
    }
    for (const miss of q.misses.slice(0, 10)) {
      process.stderr.write(`    miss case ${miss.case}: expected ${miss.expected}, got ${miss.got} @ ${miss.confidence}\n`);
    }
    if (q.misses.length > 10) process.stderr.write(`    … ${q.misses.length - 10} more misses (--json for all)\n`);
  }
}

/**
 * Write what a run left behind and set the exit code. A pause is not a failure,
 * but a script that expected an answer must notice: it exits 3, next to a
 * paused.json that `ensemble resume` takes.
 */
function finishRun(runner: Runner, outcome: RunOutcome, file: string, flags: { out?: string; json?: boolean }): void {
  const { run, paused } = outcome;
  const json = `${JSON.stringify(run, null, 2)}\n`;
  const out = flags.out;
  if (flags.json) {
    // The snapshot goes out WITH the record, because `run.pending` alone cannot
    // be resumed — it has no state, steps, loop budgets or spend. Printing the
    // record on its own would hand back a run that says it is waiting for a
    // person and give nobody any way to answer.
    process.stdout.write(paused ? `${JSON.stringify({ run, paused }, null, 2)}\n` : json);
  } else {
    const dir = out ? dirname(resolve(out)) : resolve(".ensemble", "runs", run.run.id);
    const path = out ? resolve(out) : join(dir, "run.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, json, "utf8");
    writeFileSync(join(dirname(path), "graph.json"), `${JSON.stringify(runner.graph(), null, 2)}\n`, "utf8");
    process.stderr.write(`  ${path}\n`);
    if (paused) {
      const saved = join(dirname(path), "paused.json");
      writeFileSync(saved, `${JSON.stringify(paused, null, 2)}\n`, "utf8");
      const hint = paused.pending.questions.map((q) => `--answer ${q.key}=…`).join(" ");
      process.stderr.write(`  ⏸ waiting for a person at "${paused.node}" — ${saved}\n`);
      process.stderr.write(`    npx ensemble resume ${file} ${saved} ${hint}\n`);
    }
  }
  if (paused) process.exit(3);
  if (run.run.status !== "completed") process.exit(1);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "V", default: false },
      out: { type: "string", short: "o" },
      json: { type: "boolean", default: false },
      input: { type: "string", multiple: true },
      budget: { type: "string" },
      "max-steps": { type: "string" },
      holdout: { type: "string" },
      answer: { type: "string", multiple: true },
      comment: { type: "string" },
      by: { type: "string" },
      remote: { type: "boolean", default: false },
    },
  });

  const [command, file, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version || command === "version") {
    process.stdout.write(`${version()}\n`);
    return;
  }

  const num = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) die(`"${value}" is not a number`);
    return parsed;
  };

  switch (command) {
    case "validate": {
      const runner = await load(file);
      report(runner.validate(), runner.spec.name);
      return;
    }

    case "check": {
      const runner = await load(file);
      report(runner.validate(), runner.spec.name);

      const flight = await preflight(runner.spec);
      for (const entry of flight.env) {
        process.stderr.write(`  ${entry.set ? "✓" : "✗"} ${entry.name.padEnd(20)} ${entry.why}\n`);
      }
      for (const note of flight.notes) process.stderr.write(`  · ${note}\n`);
      if (flight.problems.length === 0) {
        process.stderr.write(`✓ ${runner.spec.name} can run here\n`);
        return;
      }
      process.stderr.write(`✗ ${runner.spec.name} cannot run here yet\n`);
      for (const problem of flight.problems) process.stderr.write(`  · ${problem}\n`);
      process.exit(1);
    }

    case "graph": {
      const runner = await load(file);
      const json = `${JSON.stringify(runner.graph(), null, 2)}\n`;
      if (values.out) {
        mkdirSync(dirname(resolve(values.out)), { recursive: true });
        writeFileSync(resolve(values.out), json, "utf8");
        process.stderr.write(`${values.out}\n`);
      } else {
        process.stdout.write(json);
      }
      return;
    }

    case "run": {
      const runner = await load(file);
      const problems = runner.validate();
      if (problems.length) report(problems, runner.spec.name);

      const inputs: Record<string, unknown> = {};
      for (const pair of values.input ?? []) {
        const at = pair.indexOf("=");
        if (at === -1) die(`--input needs key=value, got "${pair}"`);
        inputs[pair.slice(0, at)] = pair.slice(at + 1);
      }
      const goal = rest.join(" ");
      if (goal) inputs["goal"] = goal;

      process.stderr.write(`${runner.spec.name}${goal ? ` — ${goal}` : ""}\n`);

      const live = reporter();
      try {
        const outcome = await runner(inputs, {
          budget: num(values.budget),
          maxSteps: num(values["max-steps"]),
          onEvent: live,
          ...(process.stdin.isTTY && !values.json ? { human: terminal() } : {}),
        });
        finishRun(runner, outcome, file!, { out: values.out, json: values.json });
      } catch (error) {
        live.stop();
        if (error instanceof RunnerError) report(error.problems, runner.spec.name);
        if (error instanceof RunFailed) {
          process.stderr.write(`  ✗ ${error.message} · ${money(error.run.run.cost.total)}\n`);
          process.exit(1);
        }
        die((error as Error).message);
      }
      return;
    }

    case "resume": {
      const runner = await load(file);
      const pausedPath = rest[0];
      if (!pausedPath) die("no paused run given — ensemble resume <file.mts> <paused.json> [--answer key=value]");
      let paused: Paused;
      try {
        // Either a bare snapshot (what `run` writes as paused.json) or the
        // `{ run, paused }` envelope `run --json` prints, so a piped run can be
        // resumed from the file it was piped into without being unwrapped first.
        const read = JSON.parse(readFileSync(resolve(pausedPath!), "utf8")) as Paused | { paused?: Paused };
        paused = ("paused" in read && read.paused ? read.paused : read) as Paused;
      } catch (error) {
        return die(`could not read ${pausedPath}: ${(error as Error).message}`);
      }
      const given = values.answer ?? [];
      let answer: HumanAnswer;
      if (given.length) {
        const answers: HumanAnswer["answers"] = {};
        for (const pair of given) {
          const at = pair.indexOf("=");
          if (at === -1) die(`--answer needs key=value, got "${pair}"`);
          answers[pair.slice(0, at)] = pair.slice(at + 1);
        }
        answer = { answers, ...(values.comment ? { comment: values.comment } : {}), ...(values.by ? { by: values.by } : {}) };
      } else if (process.stdin.isTTY) {
        const p = paused.pending;
        answer = (await terminal()({ run: paused.run.id, node: p.node, questions: p.questions, asked: p.asked, ...(p.comment ? { comment: p.comment } : {}), signal: new AbortController().signal }))!;
      } else {
        return die(`nothing to answer with — pass --answer ${paused.pending?.questions.map((q) => `${q.key}=…`).join(" --answer ")}`);
      }

      process.stderr.write(`${runner.spec.name} — resuming at ${paused.node}\n`);
      const live = reporter();
      try {
        const outcome = await runner.resume(paused, answer, {
          budget: num(values.budget),
          maxSteps: num(values["max-steps"]),
          onEvent: live,
          ...(process.stdin.isTTY && !values.json ? { human: terminal() } : {}),
        });
        finishRun(runner, outcome, file!, { out: values.out, json: values.json });
      } catch (error) {
        live.stop();
        if (error instanceof ResumeError) die(error.message);
        if (error instanceof RunnerError) report(error.problems, runner.spec.name);
        if (error instanceof RunFailed) {
          process.stderr.write(`  ✗ ${error.message} · ${money(error.run.run.cost.total)}\n`);
          process.exit(1);
        }
        die((error as Error).message);
      }
      return;
    }

    case "calibrate": {
      const runner = await load(file);
      const problems = runner.validate();
      if (problems.length) report(problems, runner.spec.name);
      const casesPath = rest[0];
      if (!casesPath) die("no cases given — ensemble calibrate <file.mts> <cases.jsonl>");
      let cases: Case[];
      try {
        const raw = readFileSync(resolve(casesPath!), "utf8").trim();
        cases = raw.startsWith("[")
          ? (JSON.parse(raw) as Case[])
          : raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Case);
      } catch (error) {
        return die(`could not read ${casesPath}: ${(error as Error).message}`);
      }
      if (values.holdout) {
        try {
          const raw = readFileSync(resolve(values.holdout), "utf8").trim();
          const held: Case[] = raw.startsWith("[")
            ? (JSON.parse(raw) as Case[])
            : raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Case);
          cases = [...cases, ...held.map((test) => ({ ...test, set: "holdout" as const }))];
        } catch (error) {
          return die(`could not read ${values.holdout}: ${(error as Error).message}`);
        }
      }
      try {
        const calibration = await calibrate(runner, cases, { budget: num(values.budget) });
        if (values.json) process.stdout.write(`${JSON.stringify(calibration, null, 2)}\n`);
        else printCalibration(calibration);
      } catch (error) {
        if (error instanceof CalibrationError) {
          process.stderr.write(`✗ ${casesPath} — ${error.problems.length} problem${error.problems.length === 1 ? "" : "s"}, nothing was asked\n`);
          for (const problem of error.problems) process.stderr.write(`  · ${problem}\n`);
          process.exit(1);
        }
        die((error as Error).message);
      }
      return;
    }

    case "skills": {
      const query = [file, ...rest].filter(Boolean).join(" ").toLowerCase();

      if (values.remote) {
        const found = await searchSkills(query || "agent");
        if (found.length === 0) {
          process.stderr.write("no results — the public index is unofficial and may be unavailable\n");
          return;
        }
        for (const listing of found.slice(0, 40)) {
          const installs = listing.installs ? ` · ${listing.installs.toLocaleString()} installs` : "";
          process.stdout.write(`${listing.name.padEnd(28)} ${listing.source}${installs}\n  ${listing.url}\n`);
        }
        return;
      }

      const skills = loadSkills();
      const shown = query
        ? skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(query))
        : skills;
      if (shown.length === 0) {
        process.stderr.write(
          skills.length
            ? `no skill here matches "${query}" (${skills.length} loaded)\n`
            : "no skills found — look in .claude/skills, .ensemble/skills, or ~/.claude/skills\n",
        );
        return;
      }
      for (const skill of shown) {
        const problems = validateSkill(skill);
        const mark = problems.length ? "✗" : " ";
        process.stdout.write(`${mark} ${skill.name.padEnd(26)} ${skill.scope.padEnd(8)} ${skill.description.slice(0, 92)}\n`);
        for (const problem of problems) process.stderr.write(`    ↳ ${problem}\n`);
      }
      process.stderr.write(`\n${shown.length} of ${skills.length} skills\n`);
      return;
    }

    case "servers": {
      const query = [file, ...rest].filter(Boolean).join(" ");
      const servers = await searchServers(query || undefined, { limit: 60 });
      if (servers.length === 0) {
        process.stderr.write(`nothing in the registry matches "${query}"\n`);
        return;
      }
      let ready = 0;
      for (const entry of servers) {
        const missing = missingEnv(entry);
        if (isRunnable(entry)) ready++;
        process.stdout.write(`${describeServer(entry)}\n`);
        for (const variable of missing) {
          process.stdout.write(
            `    ${variable.name}${variable.isSecret ? " (secret)" : ""}` +
              `${variable.description ? ` — ${variable.description}` : ""}\n`,
          );
        }
        process.stdout.write("\n");
      }
      process.stderr.write(`${servers.length} servers · ${ready} runnable with the environment you have\n`);
      return;
    }

    default:
      die(`unknown command "${command}" — try: validate, graph, run, resume, calibrate, check, skills, servers, version`);
  }
}

await main();
