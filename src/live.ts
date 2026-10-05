/**
 * A run in progress, where another process can see it and stop it.
 *
 * A run is a function call, and a function call is invisible from outside: you
 * cannot ask another terminal what it is doing or tell it to stop. That is fine
 * for a run of a second and useless for one of a minute, which is what a graph
 * of model calls is. And it must not depend on HOW the run was started. A
 * runner launched by `ensemble run`, or imported and called from your own
 * `node run.mts`, or from inside a server, is the same run.
 *
 * So this is a wrapper around the runner, not a feature of the CLI. While the
 * run goes, it keeps one small file up to date (`.ensemble/live/<pid>-<n>.json`:
 * the nodes in progress, each finished step, the state so far, the cost). To
 * stop it, anything may drop a mark next to that file; the run sees it at its
 * next event or within a second and cancels itself through its own signal. No
 * process signal is involved, so nothing is installed in your program and the
 * record of where it stopped is kept. When the run ends, its `run.json` and
 * `graph.json` are written where `ensemble run` writes them, so the same
 * viewer and the same commands read every run, however it began.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RunFailed, type HumanAnswer, type Paused, type RunDoc, type RunEvent, type RunOptions, type RunOutcome, type RunStep } from "./execute.ts";
import type { Runner } from "./runner.ts";
import type { State } from "./spec.ts";

export interface TrackOptions {
  /** The project's ensemble folder. Default `.ensemble` under the current directory. */
  dir?: string;
  /** Write `run.json` and `graph.json` under `<dir>/runs/<id>/` when the run ends. Default true. */
  record?: boolean;
  /** Where the runner lives, for the person reading `ensemble status`. */
  file?: string;
}

/** What the live file says. Plain JSON, rewritten whole after every event. */
export interface LiveRun {
  /** Names this run among the live ones: `<pid>-<n>`. */
  id: string;
  pid: number;
  runner: string;
  file?: string;
  status: "running";
  started: string;
  cost: number;
  /** Nodes that have started and not ended. */
  running: string[];
  steps: Array<{ node: string; kind: string; took: string | null; ms: number; cost: number; answers?: RunStep["answers"]; error?: string }>;
  /** The inputs, plus what each finished step wrote. */
  state: State;
}

export interface TrackedRunner {
  (inputs?: State, options?: RunOptions): Promise<RunOutcome>;
  resume(paused: Paused, answer: HumanAnswer, options?: RunOptions): Promise<RunOutcome>;
}

const liveDir = (dir?: string): string => resolve(dir ?? ".ensemble", "live");
let sequence = 0;

/** Write a run's record where `ensemble run` does. Used here, and by anything else that finishes a run. */
export function recordRun(runner: Runner, run: RunDoc, options: { dir?: string; paused?: Paused } = {}): string {
  const folder = resolve(options.dir ?? ".ensemble", "runs", run.run.id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(folder, "graph.json"), `${JSON.stringify(runner.graph(), null, 2)}\n`);
  if (options.paused) writeFileSync(join(folder, "paused.json"), `${JSON.stringify(options.paused, null, 2)}\n`);
  return folder;
}

/**
 * The same runner, watchable and stoppable from outside: `tracked(triage)({ goal })`.
 * Tracking is a convenience and never fails a run: a folder that cannot be written is ignored.
 */
export function tracked(runner: Runner, options: TrackOptions = {}): TrackedRunner {
  const go = async (inputs: State, runOptions: RunOptions, start: (wired: RunOptions) => Promise<RunOutcome>): Promise<RunOutcome> => {
    const id = `${process.pid}-${++sequence}`;
    const path = join(liveDir(options.dir), `${id}.json`);
    const mark = `${path}.stop`;
    const steps: RunStep[] = [];
    const active = new Map<number, string>();
    const started = new Date().toISOString();
    let cost = 0;
    const quietly = (action: () => void): void => {
      try {
        action();
      } catch {
        /* never fails the run */
      }
    };
    const write = (): void =>
      quietly(() => {
        mkdirSync(dirname(path), { recursive: true });
        const live: LiveRun = {
          id,
          pid: process.pid,
          runner: runner.spec.name,
          ...(options.file ? { file: options.file } : {}),
          status: "running",
          started,
          cost: Number(cost.toFixed(8)),
          running: [...active.values()],
          steps: steps.map((step) => ({ node: step.node, kind: step.kind, took: step.took, ms: step.ms, cost: step.cost, ...(step.answers ? { answers: step.answers } : {}), ...(step.error ? { error: step.error } : {}) })),
          state: Object.assign({}, inputs, ...steps.map((step) => step.writes ?? {})),
        };
        writeFileSync(path, `${JSON.stringify(live, null, 2)}\n`);
      });

    const controller = new AbortController();
    const heed = (): void => {
      if (existsSync(mark)) controller.abort(new Error("stopped from outside"));
    };
    // A node can run for a long time between events, so the mark is also looked for on a clock.
    const clock = setInterval(heed, 1000);
    clock.unref();
    const gone = (): void => quietly(() => (rmSync(path, { force: true }), rmSync(mark, { force: true })));
    process.once("exit", gone);

    write();
    try {
      const outcome = await start({
        ...runOptions,
        signal: runOptions.signal ? AbortSignal.any([runOptions.signal, controller.signal]) : controller.signal,
        onEvent: (event: RunEvent) => {
          if (event.type === "node:start") active.set(event.n, event.node);
          else if (event.type === "node:end") {
            active.delete(event.step.n);
            steps.push(event.step);
            cost += event.step.cost;
          }
          if (event.type !== "run:end") {
            write();
            heed();
          }
          runOptions.onEvent?.(event);
        },
      });
      if (options.record !== false) quietly(() => recordRun(runner, outcome.run, { ...(options.dir ? { dir: options.dir } : {}), ...(outcome.paused ? { paused: outcome.paused } : {}) }));
      return outcome;
    } catch (error) {
      // A run that failed is still a run: where it stopped is the thing worth keeping.
      if (error instanceof RunFailed && options.record !== false) quietly(() => recordRun(runner, error.run, options.dir ? { dir: options.dir } : {}));
      throw error;
    } finally {
      clearInterval(clock);
      process.removeListener("exit", gone);
      gone();
    }
  };
  return Object.assign((inputs: State = {}, runOptions: RunOptions = {}) => go(inputs, runOptions, (wired) => runner(inputs, wired)), {
    resume: (paused: Paused, answer: HumanAnswer, runOptions: RunOptions = {}) => go(paused.state, runOptions, (wired) => runner.resume(paused, answer, wired)),
  });
}

/** Every live run under this folder whose process is still alive. A file left by a process that died is removed. */
export function liveRuns(dir?: string): LiveRun[] {
  const folder = liveDir(dir);
  if (!existsSync(folder)) return [];
  const found: LiveRun[] = [];
  for (const name of readdirSync(folder)) {
    if (!name.endsWith(".json")) continue;
    const path = join(folder, name);
    try {
      const run = JSON.parse(readFileSync(path, "utf8")) as LiveRun;
      process.kill(run.pid, 0); // throws when there is no such process
      found.push(run);
    } catch {
      rmSync(path, { force: true });
      rmSync(`${path}.stop`, { force: true });
    }
  }
  return found.sort((a, b) => a.started.localeCompare(b.started));
}

/**
 * Ask a live run to stop, by its id (`<pid>-<n>`) or its pid, and wait until it has. It cancels
 * itself and writes its record. Resolves false when there was no such run, or it had not stopped
 * within `waitMs` (a handler ignoring its signal).
 */
export async function stopRun(which: string | number, options: { dir?: string; waitMs?: number } = {}): Promise<boolean> {
  const targets = liveRuns(options.dir).filter((run) => run.id === String(which) || String(run.pid) === String(which));
  if (!targets.length) return false;
  const paths = targets.map((run) => join(liveDir(options.dir), `${run.id}.json`));
  for (const path of paths) writeFileSync(`${path}.stop`, "");
  for (let waited = 0; waited < (options.waitMs ?? 15_000); waited += 50) {
    if (paths.every((path) => !existsSync(path))) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}
