/**
 * Replay — the free re-run.
 *
 * Every run already writes its own tape: events.jsonl records each node
 * execution's full text,every taken edge, and every state checkpoint. Nothing
 * consumed that tape until now. Replay feeds it back through the REAL engine:
 * model and agent nodes answer from the recording at $0.00, `fn` nodes
 * re-execute live (they are deterministic and free — and you may have edited
 * them), `when` predicates re-evaluate, schemas re-check, and the route the
 * replay takes is compared against the route the recording took.
 *
 * So the loop a scene author lives in — edit the scene, check nothing broke,
 * trust it — no longer ends in "pay for a live run to find out". Edit a
 * threshold, a schema, a prompt's outputs, then `ensemble replay <run-dir>`:
 * zero spend, zero network, and a divergence is a FINDING, named by edge.
 *
 * What replay is not: a simulator. A recorded answer is only valid for the
 * prompt that produced it, so replay proves the orchestration around the
 * models — wiring, contracts, gates, loops — not what the models would say to
 * a different prompt. That is exactly the half a scene author edits most.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadScene, runtimeOf, type Scene } from "./scene.ts";
import { loadRegistry } from "./registry.ts";
import { RUNTIMES } from "./runtimes/index.ts";
import type { NodeResult } from "./runtimes/model.ts";
import { runScene, hashScene, JOURNAL_VERSION, type Journal, type NodeCaller } from "./engine.ts";
import { nullRunStore } from "./store.ts";
import type { RunEvent, EventSink } from "./events.ts";
import type { State } from "./dsl.ts";

/** One recorded node execution — the unit the tape serves back. */
interface Play {
  text: string;
  modelID: string;
  cost: number;
  tokensIn: number;
  tokensOut: number;
}

/** A taken edge, kept as both data (for comparison) and label (for the report). */
export interface RouteStep {
  from: string;
  to: string;
  when?: string;
}

export interface Tape {
  goal: string;
  /** run:start count — 1 plus one per resume that appended to the same file. */
  segments: number;
  /** node → its recorded executions, in order. Calling runtimes only. */
  plays: Map<string, Play[]>;
  /** Values that answered ask nodes, recovered from the state checkpoints. */
  answers: State;
  /** Every edge the recording actually took, across all segments. */
  route: RouteStep[];
  /** The blackboard as the recording last saw it. */
  finalState: State;
  /** node:end events with ok:false — attempts the recording itself recovered from. */
  stumbles: string[];
}

export interface ReplayReport {
  ok: boolean;
  reason?: string;
  runId: string;
  scene: string;
  sceneFile: string;
  /** The scene file's hash no longer matches the recording's — usually the point. */
  sceneChanged: boolean;
  goal: string;
  segments: number;
  /** What the recording cost, next to what the replay cost: nothing. */
  recordedCost: number;
  /** Answers served from the tape (model/agent/backend executions). */
  replayedCalls: number;
  /** Deterministic nodes re-executed live. */
  recomputed: number;
  recordedRoute: RouteStep[];
  replayedRoute: RouteStep[];
  routeMatches: boolean;
  /** Last target both routes agree on, when they diverge. */
  divergedAfter?: string;
  /** The replayed blackboard, for assertions and eyes. */
  state: State;
  stateChanged: string[];
  stateAdded: string[];
  stateRemoved: string[];
  stateSame: number;
  /** Set when the replay parked on an ask the recording never answered. */
  waiting?: { node: string; question: string };
}

/** Reads journal.json without resume's demands — a completed run replays fine. */
function readReplayJournal(runDir: string): Journal {
  const path = join(runDir, "journal.json");
  if (!existsSync(path)) {
    throw new Error(`no journal.json in ${runDir} — not a run directory, or a run from before journals`);
  }
  const journal = JSON.parse(readFileSync(path, "utf8")) as Journal;
  if (journal.version !== JOURNAL_VERSION) {
    throw new Error(`journal.json is version ${journal.version}, this build understands ${JOURNAL_VERSION}`);
  }
  return journal;
}

/**
 * Reads the tape out of events.jsonl.
 *
 * A resumed run APPENDS to the same file, so the tape may hold several
 * segments, each opening with run:start. They are read as one story: a
 * node:end that failed is a stumble the recording recovered from (the resume
 * re-ran it), so only ok executions become plays. Which node:ends are plays at
 * all is decided by the runtime each segment DECLARED for the node — park and
 * compute runtimes (ask, fn, experiment) re-execute live on replay, so their
 * recorded output is never served back.
 */
export function readTape(runDir: string): Tape {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) {
    throw new Error(
      `no events.jsonl in ${runDir} — this run predates the event transcript; record a fresh run to replay`,
    );
  }

  const plays = new Map<string, Play[]>();
  const answers: State = {};
  const route: RouteStep[] = [];
  const stumbles: string[] = [];
  const pendingAskKeys = new Set<string>();
  let goal = "";
  let segments = 0;
  let finalState: State = {};
  /** node → declared runtime, per the CURRENT segment's run:start meta. */
  let declared = new Map<string, string>();

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event: RunEvent;
    try {
      event = JSON.parse(line) as RunEvent;
    } catch {
      continue; // a torn tail line (crash mid-write) must not sink the whole tape
    }

    switch (event.type) {
      case "run:start":
        segments += 1;
        if (!goal) goal = event.goal;
        declared = new Map(event.nodes.map((n) => [n.node, n.runtime]));
        break;

      case "node:end": {
        if (!event.ok) {
          stumbles.push(event.node);
          break;
        }
        // Serve back only what a CALLING runtime produced. An unknown runtime
        // name (a custom one not registered here) gets the benefit of the doubt.
        const rt = RUNTIMES[declared.get(event.node) ?? ""];
        if (rt && (rt.park || rt.compute)) break;
        const queue = plays.get(event.node) ?? [];
        queue.push({
          text: event.text,
          modelID: event.modelID,
          cost: event.cost,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
        });
        plays.set(event.node, queue);
        break;
      }

      case "node:ask":
        for (const key of event.outputs) pendingAskKeys.add(key);
        break;

      case "state":
        finalState = event.state;
        // The first checkpoint where an asked-for key exists holds the answer
        // a human (or agent) gave — that is what re-answers the ask on replay.
        for (const key of pendingAskKeys) {
          if (key in event.state && !(key in answers)) answers[key] = event.state[key];
        }
        break;

      case "edge":
        if (!event.skipped) {
          route.push({ from: event.from, to: event.to, ...(event.when ? { when: event.when } : {}) });
        }
        break;

      case "run:end":
        finalState = event.state;
        break;

      default:
        break;
    }
  }

  if (segments === 0) throw new Error(`events.jsonl in ${runDir} holds no run — nothing to replay`);
  return { goal, segments, plays, answers, route, finalState, stumbles };
}

/** `one → two`, with the predicate when the edge had one — for the report. */
export function routeLabel(step: RouteStep): string {
  return step.when ? `${step.from} → ${step.to} (${step.when})` : `${step.from} → ${step.to}`;
}

export interface ReplayOptions {
  /** Replay against this scene file instead of the one the journal names. */
  sceneFile?: string;
  /** Receives every replay event — attach a reporter to watch it happen. */
  onEvent?: EventSink;
  maxNodeRuns?: number;
  timeoutMs?: number;
}

/**
 * Replays a recorded run through the real engine, spending nothing.
 *
 * The engine is not told it is replaying: it walks, retries, extracts, and
 * checks schemas exactly as live. Only the caller object differs — it answers
 * from the tape. A retry within one node run replays the SAME recorded text
 * (the tape is deterministic: same question, same answer), so a contract the
 * edited scene can no longer parse fails with the real problem named, instead
 * of consuming the next execution's recording.
 */
export async function replayRun(runDir: string, opts: ReplayOptions = {}): Promise<ReplayReport> {
  const dir = resolve(runDir);
  const journal = readReplayJournal(dir);
  const tape = readTape(dir);

  const sceneFile = opts.sceneFile ?? journal.scene.file;
  const scene: Scene = await loadScene(sceneFile, loadRegistry());
  const sceneChanged = hashScene(sceneFile) !== journal.scene.hash;

  // Refuse side effects. `fn` re-runs because it is deterministic and free;
  // anything else with a compute face (experiment runs real commands under a
  // budget) must not be silently re-executed by something called "replay".
  for (const [name, spec] of Object.entries(scene.nodes)) {
    const rtName = runtimeOf(scene, spec);
    if (rtName !== "fn" && RUNTIMES[rtName]?.compute) {
      throw new Error(
        `node "${name}" is runtime "${rtName}", which executes real side effects — ` +
          `replay re-runs only deterministic "fn" nodes live. Record a fresh run instead.`,
      );
    }
  }

  // The caller: answers from the tape, in recorded order, per node.
  const queues = new Map<string, Play[]>([...tape.plays].map(([k, v]) => [k, [...v]]));
  const lastPlayed = new Map<string, Play>();
  let replayedCalls = 0;
  const caller: NodeCaller = {
    name: "replay",
    call: ({ node, messages }): Promise<NodeResult> => {
      // messages beyond the first mean the engine is retrying THIS node run —
      // the tape answers a repeated question with the same recorded text.
      const retry = messages.length > 1;
      const play = retry ? lastPlayed.get(node) : (queues.get(node) ?? []).shift();
      if (!play) {
        const recorded = tape.plays.get(node)?.length ?? 0;
        throw new Error(
          recorded === 0
            ? `no recording for node "${node}" — it never ran in this tape ` +
              `(new node, or a runtime change); record a fresh run to tape it`
            : `the tape for node "${node}" is spent — it ran ${recorded} time(s) in the ` +
              `recording and the replay asked for more; the route has diverged (see the route report)`,
        );
      }
      lastPlayed.set(node, play);
      if (!retry) replayedCalls += 1;
      return Promise.resolve({
        text: play.text,
        modelID: play.modelID,
        providerID: "replay",
        cost: 0,
        tokensIn: play.tokensIn,
        tokensOut: play.tokensOut,
      });
    },
  };

  // Collect the replay's own route and fn re-runs from the same event stream
  // everything else watches — the engine is not asked to know it is observed.
  const replayedRoute: RouteStep[] = [];
  let recomputed = 0;
  const observe: EventSink = (event) => {
    if (event.type === "edge" && !event.skipped) {
      replayedRoute.push({ from: event.from, to: event.to, ...(event.when ? { when: event.when } : {}) });
    }
    if (event.type === "node:end" && event.ok && event.providerID === "fn") recomputed += 1;
    opts.onEvent?.(event);
  };

  // The tape already proved this many node runs were needed; a replay must not
  // trip the default guard rail on a run the recording completed legitimately.
  const maxNodeRuns = opts.maxNodeRuns ?? Math.max(50, journal.nodeRuns + 10);

  const result = await runScene(scene, journal.goal || tape.goal, {
    caller,
    store: nullRunStore,
    answers: tape.answers,
    maxNodeRuns,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    onEvent: observe,
  });

  // Route comparison: the recording's taken edges against the replay's.
  const shared = (() => {
    let i = 0;
    while (
      i < tape.route.length &&
      i < replayedRoute.length &&
      tape.route[i]?.from === replayedRoute[i]?.from &&
      tape.route[i]?.to === replayedRoute[i]?.to
    ) {
      i++;
    }
    return i;
  })();
  const routeMatches = shared === tape.route.length && shared === replayedRoute.length;
  const divergedAfter = routeMatches
    ? undefined
    : shared === 0
      ? scene.entry
      : tape.route[shared - 1]?.to;

  // State comparison: key by key against the recording's final blackboard.
  const stateChanged: string[] = [];
  const stateAdded: string[] = [];
  const stateRemoved: string[] = [];
  let stateSame = 0;
  const keys = new Set([...Object.keys(tape.finalState), ...Object.keys(result.state)]);
  keys.delete("goal");
  for (const key of keys) {
    const before = tape.finalState[key];
    const after = result.state[key];
    if (before === undefined) stateAdded.push(key);
    else if (after === undefined) stateRemoved.push(key);
    else if (JSON.stringify(before) === JSON.stringify(after)) stateSame += 1;
    else stateChanged.push(key);
  }

  const waiting = "waiting" in result ? result.waiting : undefined;
  return {
    ok: result.ok,
    ...(result.ok ? {} : { reason: (result as { reason: string }).reason }),
    runId: journal.runId,
    scene: scene.name,
    sceneFile,
    sceneChanged,
    goal: journal.goal || tape.goal,
    segments: tape.segments,
    recordedCost: journal.totalCost,
    replayedCalls,
    recomputed,
    recordedRoute: tape.route,
    replayedRoute,
    routeMatches,
    ...(divergedAfter !== undefined ? { divergedAfter } : {}),
    state: result.state,
    stateChanged: stateChanged.sort(),
    stateAdded: stateAdded.sort(),
    stateRemoved: stateRemoved.sort(),
    stateSame,
    ...(waiting ? { waiting: { node: waiting.node, question: waiting.question } } : {}),
  };
}
