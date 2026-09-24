/**
 * The brainstem: what keeps a runner alive for days.
 *
 * A runner is one tick. It sees, decides, acts and stops, which is exactly why
 * it can be proved. But the systems worth building run for days, and what
 * keeps them alive is not more cleverness in the tick. It is the dull,
 * autonomic work around it: carrying memory from one tick to the next, eating
 * no more than the budget, resting when it has spent enough for the day,
 * noticing when it has stopped making sense, and calling for help. Every loop
 * someone writes around a runner reinvents that, usually without the parts
 * that matter at hour forty.
 *
 * So this is the loop, written once. It stays deliberately outside the graph:
 * the tick is still a runner, still validated, still recorded as run.json.
 * Supervision is a separate layer because the two fail differently. A tick
 * fails loudly and at once; a long-running system fails slowly, by drifting.
 *
 * One rule about the watcher is worth stating plainly, because it is the whole
 * reason it can be trusted: THE WATCHED WORK DOES NOT AUTHOR THE EVIDENCE. The
 * vitals are computed here, from run records; `recent` is built here, from
 * statuses and paths. What a tick actually SAID is withheld unless you ask for
 * it (`watch.evidence: "facts+text"`), because a tick that processes untrusted
 * input — a support message, a web page, a file — would otherwise be writing
 * the text its own supervisor reads. A conscience the work can talk to is not a
 * conscience.
 *
 * Drift is watched two ways, mirroring the rest of the library. Arithmetic is
 * computed here, in code: failure rate, gate rate, spend, how often the same
 * path repeats. Meaning is asked of a WATCHER, which is just another runner:
 * it gets those numbers (for its `when:` edges) and a plain-text account of
 * recent ticks (for Jev), and returns "continue", "alert" or "stop". At
 * ~$0.00002 a question, a system can afford to ask itself whether it is still
 * on track every few ticks, forever. That is the niche: not a smarter agent,
 * but a cheap, calibrated conscience around whatever does the work.
 *
 * Everything it does is written to a journal directory as it happens, so a
 * crash loses at most the step in flight and a restart picks up where it left
 * off: memory, spend and history included.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RunFailed,
  RunnerError,
  type Paused,
  type RunDoc,
  type RunEvent,
  type RunOptions,
  type RunOutcome,
  type RunStep,
} from "./execute.ts";
import type { Runner } from "./runner.ts";
import type { State } from "./spec.ts";

export type SuperviseStatus = "exhausted" | "maxTicks" | "budget" | "failing" | "stopped" | "cancelled";

/** How the last `window` ticks went. Numbers, so a watcher reads them in `when:` and never asks Jev to do sums. */
export interface Vitals {
  tick: number;
  /** Ticks in the window. */
  ticks: number;
  /** Ticks that did not complete: a failed node, a per-run budget, maxSteps. Not paused ones. */
  failed: number;
  /** Ticks in the window that paused for a person and are waiting to be resumed. */
  waiting: number;
  failureRate: number;
  /** Ticks where a confidence gate fired, sending the run down its unsure path. */
  gateRate: number;
  /** Mean confidence of every choice and score answered in the window, or null if none were. */
  confidence: number | null;
  /** Share of window ticks that took the single most common path. Near 1 on a loop that should vary means it is stuck. */
  sameness: number;
  /** Consecutive failed ticks, right now. */
  streak: number;
  /** Spent in the window, and in total since the journal began. */
  cost: number;
  spent: number;
  /** Spent in the last 24 hours. */
  spentToday: number;
  msPerTick: number;
  /**
   * Spend in the window divided by the ticks that COMPLETED — what a finished
   * task actually costs, with the failed attempts it took charged to it. Null
   * when nothing in the window completed. Watch this, not the per-call price: a
   * cheap decision that sends the work down the wrong branch is not cheap.
   */
  costPerCompleted: number | null;
}

/**
 * A tick that was running when the process stopped. Its `work` steps may have
 * already had their effects — an email sent, a row written, a charge made — and
 * re-running the tick blindly would do them twice. So the steps that finished
 * are handed to `next()`, which is the only place that knows what "already done"
 * means for this system.
 */
export interface Interrupted {
  /** The tick that was running. `next()` is about to be asked for this same tick number. */
  tick: number;
  /** Every step that finished before the stop, in order, as the journal recorded it. */
  steps: RunStep[];
  /**
   * True when the run itself finished but the checkpoint after it was never
   * written: every effect happened, and only the memory update was lost.
   */
  finished: boolean;
}

/** One tick, reduced to what supervision needs. Kept for the window and in the checkpoint. */
export interface TickSummary {
  tick: number;
  at: string;
  status: RunDoc["run"]["status"] | "error";
  path: string[];
  cost: number;
  ms: number;
  gated: boolean;
  confidences: number[];
  /** The result as text, truncated. What the watcher reads to judge progress. */
  said: string;
}

export type Verdict = "continue" | "alert" | "stop";

export type SuperviseEvent =
  | { type: "start"; tick: number; resumed: boolean }
  | { type: "interrupted"; tick: number; steps: number; finished: boolean }
  | { type: "paused"; tick: number; node: string; file?: string }
  | { type: "tick"; summary: TickSummary; spent: number }
  | { type: "rest"; until: string; reason: string }
  | { type: "watch"; tick: number; verdict: Verdict; vitals: Vitals; reason?: string }
  | { type: "alert"; tick: number; reason: string; vitals: Vitals }
  | { type: "stop"; tick: number; status: SuperviseStatus; reason: string };

export interface Stimulus {
  /** The tick about to run, counting from 1 across restarts. */
  tick: number;
  /** The runner's declared `memory` keys, as the last completed tick left them. */
  memory: State;
  /** The previous tick, when there was one in this process. */
  last?: RunOutcome;
  /**
   * Present once, on the first call after a restart, when the journal shows a
   * tick that started and never checkpointed. Look at what it already did
   * before asking for it again.
   */
  interrupted?: Interrupted;
  signal: AbortSignal;
}

export interface SuperviseOptions {
  /**
   * The next tick's inputs, or undefined to finish. This is the sense organ:
   * await a camera frame, a queue, a timer. Memory is not built here: the
   * runner's declared `memory` keys are carried in by the supervisor itself,
   * and a node in the graph writes them. That is what keeps what the system
   * remembers visible in graph.json and provable by validate.
   */
  next: (stimulus: Stimulus) => State | undefined | Promise<State | undefined>;
  /** Starting values for the runner's `memory` keys, used only when there is no checkpoint. */
  memory?: State;
  budget?: {
    /** Stop for good once this much has been spent. */
    total?: number;
    /** Rest (sleep) whenever the last 24 hours have spent this much, then carry on. */
    perDay?: number;
    /** Passed to each tick as its own `budget`. */
    perRun?: number;
  };
  /** Stop after this many ticks, counting across restarts. */
  maxTicks?: number;
  /** Wait at least this long between tick starts, in ms. */
  pace?: number;
  /** Stop after this many failed ticks in a row. Default 5. */
  maxStreak?: number;
  /** Ticks the vitals look back over. Default 20. */
  window?: number;
  /** Options for every tick. `budget`, `signal` and `onEvent` are the supervisor's. `stepTimeout` is strongly advised. */
  run?: Omit<RunOptions, "budget" | "signal" | "onEvent">;
  /**
   * The conscience. Every `every` ticks, `runner` is called with
   * `{ goal, vitals, recent }` and its result must be "continue", "alert" or
   * "stop". Declare `vitals` and `recent` in its `inputs`.
   *
   * `evidence` decides what `recent` carries. `"facts"` (the default) is
   * tick number, status, path and whether a gate fired — all written by the
   * supervisor. `"facts+text"` adds what each tick returned, which is richer
   * and is also the tick's own words: only use it where the work's output is
   * trusted, never where a tick handles input from outside.
   */
  watch?: {
    every: number;
    runner: Runner;
    goal?: string;
    evidence?: "facts" | "facts+text";
    run?: Omit<RunOptions, "signal" | "onEvent">;
  };
  /** A directory. Everything is journalled there as it happens, and a restart resumes from it. */
  journal?: string;
  /** Resume from the journal's checkpoint when there is one. Default true. */
  resume?: boolean;
  /**
   * Handle SIGTERM and SIGINT. The first stops after the tick in flight and
   * checkpoints; a second aborts at once. Default true, because a loop meant
   * to live for days will be restarted by a deploy sooner or later.
   */
  signals?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: SuperviseEvent) => void;
  /** Each tick's own events, for a reporter or a live feed. */
  onRunEvent?: (event: RunEvent, tick: number) => void;
  /** Your effect: page someone, post to a channel. Called for watcher alerts and for every stop that is not a normal finish. */
  onAlert?: (alert: { tick: number; reason: string; vitals: Vitals }) => void | Promise<void>;
  /**
   * A tick stopped to wait for a person. The loop does NOT wait with it — the
   * next tick runs — so this is where the snapshot goes to whoever will answer:
   * a queue, a chat thread, a review screen. Resume it later with
   * `runner.resume(paused, answer)`. Without this, the pause raises an alert
   * instead, so it is never silent. With a journal, the snapshot is also saved
   * under `paused/<tick>.json`.
   */
  onPaused?: (paused: Paused, tick: number) => void | Promise<void>;
}

export interface SuperviseOutcome {
  status: SuperviseStatus;
  ticks: number;
  spent: number;
  memory: State;
  vitals: Vitals;
}

interface Checkpoint {
  version: 1;
  tick: number;
  spent: number;
  memory: State;
  /** [ISO time, cost] for the last 24 hours of ticks. */
  ledger: Array<[string, number]>;
  recent: TickSummary[];
  at: string;
}

const DAY = 24 * 60 * 60 * 1000;
const round = (n: number, places = 8): number => Number(n.toFixed(places));

const text = (value: unknown, max = 240): string => {
  const raw = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? String(value);
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
};

/** A sleep the caller can cut short. */
const rest = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

function summarise(tick: number, run: RunDoc, result: unknown, error?: string): TickSummary {
  const confidences = run.steps.flatMap((step) =>
    Object.values(step.answers ?? {}).flatMap((answer) => (answer.confidence === undefined ? [] : [answer.confidence])),
  );
  return {
    tick,
    at: run.run.ended,
    status: run.run.status,
    path: run.steps.map((step) => step.node),
    cost: run.run.cost.total,
    ms: Date.parse(run.run.ended) - Date.parse(run.run.started),
    gated: run.steps.some((step) => step.took === "gate"),
    confidences,
    said: text(error ?? result),
  };
}

export function vitalsOf(recent: TickSummary[], tick: number, spent: number, ledger: Array<[string, number]>): Vitals {
  const ticks = recent.length;
  // Waiting for a person is not failing. It is counted, but apart.
  const failing = (t: TickSummary): boolean => t.status !== "completed" && t.status !== "paused";
  const failed = recent.filter(failing).length;
  const waiting = recent.filter((t) => t.status === "paused").length;
  const completed = recent.filter((t) => t.status === "completed").length;
  let streak = 0;
  for (let i = recent.length - 1; i >= 0 && failing(recent[i]!); i--) streak++;
  const confidences = recent.flatMap((t) => t.confidences);
  const paths = new Map<string, number>();
  for (const t of recent) paths.set(t.path.join(">"), (paths.get(t.path.join(">")) ?? 0) + 1);
  const since = Date.now() - DAY;
  return {
    tick,
    ticks,
    failed,
    waiting,
    failureRate: ticks ? round(failed / ticks, 4) : 0,
    gateRate: ticks ? round(recent.filter((t) => t.gated).length / ticks, 4) : 0,
    confidence: confidences.length ? round(confidences.reduce((a, b) => a + b, 0) / confidences.length, 4) : null,
    sameness: ticks ? round(Math.max(...paths.values()) / ticks, 4) : 0,
    streak,
    cost: round(recent.reduce((sum, t) => sum + t.cost, 0)),
    spent: round(spent),
    spentToday: round(ledger.filter(([at]) => Date.parse(at) >= since).reduce((sum, [, cost]) => sum + cost, 0)),
    msPerTick: ticks ? Math.round(recent.reduce((sum, t) => sum + t.ms, 0) / ticks) : 0,
    costPerCompleted: completed ? round(recent.reduce((sum, t) => sum + t.cost, 0) / completed) : null,
  };
}

/**
 * Read the journal backwards for a tick newer than the checkpoint. Backwards
 * because a journal that has run for days is long, and the interrupted tick —
 * if there is one — is always at the end.
 */
function findInterrupted(journalPath: string, checkpointed: number): Interrupted | undefined {
  if (!existsSync(journalPath)) return undefined;
  const lines = readFileSync(journalPath, "utf8").split("\n");
  const steps: RunStep[] = [];
  let tick: number | undefined;
  let finished = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: { type?: string; tick?: number; step?: RunStep };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a line torn by the crash itself
    }
    if (typeof entry.tick !== "number") continue;
    if (entry.tick <= checkpointed) break;
    tick ??= entry.tick;
    if (entry.tick !== tick) continue;
    if (entry.type === "step" && entry.step) steps.unshift(entry.step);
    if (entry.type === "run") finished = true;
  }
  return tick === undefined ? undefined : { tick, steps, finished };
}

/**
 * The recent ticks as plain text, one line each: what a watcher's decide node
 * reads. Facts only by default — everything on the line is written by the
 * supervisor, not by the work being watched. `withText` adds each tick's own
 * output, which is exactly the part an untrusted input could have steered.
 */
export function recentText(recent: TickSummary[], withText = false): string {
  return recent
    .map((t) => {
      const facts = `tick ${t.tick} · ${t.status}${t.gated ? " · unsure" : ""} · ${t.path.join(" → ") || "no steps"} · ${t.ms}ms`;
      return withText && t.said ? `${facts} · said: ${t.said}` : facts;
    })
    .join("\n");
}

/** Is a process with this pid alive? */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function supervise(runner: Runner, options: SuperviseOptions): Promise<SuperviseOutcome> {
  const problems = runner.validate();
  if (problems.length) throw new RunnerError(runner.spec.name, problems);
  const memoryKeys = runner.spec.memory ?? [];
  if (options.watch) {
    const watcher = options.watch.runner;
    const wrong = watcher.validate();
    if (wrong.length) throw new RunnerError(watcher.spec.name, wrong);
    if (!(options.watch.every >= 1)) throw new TypeError("watch.every must be 1 or more — how many ticks between checks");
  }

  const window = options.window ?? 20;
  const maxStreak = options.maxStreak ?? 5;

  // One signal for the loop. The caller's, SIGTERM and a second SIGINT all
  // land on it; the first SIGTERM only asks the loop to stop between ticks.
  const own = new AbortController();
  const signal = own.signal;
  const relay = () => own.abort(options.signal?.reason);
  if (options.signal?.aborted) relay();
  else options.signal?.addEventListener("abort", relay, { once: true });
  let stopping: string | undefined;
  const onSignal = (name: NodeJS.Signals): void => {
    if (stopping) own.abort(new Error(`${name} twice — aborting the tick in flight`));
    else stopping = `${name} received — stopping after the tick in flight`;
  };
  if (options.signals !== false) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }

  // ── the journal: append-only lines, plus a checkpoint replaced atomically ──
  const dir = options.journal;
  const lockPath = dir ? join(dir, "lock") : undefined;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    // Two supervisors on one journal would interleave their lines and race on
    // the checkpoint, so the directory is owned by one live process.
    if (existsSync(lockPath!)) {
      const holder = Number(readFileSync(lockPath!, "utf8").trim());
      if (holder && holder !== process.pid && alive(holder)) {
        throw new Error(`${dir} is held by process ${holder}, which is still running — stop it, or use another journal`);
      }
    }
    writeFileSync(lockPath!, `${process.pid}\n`);
  }
  const write = (entry: Record<string, unknown>): void => {
    if (dir) appendFileSync(join(dir, "journal.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  };
  const pulse = (entry: Record<string, unknown>): void => {
    if (!dir) return;
    writeFileSync(join(dir, "pulse.tmp"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    renameSync(join(dir, "pulse.tmp"), join(dir, "pulse.json"));
  };

  let tick = 0;
  let spent = 0;
  let memory: State = Object.fromEntries(memoryKeys.map((key) => [key, options.memory?.[key]]));
  let ledger: Array<[string, number]> = [];
  let recent: TickSummary[] = [];
  let resumed = false;

  const checkpointPath = dir ? join(dir, "checkpoint.json") : undefined;
  let interrupted: Interrupted | undefined;
  if (checkpointPath && options.resume !== false && existsSync(checkpointPath)) {
    const saved = JSON.parse(readFileSync(checkpointPath, "utf8")) as Checkpoint;
    ({ tick, spent, ledger, recent } = saved);
    memory = Object.fromEntries(memoryKeys.map((key) => [key, saved.memory?.[key]]));
    resumed = true;
    interrupted = findInterrupted(join(dir!, "journal.jsonl"), tick);
  }
  const checkpoint = (): void => {
    if (!checkpointPath) return;
    const saved: Checkpoint = { version: 1, tick, spent, memory, ledger, recent, at: new Date().toISOString() };
    writeFileSync(`${checkpointPath}.tmp`, `${JSON.stringify(saved)}\n`);
    renameSync(`${checkpointPath}.tmp`, checkpointPath);
  };

  const emit = (event: SuperviseEvent): void => {
    write(event as unknown as Record<string, unknown>);
    options.onEvent?.(event);
  };
  const vitals = (): Vitals => vitalsOf(recent, tick, spent, ledger);
  const alert = async (reason: string): Promise<void> => {
    const v = vitals();
    emit({ type: "alert", tick, reason, vitals: v });
    try {
      await options.onAlert?.({ tick, reason, vitals: v });
    } catch (error) {
      write({ type: "error", tick, where: "onAlert", error: (error as Error).message });
    }
  };
  const stop = async (status: SuperviseStatus, reason: string): Promise<SuperviseOutcome> => {
    if (status !== "exhausted" && status !== "maxTicks" && status !== "cancelled") await alert(reason);
    emit({ type: "stop", tick, status, reason });
    checkpoint();
    if (options.signals !== false) {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
    options.signal?.removeEventListener("abort", relay);
    if (lockPath) rmSync(lockPath, { force: true });
    return { status, ticks: tick, spent: round(spent), memory, vitals: vitals() };
  };
  const charge = (cost: number): void => {
    spent += cost;
    ledger.push([new Date().toISOString(), cost]);
    const since = Date.now() - DAY;
    ledger = ledger.filter(([at]) => Date.parse(at) >= since);
  };

  emit({ type: "start", tick, resumed });
  if (interrupted) {
    emit({ type: "interrupted", tick: interrupted.tick, steps: interrupted.steps.length, finished: interrupted.finished });
  }
  let last: RunOutcome | undefined;
  let lastStart = 0;

  while (true) {
    if (signal.aborted) return stop("cancelled", String(signal.reason ?? "cancelled by the caller"));
    if (stopping) return stop("cancelled", stopping);
    if (options.maxTicks !== undefined && tick >= options.maxTicks) return stop("maxTicks", `reached ${options.maxTicks} ticks`);
    const { total, perDay, perRun } = options.budget ?? {};
    if (total !== undefined && spent >= total) return stop("budget", `spent $${round(spent, 4)} of a $${total} budget`);

    // Homeostasis: when today's spend is at the limit, sleep until enough of
    // it is more than a day old, instead of dying or overspending.
    if (perDay !== undefined) {
      const today = ledger.reduce((sum, [, cost]) => sum + cost, 0);
      if (today >= perDay) {
        let freed = today;
        let until = Date.now();
        for (const [at, cost] of ledger) {
          freed -= cost;
          until = Date.parse(at) + DAY;
          if (freed < perDay) break;
        }
        emit({ type: "rest", until: new Date(until).toISOString(), reason: `spent $${round(today, 4)} of $${perDay} in 24h` });
        await rest(until - Date.now() + 1, signal);
        ledger = ledger.filter(([at]) => Date.parse(at) >= Date.now() - DAY);
        continue;
      }
    }
    if (options.pace) await rest(lastStart + options.pace - Date.now(), signal);
    if (signal.aborted) continue;

    let inputs: State | undefined;
    try {
      inputs = await options.next({
        tick: tick + 1,
        memory: { ...memory },
        ...(last ? { last } : {}),
        ...(interrupted ? { interrupted } : {}),
        signal,
      });
      interrupted = undefined; // handed over once; the next tick is a fresh one
    } catch (error) {
      write({ type: "error", tick: tick + 1, where: "next", error: (error as Error).message });
      const failed: TickSummary = {
        tick: tick + 1,
        at: new Date().toISOString(),
        status: "error",
        path: [],
        cost: 0,
        ms: 0,
        gated: false,
        confidences: [],
        said: text((error as Error).message),
      };
      recent = [...recent, failed].slice(-window);
      tick++;
      checkpoint();
      if (vitals().streak >= maxStreak) return stop("failing", `${maxStreak} ticks in a row failed — last: ${(error as Error).message}`);
      continue;
    }
    if (inputs === undefined) return stop("exhausted", "next() had nothing more");
    // Memory is the supervisor's to carry, so it wins over anything next() set.
    inputs = { ...inputs, ...memory };

    tick++;
    lastStart = Date.now();
    const now = tick;
    let summary: TickSummary;
    try {
      const outcome = await runner(inputs, {
        ...options.run,
        ...(perRun !== undefined ? { budget: perRun } : {}),
        signal,
        onEvent: (event) => {
          if (event.type === "node:end") write({ type: "step", tick: now, step: event.step });
          if (event.type !== "run:end") pulse({ tick: now, node: event.type === "node:start" ? event.node : event.step.node, event: event.type, spent: round(spent) });
          options.onRunEvent?.(event, now);
        },
      });
      last = outcome;
      summary = summarise(now, outcome.run, outcome.result);
      write({ type: "run", tick: now, run: outcome.run });
      if (outcome.run.run.status === "completed") {
        memory = Object.fromEntries(memoryKeys.map((key) => [key, outcome.state[key]]));
      }
      if (outcome.paused) {
        let file: string | undefined;
        if (dir) {
          mkdirSync(join(dir, "paused"), { recursive: true });
          file = join("paused", `${now}.json`);
          writeFileSync(join(dir, file), `${JSON.stringify(outcome.paused, null, 2)}\n`);
        }
        emit({ type: "paused", tick: now, node: outcome.paused.node, ...(file ? { file } : {}) });
        if (options.onPaused) await options.onPaused(outcome.paused, now);
        else await alert(`tick ${now} is waiting for a person at "${outcome.paused.node}"${file ? ` — ${file}` : ""}`);
      }
    } catch (error) {
      if (!(error instanceof RunFailed)) {
        write({ type: "error", tick: now, where: "run", error: (error as Error).message });
        checkpoint();
        throw error;
      }
      last = undefined;
      summary = summarise(now, error.run, undefined, error.message);
      // A tick that threw is a failed tick whatever its record says. Trusting
      // the document here once let a broken run whose status read "paused" be
      // filed as patiently waiting: the failing streak never tripped, no alert
      // fired, and a loop meant to notice it had stopped making sense reported
      // a clean finish. Broken must never look like patient.
      summary.status = "failed";
      write({ type: "run", tick: now, run: error.run });
    }
    charge(summary.cost);
    recent = [...recent, summary].slice(-window);
    checkpoint();
    emit({ type: "tick", summary, spent: round(spent) });

    if (vitals().streak >= maxStreak) return stop("failing", `${maxStreak} ticks in a row did not complete — last: ${summary.said}`);

    // The conscience: numbers for its when: edges, words for its questions.
    if (options.watch && tick % options.watch.every === 0) {
      const v = vitals();
      let verdict: Verdict = "continue";
      let reason: string | undefined;
      try {
        const { result, run } = await options.watch.runner(
          {
            goal: options.watch.goal ?? `keep "${runner.spec.name}" doing its job`,
            vitals: v,
            recent: recentText(recent, options.watch.evidence === "facts+text"),
          },
          { ...options.watch.run, signal },
        );
        charge(run.run.cost.total);
        write({ type: "watched", tick, run });
        if (result === "continue" || result === "alert" || result === "stop") {
          verdict = result;
          // Say WHY: the watcher's path is its reasoning, e.g. "vitals → halt".
          reason = `the watcher said ${result} · ${run.steps.map((step) => step.node).join(" → ")}`;
        }
        else {
          verdict = "alert";
          reason = `the watcher returned ${JSON.stringify(result)} — it must return "continue", "alert" or "stop"`;
        }
      } catch (error) {
        if (error instanceof RunFailed) charge(error.run.run.cost.total);
        verdict = "alert";
        reason = `the watcher failed: ${(error as Error).message}`;
      }
      checkpoint();
      emit({ type: "watch", tick, verdict, vitals: v, ...(reason ? { reason } : {}) });
      if (verdict === "alert") await alert(reason ?? "the watcher raised an alert");
      if (verdict === "stop") return stop("stopped", reason ?? "the watcher said stop");
    }
  }
}
