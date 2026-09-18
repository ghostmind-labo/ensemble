/**
 * The picture, as data.
 *
 * This library draws nothing. It emits one JSON document describing the graph
 * and leaves rendering to whatever you already use — a layout engine, a
 * notebook, an agent writing a diagram. A renderer is opinionated and goes
 * stale; a schema is neither.
 *
 * Two properties make the document worth trusting:
 *
 *   It is COMPLETE. Every branch of every decision is here, because Jev's
 *   options are declared before anything runs. This is the structure of the
 *   workflow, not a recording of the path one run happened to take.
 *
 *   It is HONEST about code. A `when` branch cannot be enumerated, so instead
 *   of pretending, the document carries the predicate's own source text and the
 *   keys it touches. Nothing is executed to produce it.
 *
 * Shape: flat `nodes[]` and `edges[]` with stable ids — what dagre, elk,
 * graphviz, cytoscape and d3 all already eat. No coordinates, no colours, no
 * theme: position is the renderer's business.
 */
import { createHash } from "node:crypto";
import {
  edgeId,
  externalKeys,
  isCode,
  isDecide,
  isWork,
  parseBranch,
  probeReads,
  producers,
  readsOf,
  writesOf,
  type RunnerSpec,
} from "./spec.ts";
import type { Description, Question } from "./questions.ts";

export const GRAPH_SCHEMA = "https://ghostmind.dev/ensemble/graph-v1.json";

/** Always an object, so a reader never branches on string-vs-object. */
export type GraphDescription = Record<string, unknown> | null;

export interface GraphQuestion {
  key: string;
  type: "choice" | "score" | "noul";
  instructions: unknown;
  /** choice only — the branch labels, in declaration order. */
  options?: Array<{ name: string; description: GraphDescription }>;
  /** score only — level numbers come from position. */
  levels?: Array<{ value: number; description: GraphDescription }>;
  /** noul only, and only when declared. */
  criteria?: { true: GraphDescription; false: GraphDescription };
}

export interface GraphNode {
  id: string;
  kind: "decide" | "work" | "code";
  label?: string;
  reads: string[];
  writes: string[];
  /** `cheap` is a decider call, `metered` is your handler, `free` is plain code. */
  cost: "cheap" | "metered" | "free";
  decide?: {
    model: string;
    questions: GraphQuestion[];
    gate?: { on: string; min: number; to: string };
  };
  work?: { handler: string };
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  on?: { question: string; option: string } | { question: string; op: string; value: number };
  when?: { source: string; reads: string[] };
  maxLoops?: number;
}

export interface GraphDoc {
  $schema: string;
  version: 1;
  runner: {
    name: string;
    description?: string;
    /** Of the structure below — a run record cites it to prove which graph ran. */
    hash: string;
    entry: string;
    inputs: string[];
    result?: string;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The data graph: who writes each key, who reads it. `$input` means from outside. */
  data: Array<{ key: string; producedBy: string[]; readBy: string[] }>;
}

const describe = (description: Description | null | undefined): GraphDescription =>
  description == null ? null : typeof description === "string" ? { what: description } : { ...description };

function question(key: string, q: Question): GraphQuestion {
  const base = { key, instructions: q.instructions };
  switch (q.type) {
    case "choice":
      return {
        ...base,
        type: "choice",
        options: Object.entries(q.criteria).map(([name, description]) => ({
          name,
          description: describe(description as Description | null),
        })),
      };
    case "score":
      return {
        ...base,
        type: "score",
        levels: q.criteria.map((description, value) => ({ value, description: describe(description) })),
      };
    case "noul":
      return q.criteria
        ? { ...base, type: "noul", criteria: { true: describe(q.criteria.true), false: describe(q.criteria.false) } }
        : { ...base, type: "noul" };
  }
}

/** Serialise a runner's structure. Pure: nothing is executed but `when` probes. */
export function toGraph(spec: RunnerSpec): GraphDoc {
  const model = spec.jev?.model ?? "jev-latest";

  // Field order is part of the contract here: a reader meets id, kind and cost
  // before the bulk of a decide block, so the document scans top to bottom.
  const nodes: GraphNode[] = Object.entries(spec.nodes).map(([id, node]) => {
    const head = (kind: GraphNode["kind"], cost: GraphNode["cost"]) => ({
      id,
      kind,
      ...(node.label ? { label: node.label } : {}),
      cost,
      reads: readsOf(node),
      writes: writesOf(node),
    });
    if (isDecide(node)) {
      return {
        ...head("decide", "cheap"),
        decide: {
          model,
          questions: Object.entries(node.decide).map(([key, q]) => question(key, q)),
          ...(node.gate ? { gate: node.gate } : {}),
        },
      };
    }
    if (isWork(node)) return { ...head("work", "metered"), work: { handler: node.work } };
    return head("code", "free");
  });

  const edges: GraphEdge[] = (spec.edges ?? []).map((edge, index) => {
    const out: GraphEdge = { id: edgeId(index), from: edge.from, to: edge.to };
    if (edge.on) {
      const branch = parseBranch(edge.on);
      out.on =
        branch.kind === "option"
          ? { question: branch.key, option: branch.option }
          : { question: branch.key, op: branch.op, value: branch.value };
    }
    if (edge.when) out.when = { source: edge.when.toString(), reads: probeReads(edge.when) };
    if (edge.maxLoops !== undefined) out.maxLoops = edge.maxLoops;
    return out;
  });

  const wrote = producers(spec);
  const external = externalKeys(spec);
  const readBy: Record<string, string[]> = {};
  for (const [name, node] of Object.entries(spec.nodes)) {
    for (const key of readsOf(node)) (readBy[key] ??= []).push(name);
  }
  for (const [index, edge] of (spec.edges ?? []).entries()) {
    const keys = edge.when ? probeReads(edge.when) : edge.on ? [parseBranch(edge.on).key] : [];
    for (const key of keys) (readBy[key] ??= []).push(edgeId(index));
  }

  const data = [...new Set([...external, ...Object.keys(wrote), ...Object.keys(readBy)])]
    .sort()
    .map((key) => ({
      key,
      producedBy: external.includes(key) ? ["$input", ...(wrote[key] ?? [])] : (wrote[key] ?? []),
      readBy: [...new Set(readBy[key] ?? [])],
    }));

  const doc: GraphDoc = {
    $schema: GRAPH_SCHEMA,
    version: 1,
    runner: {
      name: spec.name,
      ...(spec.description ? { description: spec.description } : {}),
      hash: "",
      entry: spec.entry,
      inputs: external,
      ...(spec.result ? { result: spec.result } : {}),
    },
    nodes,
    edges,
    data,
  };
  doc.runner.hash = `sha256:${createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 16)}`;
  return doc;
}
