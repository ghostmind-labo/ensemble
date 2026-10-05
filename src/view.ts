/**
 * The viewer: a run you can look at.
 *
 * The seam for anything visual is the two JSON documents and the live file, and
 * a renderer belongs outside this package. That is still true of every real
 * one. But reading a run should not require installing a second thing, and the
 * local loop (write, check, run, look) was missing its last step. So there is
 * exactly one page here, held to rules that keep it from becoming a product:
 * it is a single static document with no dependency and no build step, it only
 * reads, and it listens on this machine. Accounts, sharing, answering a paused
 * run from a browser and dashboards are the hosted product's job, not this
 * file's.
 *
 * It loads no runner. A project with several runners needs no configuration,
 * because each run's folder says which runner it was and which graph it ran
 * with: runs are grouped by name, and each distinct graph hash is a version.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { RunDoc } from "./execute.ts";
import type { GraphDoc } from "./graph.ts";
import { liveRuns, type LiveRun } from "./live.ts";
import { PAGE } from "./view-page.ts";

export interface ViewOptions {
  /** The project folder. Default: the current directory. Reads `<project>/.ensemble`. */
  project?: string;
  port?: number;
  /** Default 127.0.0.1. A run record holds what the run was given and wrote, so widen this on purpose. */
  host?: string;
}

export interface Viewing {
  url: string;
  dir: string;
  server: Server;
  close(): Promise<void>;
}

interface Recorded {
  id: string;
  doc: RunDoc;
  graph: GraphDoc | null;
}

const json = <T>(file: string): T | null => {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as T;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};

/** Every folder that holds a run document, oldest first. A folder without a readable run.json is skipped. */
function recordedRuns(runsDir: string, withGraphs: boolean): Recorded[] {
  if (!existsSync(runsDir)) return [];
  const found: Recorded[] = [];
  for (const id of readdirSync(runsDir)) {
    const folder = join(runsDir, id);
    try {
      if (!statSync(folder).isDirectory()) continue;
    } catch {
      continue;
    }
    const doc = json<RunDoc>(join(folder, "run.json"));
    if (!doc?.run || !Array.isArray(doc.steps)) continue;
    found.push({ id, doc, graph: withGraphs ? json<GraphDoc>(join(folder, "graph.json")) : null });
  }
  return found.sort((a, b) => String(a.doc.run.started).localeCompare(String(b.doc.run.started)));
}

/** A runner is what its runs say it is: a name, and one version per graph hash in the order they first ran. */
function versionsOf(runs: Recorded[]): Map<string, string[]> {
  const hashes = new Map<string, string[]>();
  for (const run of runs) {
    const list = hashes.get(run.doc.run.runner) ?? [];
    if (!list.includes(run.doc.run.graph)) list.push(run.doc.run.graph);
    hashes.set(run.doc.run.runner, list);
  }
  return hashes;
}

const span = (doc: RunDoc): number => Math.max(0, Date.parse(doc.run.ended) - Date.parse(doc.run.started)) || 0;

export async function view(options: ViewOptions = {}): Promise<Viewing> {
  const project = resolve(options.project ?? process.cwd());
  const dir = join(project, ".ensemble");
  const runsDir = join(dir, "runs");

  const row = (run: Recorded, versions: Map<string, string[]>) => ({
    id: run.id,
    runner: run.doc.run.runner,
    version: (versions.get(run.doc.run.runner)?.indexOf(run.doc.run.graph) ?? 0) + 1,
    status: run.doc.run.status,
    started: run.doc.run.started,
    ms: run.doc.run.status === "paused" ? null : span(run.doc),
    steps: run.doc.steps.length,
    cost: run.doc.run.cost?.total ?? 0,
    goal: run.doc.run.goal ?? "",
    live: false,
  });
  const liveRow = (run: LiveRun, versions: Map<string, string[]>) => ({
    id: `live:${run.id}`,
    runner: run.runner,
    version: versions.get(run.runner)?.length ?? 1,
    status: "running",
    started: run.started,
    ms: Date.now() - Date.parse(run.started),
    steps: run.steps.length,
    cost: run.cost,
    goal: String(run.state["goal"] ?? ""),
    live: true,
  });

  function overview() {
    const runs = recordedRuns(runsDir, true);
    const versions = versionsOf(runs);
    const live = liveRuns(dir);
    const names = new Set([...versions.keys(), ...live.map((run) => run.runner)]);
    return {
      project,
      runsDir,
      found: existsSync(runsDir),
      live: live.map((run) => liveRow(run, versions)).reverse(),
      runs: runs.map((run) => row(run, versions)).reverse().slice(0, 300),
      runners: [...names]
        .map((name) => {
          const own = runs.filter((run) => run.doc.run.runner === name);
          const last = own[own.length - 1];
          return {
            name,
            description: last?.graph?.runner.description ?? "",
            versions: versions.get(name)?.length ?? 0,
            nodes: last?.graph?.nodes.length ?? 0,
            runs: own.length,
            live: live.filter((run) => run.runner === name).length,
            cost: own.reduce((sum, run) => sum + (run.doc.run.cost?.total ?? 0), 0),
            last: last?.doc.run.started ?? live.find((run) => run.runner === name)?.started ?? "",
          };
        })
        .sort((a, b) => b.last.localeCompare(a.last)),
    };
  }

  function oneRun(id: string) {
    const runs = recordedRuns(runsDir, true);
    const versions = versionsOf(runs);
    if (id.startsWith("live:")) {
      const live = liveRuns(dir).find((run) => `live:${run.id}` === id);
      if (!live) return undefined;
      // A live run has not written its graph yet: the runner's latest recorded one is shown, and said to be so.
      const last = runs.filter((run) => run.doc.run.runner === live.runner && run.graph).pop();
      return {
        ...liveRow(live, versions),
        graph: last?.graph ?? null,
        graphFrom: last ? "the runner's latest recorded run" : null,
        steps: live.steps.map((step, index) => ({ n: index + 1, ...step })),
        running: live.running,
        state: live.state,
        inputs: Object.fromEntries((last?.graph?.runner.inputs ?? ["goal"]).filter((key) => key in live.state).map((key) => [key, live.state[key]])),
        result: null,
        error: null,
        pending: null,
      };
    }
    const run = runs.find((candidate) => candidate.id === id);
    if (!run) return undefined;
    const { doc, graph } = run;
    const resultKey = graph?.runner.result;
    const inputs: Record<string, unknown> = {};
    for (const key of graph?.runner.inputs ?? ["goal"]) if (doc.state && key in doc.state) inputs[key] = doc.state[key];
    if (!("goal" in inputs) && doc.run.goal) inputs["goal"] = doc.run.goal;
    return {
      ...row(run, versions),
      graph,
      graphFrom: null,
      steps: doc.steps,
      running: [],
      state: doc.state,
      inputs,
      result: resultKey && doc.state && resultKey in doc.state ? doc.state[resultKey] : null,
      error: doc.steps.find((step) => step.error)?.error ?? null,
      pending: doc.pending ?? null,
    };
  }

  function oneRunner(name: string) {
    const runs = recordedRuns(runsDir, true);
    const versions = versionsOf(runs);
    const own = runs.filter((run) => run.doc.run.runner === name);
    const live = liveRuns(dir).filter((run) => run.runner === name);
    if (!own.length && !live.length) return undefined;
    const last = [...own].reverse().find((run) => run.graph) ?? own[own.length - 1];
    return {
      name,
      description: last?.graph?.runner.description ?? "",
      graph: last?.graph ?? null,
      versions: (versions.get(name) ?? []).map((hash, index) => ({ version: index + 1, hash, runs: own.filter((run) => run.doc.run.graph === hash).length })).reverse(),
      live: live.map((run) => liveRow(run, versions)),
      runs: own.map((run) => row(run, versions)).reverse().slice(0, 200),
    };
  }

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "The viewer is read-only: it shows runs, it does not start or change anything." });
      if (url.pathname === "/api/overview") return send(200, overview());
      if (url.pathname === "/api/run") {
        const found = oneRun(url.searchParams.get("id") ?? "");
        return found ? send(200, found) : send(404, { error: "No such run. It may have ended: look for it under Runs." });
      }
      if (url.pathname === "/api/runner") {
        const found = oneRunner(url.searchParams.get("name") ?? "");
        return found ? send(200, found) : send(404, { error: "No run of a runner with that name here." });
      }
      if (url.pathname.startsWith("/api/")) return send(404, { error: `The viewer has no ${url.pathname}.` });
      // One page, whatever the path: the page routes itself.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(PAGE);
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 4400, options.host ?? "127.0.0.1", () => done());
  });
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://${address.includes(":") ? `[${address}]` : address}:${port}`,
    dir,
    server,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
