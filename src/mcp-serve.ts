/**
 * Ensemble as an MCP server — `ensemble mcp serve`.
 *
 * The consumer this is for is an agent orchestrating runs: start a scene and get
 * the runId back immediately, poll status while doing other work, peek at the
 * blackboard mid-run, stop a run that is going sideways, resume it with a higher
 * budget once the partial state earns it.
 *
 * The design leans entirely on the run-directory artifacts: every checkpoint
 * already writes state.json / costs.json / journal.json, so "peek" and "status"
 * are file reads, and "stop" is safe because resume exists. The server holds
 * nothing but an AbortController per live run — if this process dies, in-flight
 * runs die *resumably*, the same failure story as everywhere else.
 *
 * stdio discipline: the transport owns stdout. Nothing here may print; the
 * engine only emits events to the sink we give it.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadRegistry } from "./registry.ts";
import { loadScene, SceneError } from "./scene.ts";
import { runScene, readJournal, hashScene, type Journal, type RunResult } from "./engine.ts";
import type { RunEvent } from "./events.ts";
import type { State } from "./state.ts";

interface LiveRun {
  abort: AbortController;
  promise: Promise<RunResult>;
  result?: RunResult;
  sceneName: string;
  goal: string;
  startedAt: number;
  /** Small ring of recent events, so status can say what is happening right now. */
  recent: RunEvent[];
}

const RECENT_EVENTS = 20;

/** Tool results are always one JSON text block — uniform and machine-readable. */
function json(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function failure(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { ...json({ error: message }), isError: true };
}

function sceneProblems(err: unknown): string {
  return err instanceof SceneError ? err.problems.join("; ") : err instanceof Error ? err.message : String(err);
}

function readRunFile<T>(runDir: string, file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(join(runDir, file), "utf8")) as T;
  } catch {
    // Mid-write or absent — the caller treats undefined as "retry shortly".
    return undefined;
  }
}

/** One-line view of a recent event, compact enough to put in a status reply. */
function eventLine(e: RunEvent): string | undefined {
  switch (e.type) {
    case "target:start":
      return `▶ ${e.target}${e.parallel ? ` (${e.members.length} in parallel)` : ""}`;
    case "node:end":
      return `${e.ok ? "✓" : "✗"} ${e.node} · $${e.cost.toFixed(4)}${e.error ? ` · ${e.error.slice(0, 120)}` : ""}`;
    case "node:tool":
      return `⚒ ${e.node}:${e.tool}`;
    case "edge":
      return e.skipped ? `⟲ ${e.from}→${e.to} maxLoops spent` : `→ ${e.to}`;
    case "run:end":
      return e.ok ? "done" : `stopped: ${e.reason ?? "?"}`;
    default:
      return undefined;
  }
}

export function buildEnsembleServer(root = process.cwd()): McpServer {
  const cwd = resolve(root);
  const runsDir = join(cwd, ".ensemble", "runs");
  const live = new Map<string, LiveRun>();

  const version = (() => {
    try {
      return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
    } catch {
      return "0.0.0";
    }
  })();
  const server = new McpServer({ name: "ensemble", version });

  /**
   * Launches a (fresh or resumed) run without awaiting it, returning as soon as
   * the engine has minted the runId — before any token is spent.
   */
  async function launch(
    scene: Awaited<ReturnType<typeof loadScene>>,
    goal: string,
    opts: { budget?: number; resumeFrom?: ReturnType<typeof readJournal> },
  ): Promise<{ runId: string }> {
    const abort = new AbortController();
    const recent: RunEvent[] = [];

    let announce: (id: string) => void = () => {};
    const announced = new Promise<string>((r) => (announce = r));

    const promise = runScene(scene, goal, {
      ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
      ...(opts.resumeFrom ? { resumeFrom: opts.resumeFrom } : {}),
      signal: abort.signal,
      onEvent: (e) => {
        if (e.type === "run:start") announce(e.runId);
        recent.push(e);
        if (recent.length > RECENT_EVENTS) recent.shift();
      },
    });

    // run:start fires before any model call; racing with the promise covers a
    // failure so early that no start event was ever emitted.
    const runId = await Promise.race([announced, promise.then((r) => r.runId)]);

    const handle: LiveRun = { abort, promise, sceneName: scene.name, goal, startedAt: Date.now(), recent };
    live.set(runId, handle);
    void promise.then((r) => (handle.result = r)).catch(() => {});
    return { runId };
  }

  function statusOf(runId: string): Record<string, unknown> | undefined {
    const runDir = join(runsDir, runId);
    const handle = live.get(runId);
    const journal = readRunFile<Journal>(runDir, "journal.json");
    if (!handle && !journal) return undefined;

    const running = handle !== undefined && handle.result === undefined;
    const status = running
      ? "running"
      : handle?.result?.ok === true || (journal && journal.resumeAt === undefined)
        ? "completed"
        : "stopped"; // early stop — resumable

    return {
      runId,
      status,
      scene: journal?.scene.name ?? handle?.sceneName,
      goal: journal?.goal ?? handle?.goal,
      ...(journal
        ? {
            position: journal.resumeAt ?? "exit",
            nodeRuns: journal.nodeRuns,
            totalCost: journal.totalCost,
            ...(journal.stoppedBecause ? { stoppedBecause: journal.stoppedBecause } : {}),
          }
        : {}),
      ...(handle?.result?.ok === false ? { reason: handle.result.reason } : {}),
      ...(status === "stopped" ? { resumable: true, resumeHint: `resume_run with runId "${runId}"` } : {}),
      ...(running && handle
        ? { recentActivity: handle.recent.map(eventLine).filter(Boolean).slice(-8) }
        : {}),
      runDir,
    };
  }

  server.registerTool(
    "validate_scene",
    {
      description:
        "Validate a scene file WITHOUT running it (free — no tokens spent). Always call this after writing or editing a scene, before run_scene.",
      inputSchema: { file: z.string().describe("Path to the scene .mts/.ts file") },
    },
    async ({ file }) => {
      try {
        const scene = await loadScene(file, loadRegistry());
        return json({
          valid: true,
          name: scene.name,
          nodes: Object.keys(scene.nodes).length,
          groups: Object.keys(scene.groups).length,
          edges: scene.edges.length,
          entry: scene.entry,
          ...(scene.exit ? { exit: scene.exit } : {}),
        });
      } catch (err) {
        return json({ valid: false, problems: err instanceof SceneError ? err.problems : [String(err)] });
      }
    },
  );

  server.registerTool(
    "run_scene",
    {
      description:
        "Start a scene against a goal. Returns the runId IMMEDIATELY — the run continues in the background; poll run_status. Set budget (USD) to cap spend; a budget-stopped run is resumable.",
      inputSchema: {
        file: z.string().describe("Path to the scene file"),
        goal: z.string().describe("The goal the scene runs against"),
        budget: z.number().positive().optional().describe("Hard USD cap for the run"),
      },
    },
    async ({ file, goal, budget }) => {
      let scene;
      try {
        scene = await loadScene(file, loadRegistry());
      } catch (err) {
        return failure(`invalid scene: ${sceneProblems(err)}`);
      }
      const { runId } = await launch(scene, goal, { ...(budget !== undefined ? { budget } : {}) });
      return json({ runId, scene: scene.name, started: true, next: "poll run_status; peek_state reads the blackboard mid-run" });
    },
  );

  server.registerTool(
    "run_status",
    {
      description:
        "Status of a run: running/completed/stopped, current graph position, node runs, cumulative cost, stop reason, and recent activity while running.",
      inputSchema: { runId: z.string().describe("The runId returned by run_scene / list_runs") },
    },
    async ({ runId }) => {
      const status = statusOf(runId);
      return status ? json(status) : failure(`no such run: ${runId}`);
    },
  );

  server.registerTool(
    "peek_state",
    {
      description:
        "Read the run's state blackboard (checkpointed after every node — works mid-run). Optionally select keys; long values are clipped.",
      inputSchema: {
        runId: z.string(),
        keys: z.array(z.string()).optional().describe("Only these state keys (default: all)"),
        maxChars: z.number().int().positive().optional().describe("Clip each value to this many chars (default 2000)"),
      },
    },
    async ({ runId, keys, maxChars }) => {
      const state = readRunFile<State>(join(runsDir, runId), "state.json");
      if (!state) return failure(`no readable state for run ${runId} (checkpoint mid-write? retry)`);
      const clip = maxChars ?? 2000;
      const picked = Object.entries(state).filter(([k]) => !keys || keys.includes(k));
      const out: Record<string, unknown> = {};
      for (const [k, v] of picked) {
        const text = typeof v === "string" ? v : JSON.stringify(v);
        out[k] = text.length > clip ? `${text.slice(0, clip)}… [${text.length} chars total]` : v;
      }
      return json({ runId, keys: Object.keys(state), state: out });
    },
  );

  server.registerTool(
    "stop_run",
    {
      description:
        "Stop a running run. Safe: the position is journalled, so the run can be continued later with resume_run — nothing already paid for is lost.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      const handle = live.get(runId);
      if (!handle) return failure(`run ${runId} is not live in this server`);
      if (handle.result) return json({ runId, alreadyFinished: true, ok: handle.result.ok });
      handle.abort.abort();
      // The engine aborts mid-stream / between turns; give it a moment to journal.
      const result = await Promise.race([
        handle.promise,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 8000)),
      ]);
      return json({
        runId,
        stopped: true,
        journalled: result !== undefined,
        resumable: true,
        next: `resume_run with runId "${runId}" continues from the checkpoint`,
      });
    },
  );

  server.registerTool(
    "resume_run",
    {
      description:
        "Continue a stopped run from its checkpoint — skips everything already paid for; cost stays cumulative in the same run dir. Budget (if given) is the new TOTAL cap.",
      inputSchema: {
        runId: z.string(),
        budget: z.number().positive().optional().describe("New cumulative USD cap"),
      },
    },
    async ({ runId, budget }) => {
      const handle = live.get(runId);
      if (handle && !handle.result) return failure(`run ${runId} is still running — stop_run first`);

      let resumeFrom;
      try {
        resumeFrom = readJournal(join(runsDir, runId));
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }

      let scene;
      try {
        scene = await loadScene(resumeFrom.journal.scene.file, loadRegistry());
      } catch (err) {
        return failure(`the scene this run came from is no longer valid: ${sceneProblems(err)}`);
      }

      const sceneChanged = hashScene(resumeFrom.journal.scene.file) !== resumeFrom.journal.scene.hash;
      await launch(scene, resumeFrom.journal.goal, {
        resumeFrom,
        ...(budget !== undefined ? { budget } : {}),
      });
      return json({
        runId,
        resumed: true,
        at: resumeFrom.journal.resumeAt,
        spentSoFar: resumeFrom.journal.totalCost,
        ...(sceneChanged ? { warning: "scene file changed since the run started — maxLoops counters are keyed by edge order and may no longer line up" } : {}),
        next: "poll run_status",
      });
    },
  );

  server.registerTool(
    "list_runs",
    {
      description: "List runs in this project, newest first: status, scene, spend, and whether each is resumable.",
      inputSchema: { limit: z.number().int().positive().optional().describe("Max runs to return (default 10)") },
    },
    async ({ limit }) => {
      if (!existsSync(runsDir)) return json({ runs: [] });
      const ids = readdirSync(runsDir).sort().reverse().slice(0, limit ?? 10);
      const runs = ids.map((id) => statusOf(id)).filter(Boolean);
      return json({ runs });
    },
  );

  return server;
}

/** Blocks forever serving MCP over stdio — the transport owns the process. */
export async function serveMcpStdio(): Promise<never> {
  const server = buildEnsembleServer();
  await server.connect(new StdioServerTransport());
  return new Promise<never>(() => {});
}
