/**
 * The graph executor — v2.
 *
 * Not a topological sort — cycles are the point (a critic sending work back to
 * the researcher). Execution is a cursor that walks from `entry`, running one
 * target at a time, then consulting outgoing edges to pick the next. A target is
 * either a single node or a group, and a group's members run concurrently.
 *
 * Two runtimes, chosen per node:
 *   - "model": direct OpenRouter fetch. Streams real token deltas.
 *   - "agent": a scoped opencode agent (tools, skills, MCP).
 * opencode is spawned lazily, on the first agent node — a scene of pure model
 * nodes never pays for it.
 *
 * The engine only emits events; rendering lives in reporter.ts and serve.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Scene, NodeSpec } from "./scene.ts";
import { resolveTarget, runtimeOf } from "./scene.ts";
import { loadRegistry } from "./registry.ts";
import { compileScene, type Compilation } from "./compile.ts";
import { Runtime, type NodeResult } from "./runtimes/agent.ts";
import { callModel } from "./runtimes/model.ts";
import {
  extractOutputs,
  renderInputs,
  outputContract,
  detectLossyExtraction,
  type State,
} from "./state.ts";
import type { EventSink, NodeMeta } from "./events.ts";

export interface RunOptions {
  port?: number;
  maxNodeRuns?: number;
  timeoutMs?: number;
  /** Receives every run event. Omit for a silent run. */
  onEvent?: EventSink;
  /** Aborts the run; model nodes abort mid-stream, agent nodes between nodes. */
  signal?: AbortSignal;
}

export type RunResult =
  | { ok: true; state: State; runDir: string; totalCost: number; runId: string }
  | { ok: false; reason: string; state: State; runDir: string; runId: string };

/** Stable, sortable, and filesystem-safe: 20260809-191245-researchflow */
function runId(scene: Scene): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${scene.name}`
  );
}

function buildPrompt(scene: Scene, node: string, goal: string, state: State): string {
  const spec = scene.nodes[node];
  if (!spec) throw new Error(`no such node: ${node}`);

  const sections = [`## Goal\n\n${goal}`];
  const context = renderInputs(state, spec.inputs ?? []);
  if (context) sections.push(context);
  const contract = outputContract(spec.outputs ?? []);
  if (contract) sections.push(contract);
  return sections.join("\n\n");
}

/** Lazily-started opencode, shared by every agent node in the run. */
class AgentPool {
  private runtime: Runtime | undefined;
  private starting: Promise<Runtime> | undefined;
  private root: string;
  private port: number | undefined;

  constructor(root: string, port: number | undefined) {
    this.root = root;
    this.port = port;
  }

  get(): Promise<Runtime> {
    if (this.runtime) return Promise.resolve(this.runtime);
    // Single-flight: parallel agent nodes must not each spawn a server.
    this.starting ??= Runtime.start(this.root, this.port).then((rt) => {
      this.runtime = rt;
      return rt;
    });
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
  pool: AgentPool;
  compilation: Compilation;
  emit: EventSink;
  signal?: AbortSignal;
}

/** One attempt against whichever runtime the node declared. */
async function callOnce(
  ctx: NodeCallCtx,
  node: string,
  spec: NodeSpec,
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  sessionID: string | undefined,
): Promise<NodeResult & { sessionID?: string }> {
  const model = spec.model ?? ctx.scene.defaults.model ?? "";
  const temperature = spec.temperature ?? ctx.scene.defaults.temperature;

  if (runtimeOf(ctx.scene, spec) === "model") {
    const res = await callModel({
      model,
      ...(spec.prompt ? { system: spec.prompt } : {}),
      messages: [...history, { role: "user", content: text }],
      ...(temperature !== undefined ? { temperature } : {}),
      onDelta: (delta) => ctx.emit({ type: "node:delta", node, delta }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return res;
  }

  const agent = ctx.compilation.agents.get(node);
  if (!agent) throw new Error(`node "${node}" was not compiled`);
  const runtime = await ctx.pool.get();
  return runtime.prompt({ agent: agent.agentName, model, text, ...(sessionID ? { sessionID } : {}) });
}

/**
 * Runs one node, retrying once if the output contract was not met. The retry
 * carries the failed attempt in context (session for agents, message history for
 * model calls) so the model sees what it did wrong.
 */
async function runNode(
  ctx: NodeCallCtx,
  node: string,
): Promise<{ values: State; result: NodeResult } | { error: string; result?: NodeResult }> {
  const spec = ctx.scene.nodes[node];
  if (!spec) return { error: `no such node: ${node}` };

  const model = spec.model ?? ctx.scene.defaults.model ?? "";
  const started = Date.now();
  ctx.emit({ type: "node:start", node, model, skills: spec.skills ?? [] });

  const firstPrompt = buildPrompt(ctx.scene, node, ctx.goal, ctx.state);
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let sessionID: string | undefined;
  let parseProblem: string | undefined;
  let last: NodeResult | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const text =
      attempt === 1
        ? firstPrompt
        : `Your previous reply could not be parsed: ${parseProblem ?? "invalid output"}\n\n` +
          `Reply again with ONLY the required json block.`;

    let res: NodeResult & { sessionID?: string };
    try {
      res = await callOnce(ctx, node, spec, text, history, sessionID);
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

    sessionID = res.sessionID;
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

    const extraction = extractOutputs(res.text, spec.outputs ?? []);

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

  const registry = loadRegistry();
  const root = resolve(process.cwd());

  // Agents are only compiled — and opencode only ever started — if some node needs it.
  const hasAgentNodes = Object.values(scene.nodes).some((n) => runtimeOf(scene, n) === "agent");
  const compilation: Compilation = hasAgentNodes
    ? compileScene(scene, registry)
    : { root, agentDir: "", agents: new Map() };

  const id = runId(scene);
  const runDir = join(root, ".ensemble", "runs", id);
  mkdirSync(runDir, { recursive: true });

  const state: State = { goal };
  let totalCost = 0;
  let nodeRuns = 0;
  const edgeLoops = new Map<number, number>();
  const deadline = Date.now() + timeoutMs;

  const nodeMeta: NodeMeta[] = Object.entries(scene.nodes).map(([name, spec]) => ({
    node: name,
    model: spec.model ?? scene.defaults.model ?? "",
    runtime: runtimeOf(scene, spec),
    skills: spec.skills ?? [],
    mcp: spec.mcp ?? [],
  }));
  emit({ type: "run:start", runId: id, scene: scene.name, goal, nodes: nodeMeta });

  const pool = new AgentPool(root, opts.port);
  const checkpoint = (): void => {
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
  };

  const fail = (reason: string): RunResult => {
    checkpoint();
    emit({ type: "run:end", ok: false, reason, state, totalCost, nodeRuns });
    return { ok: false, reason, state, runDir, runId: id };
  };

  const ctx: NodeCallCtx = {
    scene,
    goal,
    state,
    pool,
    compilation,
    emit,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  try {
    let cursor: string | undefined = scene.entry;

    while (cursor) {
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

      for (const outcome of outcomes) {
        if (outcome.result) totalCost += outcome.result.cost;
        if ("error" in outcome) return fail(outcome.error);
        Object.assign(state, outcome.values);
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
        if (!scene.exit || cursor === scene.exit || members.includes(scene.exit)) break;
        return fail(
          `node "${cursor}" has no matching outgoing edge and is not the exit ("${scene.exit}"). ` +
            `State keys: ${Object.keys(state).join(", ")}`,
        );
      }

      cursor = next;
    }

    checkpoint();
    writeFileSync(join(runDir, "result.md"), renderResult(scene, state), "utf8");
    emit({ type: "run:end", ok: true, state, totalCost, nodeRuns });

    return { ok: true, state, runDir, totalCost, runId: id };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    await pool.close();
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
