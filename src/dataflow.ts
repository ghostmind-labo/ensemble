/**
 * The data graph — what depends on what.
 *
 * Edges route the cursor: they are CONTROL flow. Data lives on the blackboard,
 * and `inputs`/`outputs` describe how it moves — but until now nothing checked
 * or drew that. A node declaring `inputs: ["score"]` when nothing in the scene
 * ever writes `score` ran anyway, with the model simply not told. That is the
 * difference between a workflow that works and one that got lucky, and a
 * recipe you cannot tell apart from luck is not a recipe.
 *
 * State keys have exactly two origins: `goal`, seeded before any node runs,
 * and a node's declared `outputs` (the engine writes nothing else). So the
 * data graph is fully derivable from declarations, and one property can be
 * PROVED statically: every key a node or a `when` reads is produced somewhere.
 * Whether it is produced BEFORE first use depends on the path taken — a loop
 * counter legitimately reads itself before its first write — so that remains a
 * runtime matter, and this module does not pretend otherwise.
 */
import type { Scene } from "./scene.ts";
import type { NodeSpec, State } from "./dsl.ts";
import { RUNTIMES } from "./runtimes/index.ts";

export interface Dataflow {
  /** Keys that arrive from outside the workflow: `goal`, plus the scene's `inputs`. */
  external: string[];
  /** key → nodes whose `outputs` include it. */
  producers: Record<string, string[]>;
  /** key → nodes that read it — through `inputs`, or by their runtime's own rules. */
  consumers: Record<string, string[]>;
  /** Per edge index: the state keys its `when` touched when probed. */
  reads: string[][];
}

/** Keys present before any node runs, whatever the scene declares. */
export const SEEDED: ReadonlySet<string> = new Set(["goal"]);

/**
 * Every key a node reads: its declared `inputs`, plus whatever its runtime
 * object reads by its own rules (a refine node reads its candidate and score
 * keys). Both are declarations, so both belong in the graph and the proof.
 */
export function readsOf(scene: Scene, spec: NodeSpec): string[] {
  const rt = RUNTIMES[spec.runtime ?? scene.defaults.runtime ?? "model"];
  return [...new Set([...(spec.inputs ?? []), ...(rt?.reads?.(spec) ?? [])])];
}

/**
 * Learns which keys a predicate reads by running it once against a recording
 * proxy. Every property access is captured — dotted, bracketed, destructured,
 * or `in`. The predicate sees `undefined` for every key, which is exactly what
 * it sees before the first write; a throw is swallowed because we want its
 * reads, not its verdict. This is how a condition that is opaque CODE still
 * gets a place in the data graph.
 */
export function probeReads(when: (s: State) => boolean): string[] {
  const seen = new Set<string>();
  const proxy = new Proxy({} as State, {
    get: (_t, key) => {
      if (typeof key === "string") seen.add(key);
      return undefined;
    },
    has: (_t, key) => {
      if (typeof key === "string") seen.add(key);
      return false;
    },
  });
  try {
    when(proxy);
  } catch {
    // reads were recorded before the throw
  }
  return [...seen];
}

export function dataflow(scene: Scene): Dataflow {
  const producers: Record<string, string[]> = {};
  const consumers: Record<string, string[]> = {};
  for (const [name, spec] of Object.entries(scene.nodes)) {
    for (const key of spec.outputs ?? []) (producers[key] ??= []).push(name);
    for (const key of readsOf(scene, spec)) (consumers[key] ??= []).push(name);
  }
  const reads = scene.edges.map((edge) => (edge.when ? probeReads(edge.when as (s: State) => boolean) : []));
  const external = [...new Set([...SEEDED, ...(scene.inputs ?? [])])];
  return { external, producers, consumers, reads };
}

/** Does this key have ANY origin — a producing node, or the outside world? */
const hasOrigin = (flow: Dataflow, key: string): boolean =>
  flow.external.includes(key) || Boolean(flow.producers[key]);

/** Problems, not exceptions — the validator composes them with everything else. */
export function checkDataflow(scene: Scene, flow: Dataflow = dataflow(scene)): string[] {
  const problems: string[] = [];
  const produced = Object.keys(flow.producers).sort();
  const known = (produced.length
    ? `Keys produced in this scene: ${produced.map((k) => `"${k}" (by ${flow.producers[k]!.join(", ")})`).join(", ")}.`
    : "No node in this scene declares any outputs.") +
    ` If it is meant to come from outside the workflow, declare it: inputs: ["…"] at the scene level.`;

  for (const [name, spec] of Object.entries(scene.nodes)) {
    for (const key of readsOf(scene, spec)) {
      if (hasOrigin(flow, key)) continue;
      problems.push(
        `node "${name}" reads "${key}" but nothing in the scene produces it — the node would ` +
          `run with that context silently missing. ${known}`,
      );
    }
  }
  scene.edges.forEach((edge, i) => {
    for (const key of flow.reads[i] ?? []) {
      if (hasOrigin(flow, key)) continue;
      problems.push(
        `edge ${edge.from}→${edge.to} reads "${key}" in its when() but nothing in the scene ` +
          `produces it — the condition would only ever see undefined. ${known}`,
      );
    }
  });
  return problems;
}
