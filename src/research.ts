/**
 * Research mode — Karpathy's autoresearch loop as a first-class scene pattern.
 *
 * The pattern is four rules, and each one is enforced by this module rather
 * than left to the prompt:
 *
 *   1. ONE mutable artefact. `research.edit` names the file(s) an agent may
 *      change. Agent nodes in a research scene get `write_file`/`edit_file`
 *      built-ins that refuse every other path. Outside research mode agents
 *      have no write tools at all — the grant exists only because the scene
 *      declared exactly what may be edited.
 *   2. A FIXED budget per experiment. `research.measure` runs under
 *      `research.budget`; overrunning is a failed experiment, not a longer one,
 *      so results stay comparable.
 *   3. ONE scalar metric computed by code. The metric is parsed from the
 *      measure command's output — never judged by a model. A judge adds its
 *      own variance and an optimiser cannot tell "it improved" from "the judge
 *      felt different today".
 *   4. KEEP or REVERT, and write it down. The `experiment` runtime snapshots
 *      the incumbent, measures the candidate, keeps it only if it clears the
 *      noise floor (`threshold`), restores the incumbent otherwise, and
 *      appends one line to `results.tsv` either way.
 *
 * A research scene is still an ordinary scene: the proposer is any agent node,
 * the loop is an ordinary edge with `maxLoops`, and nothing here touches the
 * engine. `experiment` is a runtime OBJECT like `fn`; the write tools are
 * ordinary built-in tool objects, assembled per node with a path allowlist.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { State } from "./dsl.ts";
import type { BuiltinTool } from "./tools/builtin.ts";
import type { RuntimeObject } from "./runtimes/index.ts";
import { registerCapability, type CapabilityObject } from "./capabilities.ts";

export interface ResearchSpec {
  /** The one thing an agent may change — a path, or a few, relative to the project root. */
  edit: string | string[];
  /** Shell command that runs one experiment and prints the metric. */
  measure: string;
  /**
   * Name of the metric to parse from the measure output, e.g. "val_bpb". The
   * last line matching `<metric>[:= ]<number>` (or a JSON line with that key)
   * wins. Unset: the last number on the last non-empty line of output.
   */
  metric?: string;
  /** true → lower is better (a loss); false (default) → higher is better. */
  minimize?: boolean;
  /** Wall-clock cap per experiment: "5m", "90s", or a number of seconds. Default "5m". */
  budget?: string | number;
  /**
   * Noise floor: a candidate must beat the incumbent by MORE than this to be
   * kept. Ties revert. Default 0 — set it once you have seen the run-to-run
   * spread of your metric, or the loop will "discover" sampling luck.
   */
  threshold?: number;
  /** Where the audit trail goes, relative to the project root. Default "results.tsv". */
  log?: string;
}

export const researchSchema = z
  .object({
    edit: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    measure: z.string().min(1),
    metric: z.string().min(1).optional(),
    minimize: z.boolean().optional(),
    budget: z.union([z.string(), z.number().positive()]).optional(),
    threshold: z.number().min(0).optional(),
    log: z.string().min(1).optional(),
  })
  .strict();

export const editTargets = (r: ResearchSpec): string[] => (Array.isArray(r.edit) ? r.edit : [r.edit]);

/** "5m" | "90s" | "2h" | 300 → milliseconds. */
export function parseBudget(b: string | number | undefined): number {
  if (b === undefined) return 5 * 60_000;
  if (typeof b === "number") return b * 1000;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(b.trim());
  if (!m) throw new Error(`research.budget "${b}" is not a duration — use "5m", "90s" or seconds as a number`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  return unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
}

/**
 * Pulls the scalar out of the measure output. Deliberately forgiving about
 * format (a script can print `val_bpb: 1.23`, `val_bpb=1.23`, or a JSON line)
 * and deliberately strict about WHICH number: the last occurrence, so a script
 * that logs the metric every step reports its final value.
 */
export function parseMetric(output: string, metric?: string): number | undefined {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  if (metric) {
    const re = new RegExp(`(?:^|[^\\w])${metric.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?(?:e-?\\d+)?)`, "i");
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = re.exec(lines[i]!);
      if (m) return Number(m[1]);
    }
    return undefined;
  }
  const last = lines.at(-1);
  if (!last) return undefined;
  const nums = last.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g);
  return nums ? Number(nums.at(-1)) : undefined;
}

export interface MeasureResult {
  score?: number;
  output: string;
  ms: number;
  timedOut: boolean;
  exitCode: number | null;
}

/** Runs the measure command under the budget; never throws — a crash is a result. */
export function measure(r: ResearchSpec, root: string, signal?: AbortSignal): Promise<MeasureResult> {
  const budgetMs = parseBudget(r.budget);
  return new Promise((done) => {
    const started = Date.now();
    // Detached = its own process group, so the kill reaches everything the
    // shell started. Killing only the shell would leave a training script
    // running past the budget with the pipes still open.
    const child = spawn(r.measure, { cwd: root, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };
    let output = "";
    let timedOut = false;
    const keep = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5000).unref();
    }, budgetMs);
    const onAbort = (): void => kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const score = timedOut ? undefined : parseMetric(output, r.metric);
      done({ ...(score !== undefined && Number.isFinite(score) ? { score } : {}), output, ms: Date.now() - started, timedOut, exitCode });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ output: `${output}\n${err.message}`, ms: Date.now() - started, timedOut, exitCode: null });
    });
  });
}

/* ───────────────────────── the incumbent snapshot ───────────────────────── */

const incumbentDir = (runDir: string): string => join(runDir, "research");
const incumbentPath = (runDir: string, i: number, target: string): string => join(incumbentDir(runDir), `${i}-${basename(target)}`);
const hasIncumbent = (r: ResearchSpec, runDir: string): boolean =>
  editTargets(r).every((t, i) => existsSync(incumbentPath(runDir, i, t)));
const snapshotIncumbent = (r: ResearchSpec, root: string, runDir: string): void => {
  mkdirSync(incumbentDir(runDir), { recursive: true });
  editTargets(r).forEach((t, i) => copyFileSync(resolve(root, t), incumbentPath(runDir, i, t)));
};
const restoreIncumbent = (r: ResearchSpec, root: string, runDir: string): void =>
  editTargets(r).forEach((t, i) => copyFileSync(incumbentPath(runDir, i, t), resolve(root, t)));
/** Takes the snapshot exactly once per run — whoever gets there first. */
const ensureIncumbent = (r: ResearchSpec, root: string, runDir: string): void => {
  if (!hasIncumbent(r, runDir)) snapshotIncumbent(r, root, runDir);
};

/* ───────────────────────── scoped write tools ───────────────────────── */

function allowed(root: string, r: ResearchSpec, candidate: string): string {
  const abs = resolve(root, candidate);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || rel.split(sep)[0] === "..") throw new Error(`path escapes the project root: ${candidate}`);
  const ok = editTargets(r).some((t) => resolve(root, t) === abs);
  if (!ok) {
    throw new Error(
      `refused: research.edit allows only ${editTargets(r).map((t) => `"${t}"`).join(", ")} — ` +
        `"${candidate}" is not the artefact under study`,
    );
  }
  return abs;
}

/**
 * The ONLY write tools an agent ever gets, and only in a research scene.
 *
 * `runDir` lets the tools stash the incumbent before the first write of a run,
 * so "revert" always has something to revert TO — even when the proposer runs
 * before any experiment node has (a seeded `best`, a resumed run).
 */
export function researchTools(r: ResearchSpec, runDir?: string): BuiltinTool[] {
  const targets = editTargets(r).join(", ");
  const guard = (root: string): void => {
    if (runDir) ensureIncumbent(r, root, runDir);
  };
  return [
    {
      name: "write_file",
      description: `Replace the entire contents of the artefact under study (${targets}). No other path is writable.`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: `One of: ${targets}` },
          content: { type: "string", description: "The complete new file contents" },
        },
        required: ["path", "content"],
      },
      run: (args, root) => {
        const file = allowed(root, r, String(args["path"] ?? ""));
        guard(root);
        writeFileSync(file, String(args["content"] ?? ""), "utf8");
        return `wrote ${relative(root, file)} (${String(args["content"] ?? "").length} chars)`;
      },
    },
    {
      name: "edit_file",
      description:
        `Replace one exact, unique snippet in the artefact under study (${targets}) with new text. ` +
        `Fails if the snippet is missing or appears more than once — widen it to disambiguate.`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: `One of: ${targets}` },
          find: { type: "string", description: "Exact text to replace (must occur exactly once)" },
          replace: { type: "string", description: "Replacement text" },
        },
        required: ["path", "find", "replace"],
      },
      run: (args, root) => {
        const file = allowed(root, r, String(args["path"] ?? ""));
        const find = String(args["find"] ?? "");
        if (!find) return "find must not be empty";
        const body = readFileSync(file, "utf8");
        const first = body.indexOf(find);
        if (first === -1) return `snippet not found in ${relative(root, file)} — read the file and copy the text exactly`;
        if (body.indexOf(find, first + 1) !== -1) return `snippet occurs more than once in ${relative(root, file)} — include more surrounding text`;
        guard(root);
        writeFileSync(file, body.slice(0, first) + String(args["replace"] ?? "") + body.slice(first + find.length), "utf8");
        return `edited ${relative(root, file)}`;
      },
    },
  ];
}

/* ───────────────────────── the experiment runtime ───────────────────────── */

export interface ExperimentArgs {
  node: string;
  spec: { note?: string };
  state: State;
  research: ResearchSpec;
  root: string;
  runDir: string;
  signal?: AbortSignal;
}

const tsv = (v: unknown): string => String(v ?? "").replace(/[\t\n\r]+/g, " ").trim();

/**
 * One experiment: measure what is on disk now, decide, record.
 *
 * First entry (no `best` in state) is the BASELINE: whatever is on disk is
 * measured and snapshotted as the incumbent — nothing to keep or revert. Every
 * later entry measures the proposer's candidate against that incumbent.
 */
export async function runExperiment(a: ExperimentArgs): Promise<State> {
  const { research: r, root, runDir, state } = a;
  const minimize = r.minimize === true;
  const threshold = r.threshold ?? 0;
  const iteration = (Number(state["iteration"]) || 0) + 1;
  const baseline = state["best"] === undefined;
  const snapshot = (): void => snapshotIncumbent(r, root, runDir);
  const restore = (): void => restoreIncumbent(r, root, runDir);

  // The baseline IS the incumbent. Otherwise the write tools stashed it before
  // the proposer's first edit; if nothing was edited, what is on disk is it.
  if (baseline) snapshot();
  else ensureIncumbent(r, root, runDir);

  const m = await measure(r, root, a.signal);
  const previousBest = baseline ? undefined : Number(state["best"]);
  const better = (candidate: number, best: number): boolean =>
    minimize ? best - candidate > threshold : candidate - best > threshold;

  let verdict: "baseline" | "keep" | "revert" | "crash";
  let best = previousBest;
  if (m.score === undefined) {
    verdict = "crash";
    if (!baseline) restore();
  } else if (baseline) {
    verdict = "baseline";
    best = m.score;
  } else if (better(m.score, previousBest as number)) {
    verdict = "keep";
    best = m.score;
    snapshot();
  } else {
    verdict = "revert";
    restore();
  }

  const reason = m.timedOut
    ? `exceeded the ${typeof r.budget === "number" ? `${r.budget}s` : (r.budget ?? "5m")} budget`
    : m.score === undefined
      ? `no "${r.metric ?? "metric"}" in the output (exit ${m.exitCode})`
      : verdict === "revert"
        ? `${m.score} did not beat ${previousBest} by more than ${threshold}`
        : "";

  const note = a.spec.note ? tsv(state[a.spec.note]) : "";
  const logFile = resolve(root, r.log ?? "results.tsv");
  if (!existsSync(logFile)) writeFileSync(logFile, "iteration\tscore\tbest\tverdict\tms\tnote\n", "utf8");
  appendFileSync(logFile, [iteration, m.score ?? "", best ?? "", verdict, m.ms, note].map(tsv).join("\t") + "\n", "utf8");

  const tail = m.output.trim().split("\n").slice(-40).join("\n");
  return {
    iteration,
    ...(m.score !== undefined ? { score: m.score } : {}),
    ...(best !== undefined ? { best } : {}),
    verdict,
    kept: verdict === "keep" || verdict === "baseline",
    reason,
    output: tail,
    summary: baseline
      ? `baseline ${m.score ?? "crash"} (${Math.round(m.ms / 1000)}s)`
      : `${verdict} · score ${m.score ?? "—"} vs best ${previousBest}${reason ? ` — ${reason}` : ""}`,
  };
}

export const experimentRuntime: RuntimeObject = {
  name: "experiment",
  summary: "measure the artefact under study, keep or revert, log it — the autoresearch step",
  badge: "🔬",
  needsModel: false,
  fields: {
    /** State key whose value is written to the results log as the note (e.g. the proposer's "hypothesis"). */
    note: z.string(),
  },
  check: (name, spec, scene) => {
    const problems: string[] = [];
    if ((spec.outputs ?? []).length === 0) {
      problems.push(`node "${name}" is runtime "experiment" but declares no outputs — declare at least ["verdict"]`);
    }
    if (!scene.research) {
      problems.push(`node "${name}" is runtime "experiment" but the scene has no research block — add research: { edit, measure }`);
    }
    return problems;
  },
  compute: (args) => {
    const research = args.capabilities["research"] as ResearchSpec | undefined;
    if (!research) {
      throw new Error(`node "${args.node}" is runtime "experiment" but the scene declares no research block`);
    }
    return runExperiment({
      node: args.node,
      spec: args.spec as { note?: string },
      state: args.state,
      research,
      root: args.root,
      runDir: args.runDir,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  },
};

/** Every key an experiment node can emit — for docs and the validator's hint. */
export const EXPERIMENT_OUTPUTS = ["iteration", "score", "best", "verdict", "kept", "reason", "output", "summary"];

/* ───────────────────────── the capability object ───────────────────────── */

/**
 * The research block AS a mounted capability — the scene-level rules live
 * here, on the object, not in the validator. What it contributes:
 * schema for the block, its semantic checks, the scoped write tools every
 * agent node receives while it is active, and widened loop guards (a research
 * scene loops by design, so the accidental-cycle defaults would cut it short).
 */
export const researchCapability: CapabilityObject<ResearchSpec> = {
  name: "research",
  summary: "the autoresearch loop: one mutable artefact, fixed budget, code-graded metric, keep-or-revert",
  schema: researchSchema,
  check: (value, scene) => {
    const problems: string[] = [];
    for (const target of editTargets(value)) {
      if (!existsSync(resolve(target))) {
        problems.push(`research.edit names "${target}" but it does not exist — the artefact under study must exist before the baseline`);
      }
    }
    try {
      parseBudget(value.budget);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
    const hasExperiment = Object.values(scene.nodes).some(
      (n) => (n.runtime ?? scene.defaults.runtime ?? "model") === "experiment",
    );
    if (!hasExperiment) {
      problems.push(`scene declares research but no node is runtime "experiment" — nothing would measure, keep or revert`);
    }
    return problems;
  },
  tools: (value, { runDir }) => researchTools(value, runDir),
  tune: () => ({ maxNodeRuns: 10_000, timeoutMs: 24 * 60 * 60_000 }),
};

registerCapability(researchCapability);
