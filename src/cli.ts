#!/usr/bin/env node
/**
 * The CLI — the development loop, not the product.
 *
 * The product is the library: a runner belongs inside your server, called as an
 * ordinary function. What you want from a terminal is narrower — prove a graph,
 * emit it, run it once to see what happens. So there are four commands, and
 * three of them are free and offline.
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
import { money, reporter } from "./report.ts";

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
  ensemble version

Options
  -o, --out <path>   graph: write here instead of stdout
                     run:   write run.json here instead of .ensemble/runs/<id>/
      --json         run: print run.json to stdout instead of writing a file
      --input k=v    run: seed a state key (repeatable)
      --budget <usd> run: stop once the run costs more than this
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

    default:
      die(`unknown command "${command}" — try: validate, graph, run, version`);
  }
}

await main();
