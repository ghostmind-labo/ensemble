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
import { describeServer, isRunnable, missingEnv, preflight, searchAgents, searchServers, searchSkills } from "./registry.ts";
import { agentCard } from "./a2a.ts";
import { serveRunner } from "./a2a-serve.ts";
import { mcpTools, serveTools } from "./mcp-serve.ts";
import { describeAgent } from "./agent.ts";
import { isRemote, type RemoteServerSpec } from "./mcp.ts";
import { authMode, fileTokenStore, login, loginStatus, logout, safeUrl } from "./mcp-auth.ts";

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
  ensemble agents [query]           Agents in the ACP registry, and the command
                                    that launches each as an acp agent.
  ensemble agents card <url>        Read an A2A agent's card: who it is, how it
                                    is reached, what it offers, what auth it
                                    declares. JSON on stdout.
  ensemble agents list <file>       The agents a runner declares, and how each is
                                    reached. Never a secret.
  ensemble mcp login <server> [file] Log in to a remote MCP server (OAuth): a
                                    browser, or --device for a code to type
                                    elsewhere. The server comes from the runner
                                    file, --url, or an earlier login.
  ensemble mcp logout <server> [file] Revoke and forget its tokens.
  ensemble mcp status [file]        Remote servers, how each authenticates, and
                                    whether it is logged in. Never a secret.
  ensemble serve mcp <file...>      Serve runners as MCP tools: over stdio, or
                                    with --port over HTTP at /mcp. One runner
                                    is one tool. Free until a tool is called.
  ensemble serve a2a <file>         Serve one runner as an A2A agent (default
                                    port 4320). Free until a task is sent.
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
      --url <url>    mcp: the server's url, when no runner file names it
      --header k=v   mcp: a header the server needs even to log in (repeatable)
      --device       mcp login: the device flow, for a machine with no browser
      --port <n>     serve: the port (mcp: HTTP instead of stdio)
      --host <host>  serve: the interface to bind (default 127.0.0.1)
      --token <t>    serve: require "Authorization: Bearer <t>"
                     (or MCP_TOKEN / A2A_TOKEN)
      --secret <s>   serve mcp: the key paused runs are sealed with (or
                     MCP_SECRET); without it a restart forgets them
      --public-url <url> serve a2a: the address callers reach it at

The file must default-export a runner(). Scenes are .mts, loaded by Node's own
type stripping — Node 22.18 or newer.

  OPENROUTER_API_KEY the one key: Jev decides and models write through it.
                     Required by 'run' and 'calibrate'; 'validate' and 'graph'
                     never call out.
  ENSEMBLE_MCP_TOKENS where remote MCP logins are kept (default
                     ~/.ensemble/mcp-tokens, one 0600 file per server).
`;

const die = (message: string): never => {
  process.stderr.write(`ensemble: ${message}\n`);
  process.exit(1);
};

const warn = (found: string[]): void => {
  for (const warning of found) process.stderr.write(`  ⚠ ${warning}\n`);
};

const RUNNER_FILE = /\.(m?ts|m?js)$/;

/**
 * `ensemble mcp login|logout|status` — the one place a person meets OAuth.
 *
 * A run never opens a browser: it fails with the command to run here. So the
 * server's spec is found the way a person would name it — in the runner file,
 * by --url, or remembered from an earlier login.
 */
async function mcp(
  sub: string | undefined,
  args: string[],
  values: { url?: string; header?: string[]; device?: boolean },
): Promise<void> {
  const file = args.find((arg) => RUNNER_FILE.test(arg));
  const server = args.find((arg) => !RUNNER_FILE.test(arg));
  const store = fileTokenStore();

  const specFor = async (name: string): Promise<RemoteServerSpec> => {
    if (file) {
      const runner = await load(file);
      const agent = runner.spec.agents?.[name];
      // An A2A agent is asked who you are the same ways, so its login lives in the same store.
      if (!runner.spec.mcpServers?.[name] && agent?.protocol === "a2a") {
        return { url: agent.url, ...(agent.headers ? { headers: agent.headers } : {}), ...(agent.auth !== undefined ? { auth: agent.auth } : {}) };
      }
      const spec = runner.spec.mcpServers?.[name];
      if (!spec) die(`${file} declares no MCP server "${name}". Declared: ${Object.keys(runner.spec.mcpServers ?? {}).join(", ") || "none"}`);
      if (!isRemote(spec!)) die(`MCP server "${name}" is a local process — there is nothing to log in to`);
      return spec as RemoteServerSpec;
    }
    const headers: Record<string, string> = {};
    for (const pair of values.header ?? []) {
      const at = pair.indexOf("=");
      if (at < 1) die(`--header wants key=value, got "${pair}"`);
      headers[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const url = values.url ?? (await store.load(name))?.resource;
    if (!url) die(`no url for "${name}" — pass the runner file that declares it, or --url https://…`);
    return { url: url!, ...(Object.keys(headers).length ? { headers } : {}) };
  };

  switch (sub) {
    case "login": {
      if (!server) die("which server? — ensemble mcp login <server> [file] [--url <url>] [--device]");
      const spec = await specFor(server!);
      process.stderr.write(`logging in to "${server}" at ${safeUrl(spec.url)} (${authMode(spec)})\n`);
      await login(server!, spec, { interactive: true, device: values.device ?? false });
      const status = await loginStatus(server!, spec);
      process.stderr.write(
        `✓ logged in to "${server}"${status.expiresAt ? ` — token valid until ${new Date(status.expiresAt).toISOString()}` : ""}` +
          `${status.refreshable ? ", refreshes on its own" : ""}\n`,
      );
      return;
    }
    case "logout": {
      if (!server) die("which server? — ensemble mcp logout <server> [file] [--url <url>]");
      const spec = await specFor(server!);
      const { revoked } = await logout(server!, spec);
      process.stderr.write(`✓ logged out of "${server}"${revoked ? " — tokens revoked at the server" : ""}\n`);
      return;
    }
    case "status": {
      const rows = new Map<string, RemoteServerSpec>();
      if (file) {
        const runner = await load(file);
        for (const [name, spec] of Object.entries(runner.spec.mcpServers ?? {})) if (isRemote(spec)) rows.set(name, spec);
      }
      for (const name of (await store.list?.()) ?? []) {
        if (rows.has(name)) continue;
        const stored = await store.load(name);
        if (stored) rows.set(name, { url: stored.resource, auth: { type: "oauth" } });
      }
      if (!rows.size) {
        process.stderr.write(`no remote MCP servers${file ? ` in ${file}` : ""} and no logins stored\n`);
        return;
      }
      for (const [name, spec] of rows) {
        const status = await loginStatus(name, spec).catch(() => undefined);
        const oauth = authMode(spec).startsWith("oauth") || authMode(spec).startsWith("none");
        const state = !status
          ? "unknown"
          : !oauth
            ? "credentials from the spec"
            : status.loggedIn
              ? `logged in${status.expiresAt ? `, expires ${new Date(status.expiresAt).toISOString()}` : ""}${status.refreshable ? ", refreshable" : ""}`
              : "not logged in";
        process.stdout.write(`${name.padEnd(16)} ${safeUrl(spec.url).padEnd(36)} ${authMode(spec).padEnd(28)} ${state}\n`);
      }
      return;
    }
    default:
      die(`unknown mcp command "${sub ?? ""}" — try: login, logout, status`);
  }
}

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
/**
 * A run that failed is still a run: the record of where it stopped is the thing
 * you want, and a viewer or `summarize` can only count failures that are on disk.
 */
function saveFailed(runner: Runner, error: RunFailed, flags: { out?: string; json?: boolean }): never {
  const json = `${JSON.stringify(error.run, null, 2)}\n`;
  process.stderr.write(`  ✗ ${error.message} · ${money(error.run.run.cost.total)}\n`);
  if (flags.json) process.stdout.write(json);
  else {
    const dir = flags.out ? dirname(resolve(flags.out)) : resolve(".ensemble", "runs", error.run.run.id);
    const path = flags.out ? resolve(flags.out) : join(dir, "run.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, json, "utf8");
    writeFileSync(join(dirname(path), "graph.json"), `${JSON.stringify(runner.graph(), null, 2)}\n`, "utf8");
    process.stderr.write(`  ${path}\n`);
  }
  return process.exit(1);
}

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
      url: { type: "string" },
      header: { type: "string", multiple: true },
      device: { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string" },
      token: { type: "string" },
      secret: { type: "string" },
      "public-url": { type: "string" },
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
      warn(runner.warnings());
      report(runner.validate(), runner.spec.name);
      return;
    }

    case "check": {
      const runner = await load(file);
      warn(runner.warnings());
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
        if (error instanceof RunFailed) saveFailed(runner, error, { out: values.out, json: values.json });
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
        if (error instanceof RunFailed) saveFailed(runner, error, { out: values.out, json: values.json });
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

    case "agents": {
      if (file === "card") {
        const url = rest[0];
        if (!url) die("which agent? — ensemble agents card <url>");
        const headers: Record<string, string> = {};
        for (const pair of values.header ?? []) {
          const at = pair.indexOf("=");
          if (at < 1) die(`--header wants key=value, got "${pair}"`);
          headers[pair.slice(0, at)] = pair.slice(at + 1);
        }
        const card = await agentCard("card", { protocol: "a2a", url: url!, ...(Object.keys(headers).length ? { headers } : {}) }).catch(
          (error: Error) => die(error.message.replace(/^agent "card": /, "")) as never,
        );
        const { raw: _raw, ...summary } = card;
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        process.stderr.write(
          `"${card.name}"${card.version ? ` ${card.version}` : ""} · ${card.interfaces.map((face) => `${face.binding}${face.version ? ` ${face.version}` : ""}`).join(", ") || "no interface"}` +
            ` · ${card.streaming ? "streams" : "no streaming"} · ${card.skills.length} skill${card.skills.length === 1 ? "" : "s"}\n` +
            `  agents: { ${JSON.stringify(card.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "agent")}: { protocol: "a2a", url: ${JSON.stringify(url)} } }\n`,
        );
        return;
      }
      if (file === "list") {
        const runner = await load(rest[0]);
        const declared = Object.entries(runner.spec.agents ?? {});
        if (!declared.length) {
          process.stderr.write(`${rest[0]} declares no agents\n`);
          return;
        }
        for (const [name, agent] of declared) {
          const extra =
            agent.protocol === "a2a"
              ? `auth: ${authMode({ url: agent.url, ...(agent.auth !== undefined ? { auth: agent.auth } : {}) })}`
              : agent.protocol === "acp"
                ? `permissions: ${JSON.stringify(agent.permissions ?? "reject")}`
                : "one MCP tool";
          process.stdout.write(`${name.padEnd(16)} ${agent.protocol.padEnd(4)} ${describeAgent(agent).padEnd(40)} ${extra}\n`);
        }
        return;
      }
      const query = [file, ...rest].filter(Boolean).join(" ");
      const found = await searchAgents(query || undefined, { limit: 60 }).catch((error: Error) => die(error.message) as never);
      if (found.length === 0) {
        process.stderr.write(`nothing in the ACP registry matches "${query}"\n`);
        return;
      }
      for (const entry of found) {
        process.stdout.write(
          `${entry.id}@${entry.version}  ${entry.name}\n  ${entry.description}\n  ` +
            (entry.launch
              ? `{ protocol: "acp", command: ${JSON.stringify(entry.launch.command)}, args: ${JSON.stringify(entry.launch.args)} }`
              : `distributed as ${entry.distribution.join(", ") || "nothing this client can launch"} — install it, then name its command`) +
            `\n\n`,
        );
      }
      process.stderr.write(`${found.length} agents · ${found.filter((entry) => entry.launch).length} launchable as written\n`);
      return;
    }

    case "mcp": {
      await mcp(file, rest, values);
      return;
    }

    case "serve": {
      const budget = num(values.budget);
      const shared = { ...(budget !== undefined ? { budget } : {}), ...(values.host ? { host: values.host } : {}) };
      if (file === "mcp") {
        if (!rest.length) return die("no file given — ensemble serve mcp <file.mts> [more files]");
        // On stdio, stdout carries protocol messages only: whatever a handler logs goes to stderr.
        if (!values.port) console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
        const runners: Runner[] = [];
        for (const path of rest) runners.push(await load(path));
        const token = values.token ?? process.env["MCP_TOKEN"];
        const secret = values.secret ?? process.env["MCP_SECRET"];
        const options = { ...shared, ...(token ? { token } : {}), ...(secret ? { secret } : {}) };
        const names = runners.map((runner) => runner.spec.name).join(", ");
        try {
          if (values.port) {
            const served = await serveTools(runners, { ...options, port: num(values.port)! });
            process.stderr.write(`${names}: MCP tools at ${served.url}\n`);
          } else {
            process.stderr.write(`${names}: MCP tools on stdio\n`);
            await mcpTools(runners, options).stdio();
          }
        } catch (error) {
          die((error as Error).message);
        }
        return;
      }
      if (file === "a2a") {
        const runner = await load(rest[0]);
        if (rest.length > 1) return die("serve a2a takes one runner: an agent is one runner. Start another on a second port, or mount several with a2aAgent() in your own server");
        const token = values.token ?? process.env["A2A_TOKEN"];
        try {
          const served = await serveRunner(runner, {
            ...shared,
            ...(values.port ? { port: num(values.port)! } : {}),
            ...(token ? { token } : {}),
            ...(values["public-url"] ? { publicUrl: values["public-url"] } : {}),
          });
          process.stderr.write(`${runner.spec.name} is an A2A agent at ${served.url} (card: ${served.url}/.well-known/agent-card.json)\n`);
        } catch (error) {
          die((error as Error).message);
        }
        return;
      }
      return die(`unknown serve target "${file ?? ""}" — try: serve mcp <file...>, serve a2a <file>`);
    }

    default:
      die(`unknown command "${command}" — try: validate, graph, run, resume, calibrate, check, skills, servers, agents, mcp, serve, version`);
  }
}

await main();
