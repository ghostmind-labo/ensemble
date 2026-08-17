/**
 * The graph executor — v2.
 *
 * Not a topological sort — cycles are the point (a critic sending work back to
 * the researcher). Execution is a cursor that walks from `entry`, running one
 * target at a time, then consulting outgoing edges to pick the next. A target is
 * either a single node or a group, and a group's members run concurrently.
 *
 * Two runtimes, chosen per node:
 *   - "model": one direct OpenRouter call. Streams real token deltas.
 *   - "agent": our own tool-calling loop — built-in read-only tools plus any MCP
 *     servers the node allowlisted, looping until the model stops asking for tools.
 * MCP servers connect lazily, only if some node actually names one.
 *
 * The engine only emits events; rendering lives in reporter.ts and serve.ts.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import type { Scene, NodeSpec } from "./scene.ts";
import { resolveTarget, runtimeOf } from "./scene.ts";
import { loadRegistry } from "./registry.ts";
import { callAgent } from "./runtimes/agent.ts";
import { callModel, type NodeResult } from "./runtimes/model.ts";
import { McpHub } from "./mcp.ts";
import { BUILTIN_NAMES } from "./tools/builtin.ts";
import {
  extractOutputs,
  renderInputs,
  outputContract,
  detectLossyExtraction,
  type State,
} from "./state.ts";
import { loadKeyFiles } from "./credentials.ts";
import type { EventSink, NodeMeta } from "./events.ts";

export interface RunOptions {
  maxNodeRuns?: number;
  timeoutMs?: number;
  /**
   * Hard USD ceiling for the whole run. Checked between nodes, and inside the
   * agent loop between turns (where an agent node is told to answer with what it
   * has rather than keep spending). Falls back to ENSEMBLE_BUDGET so one env var
   * protects every run on a machine, including ones started from the browser.
   */
  budget?: number;
  /**
   * Continue a previous run instead of starting one. Built by `readJournal()`
   * from a run directory; the run resumes at the recorded target, writes into
   * the same run directory, and keeps accumulating cost and node counts.
   */
  resumeFrom?: ResumeState;
  /**
   * State keys supplied from outside — how an `ask` node gets answered. Merged
   * into the blackboard before the walk continues, so the ask node it was parked
   * on finds its outputs already present and falls through.
   */
  answers?: State;
  /** Receives every run event. Omit for a silent run. */
  onEvent?: EventSink;
  /** Aborts the run; model nodes abort mid-stream, agent nodes between nodes. */
  signal?: AbortSignal;
}

/** Per-node spend, aggregated across every run of that node (loops included). */
export interface NodeCost {
  runs: number;
  cost: number;
  tokensIn: number;
  tokensOut: number;
}

/** Bumped when the journal's shape changes; an older file is refused, not guessed at. */
export const JOURNAL_VERSION = 1;

/**
 * A run parked on an `ask` node, waiting to be answered.
 *
 * Durable by construction: it lives in the journal, so the answerer can take
 * minutes or days, the process can die, and the question survives. Whether a
 * human answers it in the viewer or an agent answers it with `resume_run` is
 * not the engine's concern — both just supply the missing state keys.
 */
export interface PendingAsk {
  node: string;
  question: string;
  /** State keys the answer must provide. */
  outputs: string[];
}

/**
 * Everything the executor needs to pick a run back up — the graph position that
 * `state.json` alone cannot supply.
 *
 * `resumeAt` is the target still owed execution: during a target it is that
 * target (which re-runs whole, since its outputs never merged), and after one
 * completes it is whatever the edges selected next. `undefined` means the run
 * reached its exit and there is nothing to resume.
 */
export interface Journal {
  version: number;
  runId: string;
  /** Absolute path to the scene, plus a hash so we can tell if it was edited. */
  scene: { file: string; name: string; hash: string };
  goal: string;
  resumeAt?: string;
  /** Set while the run is parked on an ask node. Cleared once answered. */
  pending?: PendingAsk;
  /** Edge index → times taken, so `maxLoops` budgets survive the stop. */
  edgeLoops: Array<[number, number]>;
  nodeRuns: number;
  totalCost: number;
  nodeCosts: Record<string, NodeCost>;
  /** Why the run stopped, when it stopped early. */
  stoppedBecause?: string;
  updatedAt: string;
}

/** A journal plus the blackboard it belongs to — what `runScene` needs to continue. */
export interface ResumeState {
  journal: Journal;
  state: State;
  runDir: string;
}

/** Content hash of a scene file, so a resume can warn when the graph changed. */
export function hashScene(file: string): string {
  try {
    return createHash("sha256").update(readFileSync(file, "utf8")).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

/**
 * Loads a run directory for resuming. Throws with an actionable message rather
 * than returning something half-valid — a bad resume wastes real money.
 */
export function readJournal(runDir: string): ResumeState {
  const dir = resolve(runDir);
  const journalPath = join(dir, "journal.json");
  if (!existsSync(journalPath)) {
    throw new Error(
      `no journal.json in ${runDir} — that run predates resumable runs, or is not a run directory`,
    );
  }

  let journal: Journal;
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  } catch (err) {
    throw new Error(`journal.json is unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (journal.version !== JOURNAL_VERSION) {
    throw new Error(
      `journal.json is version ${journal.version}, this build understands ${JOURNAL_VERSION}`,
    );
  }
  if (!journal.resumeAt) {
    throw new Error(`that run already reached its exit — there is nothing left to resume`);
  }
  // A parked run stays resumable; whether the caller has the answer it needs is
  // the caller's business — `journal.pending` tells them what is being asked.

  const statePath = join(dir, "state.json");
  const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as State) : {};

  return { journal, state, runDir: dir };
}

export type RunResult =
  | { ok: true; state: State; runDir: string; totalCost: number; runId: string }
  | {
      ok: false;
      reason: string;
      state: State;
      runDir: string;
      runId: string;
      /**
       * Present when the run *paused* on an ask node rather than failed. Callers
       * that treat every `ok: false` as an error would report a waiting run as
       * broken, so check this first.
       */
      waiting?: PendingAsk;
    };

/** Stable, sortable, and filesystem-safe: 20260809-191245-researchflow */
function runId(scene: Scene): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${scene.name}`
  );
}

/**
 * A free run directory for `id`.
 *
 * The id is second-granular, so two runs of one scene in the same second would
 * otherwise share a directory and overwrite each other's artifacts — which now
 * also means overwriting each other's journal.
 */
function freeRunDir(root: string, id: string): { id: string; dir: string } {
  const base = join(root, ".ensemble", "runs");
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? id : `${id}-${n}`;
    const dir = join(base, candidate);
    if (!existsSync(dir)) return { id: candidate, dir };
  }
}

function buildPrompt(scene: Scene, node: string, goal: string, state: State): string {
  const spec = scene.nodes[node];
  if (!spec) throw new Error(`no such node: ${node}`);

  const sections = [`## Goal\n\n${goal}`];
  const context = renderInputs(state, spec.inputs ?? []);
  if (context) sections.push(context);
  const contract = outputContract(spec.outputs ?? [], scene.state);
  if (contract) sections.push(contract);
  return sections.join("\n\n");
}

/** Lazily-connected MCP servers, shared by every agent node in the run. */
class ToolHub {
  private hub: McpHub | undefined;
  private starting: Promise<McpHub> | undefined;
  private root: string;
  private servers: import("./registry.ts").McpServer[];

  constructor(root: string, servers: import("./registry.ts").McpServer[]) {
    this.root = root;
    this.servers = servers;
  }

  get(): Promise<McpHub> {
    if (this.hub) return Promise.resolve(this.hub);
    // Single-flight: parallel agent nodes must not each connect the servers.
    this.starting ??= (async () => {
      const { FileOAuthProvider } = await import("./oauth.ts");
      const hub = new McpHub(this.root, (name) => new FileOAuthProvider(name, () => {}));
      await hub.connect(this.servers);
      this.hub = hub;
      return hub;
    })();
    return this.starting;
  }

  async close(): Promise<void> {
    if (this.starting) await (await this.starting.catch(() => undefined))?.close();
  }
}

interface NodeCallCtx {
  scene: Scene;
  goal: string;
  state: State;
  hub: ToolHub;
  needsMcp: boolean;
  emit: EventSink;
  /** USD left before the run budget is exhausted; undefined = no budget set. */
  budgetLeft: () => number | undefined;
  signal?: AbortSignal;
}

/** One attempt against whichever runtime the node declared. */
async function callOnce(
  ctx: NodeCallCtx,
  node: string,
  spec: NodeSpec,
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<NodeResult> {
  const model = spec.model ?? ctx.scene.defaults.model ?? "";
  const temperature = spec.temperature ?? ctx.scene.defaults.temperature;

  if (runtimeOf(ctx.scene, spec) === "model") {
    return callModel({
      model,
      ...(spec.prompt ? { system: spec.prompt } : {}),
      messages: [...history, { role: "user", content: text }],
      ...(temperature !== undefined ? { temperature } : {}),
      onDelta: (delta) => ctx.emit({ type: "node:delta", node, delta }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  }

  const wanted = spec.mcp ?? [];
  const hub = wanted.length > 0 ? await ctx.hub.get() : undefined;
  const registry = loadRegistry();
  const skills = (spec.skills ?? [])
    .map((name) => registry.skills.get(name))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  const costLimit = ctx.budgetLeft();

  return callAgent({
    model,
    ...(spec.prompt ? { system: spec.prompt } : {}),
    messages: [...history, { role: "user", content: text }],
    ...(temperature !== undefined ? { temperature } : {}),
    ...(costLimit !== undefined ? { costLimit } : {}),
    mcp: wanted,
    // `tools: { grep: false }` opts a built-in out; default is all of them.
    builtins: BUILTIN_NAMES.filter((n) => spec.tools?.[n] !== false),
    skills,
    hub,
    root: resolve(process.cwd()),
    maxTurns: spec.maxTurns ?? 12,
    onDelta: (delta) => ctx.emit({ type: "node:delta", node, delta }),
    onToolCall: (event) => ctx.emit({ type: "node:tool", node, ...event }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
}

/**
 * Runs one node, retrying once if the output contract was not met. The retry
 * carries the failed attempt in context (session for agents, message history for
 * model calls) so the model sees what it did wrong.
 */
async function runNode(
  ctx: NodeCallCtx,
  node: string,
): Promise<
  | { values: State; result: NodeResult }
  | { error: string; result?: NodeResult }
  | { pending: PendingAsk }
> {
  const spec = ctx.scene.nodes[node];
  if (!spec) return { error: `no such node: ${node}` };

  // An ask node is pure wait: it either finds its answer already in state (an
  // answered resume) and falls through, or it parks the run.
  if (runtimeOf(ctx.scene, spec) === "ask") {
    const outputs = spec.outputs ?? [];
    const missing = outputs.filter((key) => ctx.state[key] === undefined);
    if (missing.length === 0) {
      ctx.emit({ type: "node:start", node, model: "ask", skills: [] });
      ctx.emit({
        type: "node:end",
        node,
        ok: true,
        text: outputs.map((k) => `${k}: ${String(ctx.state[k])}`).join("\n"),
        providerID: "ask",
        modelID: "ask",
        cost: 0,
        tokensIn: 0,
        tokensOut: 0,
        ms: 0,
      });
      return { values: {}, result: { text: "", modelID: "ask", providerID: "ask", cost: 0, tokensIn: 0, tokensOut: 0 } };
    }
    return {
      pending: {
        node,
        question: spec.question ?? `Provide: ${missing.join(", ")}`,
        outputs: missing,
      },
    };
  }

  const model = spec.model ?? ctx.scene.defaults.model ?? "";
  const started = Date.now();
  ctx.emit({ type: "node:start", node, model, skills: spec.skills ?? [] });

  const firstPrompt = buildPrompt(ctx.scene, node, ctx.goal, ctx.state);
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let parseProblem: string | undefined;
  let last: NodeResult | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const text =
      attempt === 1
        ? firstPrompt
        : `Your previous reply could not be parsed: ${parseProblem ?? "invalid output"}\n\n` +
          `Reply again with ONLY the required json block.`;

    let res: NodeResult;
    try {
      res = await callOnce(ctx, node, spec, text, history);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.emit({
        type: "node:end",
        node,
        ok: false,
        text: "",
        providerID: "",
        modelID: model,
        cost: 0,
        tokensIn: 0,
        tokensOut: 0,
        ms: Date.now() - started,
        error: message,
      });
      return { error: `node "${node}" failed: ${message}` };
    }

    history.push({ role: "user", content: text }, { role: "assistant", content: res.text });
    last = res;

    const finish = (ok: boolean, error?: string): void => {
      ctx.emit({
        type: "node:end",
        node,
        ok,
        text: res.text,
        providerID: res.providerID,
        modelID: res.modelID,
        cost: res.cost,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        ms: Date.now() - started,
        ...(error ? { error } : {}),
      });
    };

    if (res.error) {
      finish(false, res.error);
      return { error: `node "${node}" failed: ${res.error}`, result: res };
    }

    const extraction = extractOutputs(res.text, spec.outputs ?? [], ctx.scene.state);

    if (extraction.ok) {
      // The contract can be satisfied while still losing the substance — surface
      // it rather than letting the next node quietly receive less than it should.
      const lossy = detectLossyExtraction(res.text, extraction.values, spec.outputs ?? []);
      if (lossy) ctx.emit({ type: "node:lossy", node, ...lossy });

      finish(true);
      return { values: extraction.values, result: res };
    }

    if (attempt === 1) {
      parseProblem = extraction.problem;
      ctx.emit({ type: "node:retry", node, problem: extraction.problem ?? "unparseable output" });
    } else {
      finish(false, extraction.problem ?? "unparseable output");
      return { error: `node "${node}" did not produce required outputs: ${extraction.problem}`, result: res };
    }
  }

  return { error: `node "${node}" exhausted retries`, ...(last ? { result: last } : {}) };
}

export async function runScene(scene: Scene, goal: string, opts: RunOptions = {}): Promise<RunResult> {
  const maxNodeRuns = opts.maxNodeRuns ?? 50;
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const emit: EventSink = opts.onEvent ?? (() => {});

  // An env file may hold the only copy of the key — read it before the first
  // call, so a long-lived MCP server is not stuck with a stale environment.
  loadKeyFiles();

  const registry = loadRegistry();
  const root = resolve(process.cwd());

  // MCP servers connect only if some node actually names one.
  const wantedServers = new Set(
    Object.values(scene.nodes)
      .filter((n) => runtimeOf(scene, n) === "agent")
      .flatMap((n) => n.mcp ?? []),
  );
  const servers = [...registry.mcp.values()].filter((s) => wantedServers.has(s.name));

  // Resuming reuses the previous run's directory and identity, so a resumed run
  // leaves one continuous set of artifacts rather than a scattered trail.
  const resume = opts.resumeFrom;
  const { id, dir: runDir } = resume
    ? { id: resume.journal.runId, dir: resume.runDir }
    : freeRunDir(root, runId(scene));
  mkdirSync(runDir, { recursive: true });

  // Everything below picks up where the journal left off, or starts clean.
  // `answers` land last so they satisfy the ask node the run was parked on.
  const state: State = resume ? { ...resume.state, ...(opts.answers ?? {}), goal } : { goal, ...(opts.answers ?? {}) };
  let totalCost = resume?.journal.totalCost ?? 0;
  let nodeRuns = resume?.journal.nodeRuns ?? 0;
  const edgeLoops = new Map<number, number>(resume?.journal.edgeLoops ?? []);
  // Wall clock is per-attempt, not cumulative: a resume gets a fresh timeout.
  const deadline = Date.now() + timeoutMs;
  const sceneHash = hashScene(scene.file);

  // ENSEMBLE_BUDGET makes the cap a machine-wide default: exported once, it
  // covers every run, including ones started from the serve UI.
  const envBudget = Number(process.env["ENSEMBLE_BUDGET"]);
  const budget = opts.budget ?? (Number.isFinite(envBudget) && envBudget > 0 ? envBudget : undefined);

  // Where the money went, node by node — written next to state.json so an
  // expensive run leaves an itemised receipt, not just a total.
  const nodeCosts = new Map<string, NodeCost>(Object.entries(resume?.journal.nodeCosts ?? {}));
  const recordCost = (node: string, r: { cost: number; tokensIn: number; tokensOut: number }): void => {
    const entry = nodeCosts.get(node) ?? { runs: 0, cost: 0, tokensIn: 0, tokensOut: 0 };
    entry.runs += 1;
    entry.cost += r.cost;
    entry.tokensIn += r.tokensIn;
    entry.tokensOut += r.tokensOut;
    nodeCosts.set(node, entry);
  };

  const nodeMeta: NodeMeta[] = Object.entries(scene.nodes).map(([name, spec]) => ({
    node: name,
    model: spec.model ?? scene.defaults.model ?? "",
    runtime: runtimeOf(scene, spec),
    skills: spec.skills ?? [],
    mcp: spec.mcp ?? [],
  }));
  emit({ type: "run:start", runId: id, scene: scene.name, goal, nodes: nodeMeta });

  const hub = new ToolHub(root, servers);

  // The target still owed execution. Kept in step with the cursor so that
  // whenever we checkpoint, the journal names exactly what to run next.
  let resumeAt: string | undefined = scene.entry;
  // Set only while parked on an ask node; the journal carries it so the question
  // outlives the process.
  let pending: PendingAsk | undefined;

  const checkpoint = (stoppedBecause?: string): void => {
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
    writeFileSync(
      join(runDir, "costs.json"),
      JSON.stringify(
        { totalCost, nodeRuns, ...(budget !== undefined ? { budget } : {}), nodes: Object.fromEntries(nodeCosts) },
        null,
        2,
      ),
      "utf8",
    );
    const journal: Journal = {
      version: JOURNAL_VERSION,
      runId: id,
      scene: { file: scene.file, name: scene.name, hash: sceneHash },
      goal,
      ...(resumeAt !== undefined ? { resumeAt } : {}),
      ...(pending !== undefined ? { pending } : {}),
      edgeLoops: [...edgeLoops],
      nodeRuns,
      totalCost,
      nodeCosts: Object.fromEntries(nodeCosts),
      ...(stoppedBecause !== undefined ? { stoppedBecause } : {}),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(runDir, "journal.json"), JSON.stringify(journal, null, 2), "utf8");
  };

  const fail = (reason: string): RunResult => {
    checkpoint(reason);
    emit({ type: "run:end", ok: false, reason, state, totalCost, nodeRuns, ...(budget !== undefined ? { budget } : {}) });
    return { ok: false, reason, state, runDir, runId: id };
  };

  const ctx: NodeCallCtx = {
    scene,
    goal,
    state,
    hub,
    needsMcp: servers.length > 0,
    emit,
    budgetLeft: () => (budget === undefined ? undefined : Math.max(0, budget - totalCost)),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  try {
    let cursor: string | undefined = resume?.journal.resumeAt ?? scene.entry;

    // Resuming into an already-spent budget would burn a node before noticing,
    // so it is caught here rather than after the first target completes.
    if (budget !== undefined && totalCost >= budget) {
      return fail(
        `already at the budget: $${totalCost.toFixed(4)} spent of the $${budget} cap — ` +
          `resume with a higher --budget to continue`,
      );
    }

    while (cursor) {
      // Until this target's outputs merge it is still owed, so a stop here
      // resumes by re-running it whole.
      resumeAt = cursor;

      if (opts.signal?.aborted) return fail("run stopped");
      if (Date.now() > deadline) return fail(`wall-clock timeout after ${Math.round(timeoutMs / 60000)}m`);

      const members = resolveTarget(scene, cursor);
      nodeRuns += members.length;
      if (nodeRuns > maxNodeRuns) {
        return fail(`exceeded maxNodeRuns (${maxNodeRuns}) — the graph is likely looping; raise with --max-runs`);
      }

      const parallel = members.length > 1 || scene.groups[cursor] !== undefined;
      emit({ type: "target:start", target: cursor, members, parallel });

      // Group members read the same snapshot, so ordering between them cannot
      // change what any of them sees. Validation already barred output collisions.
      const snapshot: State = { ...state };
      const outcomes = await Promise.all(
        members.map((member) => runNode({ ...ctx, state: snapshot }, member)),
      );

      // A parked ask node stops the walk — but only after its siblings' work is
      // banked below, so nothing already paid for is lost to the pause.
      let parked: PendingAsk | undefined;

      for (const [index, outcome] of outcomes.entries()) {
        if ("pending" in outcome) {
          parked ??= outcome.pending;
          // An ask node never ran, so it must not count against maxNodeRuns.
          nodeRuns -= 1;
          continue;
        }
        if (outcome.result) {
          totalCost += outcome.result.cost;
          recordCost(members[index] ?? "?", outcome.result);
        }
        if ("error" in outcome) return fail(outcome.error);
        Object.assign(state, outcome.values);
      }

      if (parked) {
        // resumeAt already names this target, so answering and resuming re-enters
        // here — and the ask node then finds its outputs present and falls through.
        pending = parked;
        checkpoint(`waiting for an answer to "${parked.question}"`);
        emit({ type: "state", state: { ...state } });
        emit({ type: "node:ask", node: parked.node, question: parked.question, outputs: parked.outputs });
        emit({
          type: "run:end",
          ok: false,
          reason: `waiting on "${parked.node}"`,
          state,
          totalCost,
          nodeRuns,
          ...(budget !== undefined ? { budget } : {}),
          waiting: parked,
        });
        return { ok: false, reason: `waiting on "${parked.node}": ${parked.question}`, state, runDir, runId: id, waiting: parked };
      }

      checkpoint();
      emit({ type: "state", state: { ...state } });

      // Outgoing edges are consulted BEFORE the exit check, so a node can be both
      // the terminal node and a looping one. Terminating early here would make
      // any edge out of the exit node silently dead.
      let next: string | undefined;
      for (const [index, edge] of scene.edges.entries()) {
        const matchesSource = edge.from === cursor || members.includes(edge.from);
        if (!matchesSource) continue;

        if (edge.when) {
          let holds: boolean;
          try {
            holds = Boolean(edge.when({ ...state }));
          } catch (err) {
            return fail(
              `condition on ${edge.from}→${edge.to} threw: ${(err as Error).message} — ` +
                `when() must be a pure predicate over state`,
            );
          }
          if (!holds) continue;
        }

        if (edge.maxLoops !== undefined) {
          const taken = edgeLoops.get(index) ?? 0;
          if (taken >= edge.maxLoops) {
            emit({ type: "edge", from: edge.from, to: edge.to, skipped: true });
            continue;
          }
          edgeLoops.set(index, taken + 1);
        }

        next = edge.to;
        emit({ type: "edge", from: cursor, to: edge.to, ...(edge.when ? { when: conditionLabel(edge.when) } : {}) });
        break;
      }

      if (!next) {
        // Running out of edges at the exit — or anywhere, when no exit is
        // declared — is the normal way a run finishes.
        if (!scene.exit || cursor === scene.exit || members.includes(scene.exit)) {
          resumeAt = undefined; // reached the exit: nothing is owed
          break;
        }
        // Stuck instead: `resumeAt` still names this target, so fixing the
        // scene's edges and resuming retries from here.
        return fail(
          `node "${cursor}" has no matching outgoing edge and is not the exit ("${scene.exit}"). ` +
            `State keys: ${Object.keys(state).join(", ")}`,
        );
      }

      // The edge is taken: record the advanced position (and the loop counter it
      // just consumed) before spending anything on the next target.
      resumeAt = next;
      checkpoint();

      // The budget is a hard stop, not a warning: the run ends here with its
      // position journalled, rather than starting work it was told not to afford.
      if (budget !== undefined && totalCost >= budget) {
        return fail(
          `budget exhausted: spent $${totalCost.toFixed(4)} of the $${budget} cap — ` +
            `resume with \`ensemble resume ${runDir} --budget <higher>\``,
        );
      }

      cursor = next;
    }

    checkpoint();
    writeFileSync(join(runDir, "result.md"), renderResult(scene, state), "utf8");
    emit({ type: "run:end", ok: true, state, totalCost, nodeRuns, ...(budget !== undefined ? { budget } : {}) });

    return { ok: true, state, runDir, totalCost, runId: id };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    await hub.close();
  }
}

/** `(s) => s.verdict === "accept"` → `s.verdict === "accept"` for display. */
export function conditionLabel(fn: (state: State) => boolean): string {
  return String(fn)
    .replace(/^\s*\(?[\w$]*\)?\s*=>\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderResult(scene: Scene, state: State): string {
  const lines = [`# ${scene.name}`, "", `**Goal:** ${String(state["goal"] ?? "")}`, ""];
  for (const [key, value] of Object.entries(state)) {
    if (key === "goal") continue;
    const body = typeof value === "string" ? value : "```json\n" + JSON.stringify(value, null, 2) + "\n```";
    lines.push(`## ${key}`, "", body, "");
  }
  return lines.join("\n");
}
