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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRunner, type Runner } from "./runner.ts";
import { RunFailed, RunnerError } from "./execute.ts";
import { calibrate, CalibrationError, type Calibration, type Case } from "./calibrate.ts";
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
  ensemble run <file> [goal]        Run it once; writes run.json.
  ensemble calibrate <file> <cases> Score its decisions against labelled cases
                                    (.jsonl or a .json array). ~$0.00002 a case.
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

  TYPESAFE_API_KEY   required by 'run'; 'validate' and 'graph' never call out.
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

function printCalibration(c: Calibration): void {
  process.stderr.write(`${c.runner} · ${c.cases} cases · ${c.asked} asked · ${money(c.cost)}${c.stopped ? ` · stopped: ${c.stopped}` : ""}\n`);
  for (const q of c.questions) {
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
  process.stderr.write(`\n  gap is |confidence − accuracy|: near 0 means a gate can be trusted.\n`);
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
        const { run } = await runner(inputs, {
          budget: num(values.budget),
          maxSteps: num(values["max-steps"]),
          onEvent: live,
        });

        const json = `${JSON.stringify(run, null, 2)}\n`;
        if (values.json) {
          process.stdout.write(json);
        } else {
          const dir = values.out ? dirname(resolve(values.out)) : resolve(".ensemble", "runs", run.run.id);
          const path = values.out ? resolve(values.out) : join(dir, "run.json");
          mkdirSync(dir, { recursive: true });
          writeFileSync(path, json, "utf8");
          writeFileSync(join(dirname(path), "graph.json"), `${JSON.stringify(runner.graph(), null, 2)}\n`, "utf8");
          process.stderr.write(`  ${path}\n`);
        }
        if (run.run.status !== "completed") process.exit(1);
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
      die(`unknown command "${command}" — try: validate, graph, run, calibrate, check, skills, servers, version`);
  }
}

await main();
