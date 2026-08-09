/**
 * Scene loading and validation — v2.
 *
 * Scenes are .ts modules default-exporting a SceneSpec (see dsl.ts). Loading is a
 * dynamic import — Node strips the types natively, the same mechanism the CLI
 * itself runs on. Everything expensive happens at run time, so this module stays
 * paranoid: a typo'd skill or a dangling edge should fail here, in milliseconds,
 * not three model calls into a run.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Registry } from "./registry.ts";
import type { SceneSpec, NodeSpec, EdgeSpec, State } from "./dsl.ts";

export type { SceneSpec, NodeSpec, EdgeSpec, State };

/** Carries every problem found, not just the first — one pass fixes them all. */
export class SceneError extends Error {
  problems: string[];

  constructor(problems: string[]) {
    super(problems.join("; "));
    this.name = "SceneError";
    this.problems = problems;
  }
}

/** A loaded scene: the spec plus where it came from. */
export interface Scene extends SceneSpec {
  file: string;
  defaults: NonNullable<SceneSpec["defaults"]>;
  groups: NonNullable<SceneSpec["groups"]>;
  edges: EdgeSpec[];
}

const identifier = z
  .string()
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i, "must be alphanumeric with - or _ separators");

const nodeSchema = z
  .object({
    model: z.string().optional(),
    runtime: z.enum(["model", "agent"]).optional(),
    prompt: z.string().optional(),
    inputs: z.array(z.string()).optional(),
    outputs: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    mcp: z.array(z.string()).optional(),
    tools: z.record(z.boolean()).optional(),
    description: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

const edgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    // NOT z.function(): zod wraps functions in a validating proxy, which both
    // destroys String(fn) for display and inserts itself into every call.
    // z.custom checks the type and passes the original through untouched.
    when: z.custom<(state: State) => boolean>((v) => typeof v === "function", "must be a function").optional(),
    maxLoops: z.number().int().positive().optional(),
  })
  .strict();

const sceneSchema = z
  .object({
    name: identifier,
    description: z.string().optional(),
    defaults: z
      .object({
        model: z.string().optional(),
        runtime: z.enum(["model", "agent"]).optional(),
        tools: z.record(z.boolean()).optional(),
        temperature: z.number().min(0).max(2).optional(),
      })
      .strict()
      .optional(),
    nodes: z.record(nodeSchema),
    groups: z.record(z.array(z.string())).optional(),
    edges: z.array(edgeSchema).optional(),
    entry: z.string(),
    exit: z.string().optional(),
  })
  .strict();

/** `openrouter/anthropic/claude-opus-5` → providerID + modelID. */
export function splitModel(ref: string): { providerID: string; modelID: string } {
  const slash = ref.indexOf("/");
  if (slash === -1) {
    throw new SceneError([`model "${ref}" must be "<provider>/<model>", e.g. openrouter/anthropic/claude-opus-5`]);
  }
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) };
}

/** A target is either a single node or a named group of nodes. */
export function resolveTarget(scene: Scene, target: string): string[] {
  return scene.groups[target] ?? [target];
}

/** Effective runtime for a node, with scene default then "model" as fallback. */
export function runtimeOf(scene: Scene, node: NodeSpec): "model" | "agent" {
  return node.runtime ?? scene.defaults.runtime ?? "model";
}

function checkReferences(scene: Scene, reg: Registry): string[] {
  const problems: string[] = [];
  const nodeNames = new Set(Object.keys(scene.nodes));
  const groupNames = new Set(Object.keys(scene.groups));
  const isTarget = (name: string) => nodeNames.has(name) || groupNames.has(name);

  if (nodeNames.size === 0) problems.push("scene defines no nodes");

  for (const [name, members] of Object.entries(scene.groups)) {
    if (nodeNames.has(name)) problems.push(`group "${name}" collides with a node of the same name`);
    if (members.length === 0) problems.push(`group "${name}" is empty`);
    for (const member of members) {
      if (!nodeNames.has(member)) problems.push(`group "${name}" references unknown node "${member}"`);
    }

    // Parallel members writing the same state key is a silent data race at
    // runtime, so it is a hard error here instead.
    const writers = new Map<string, string[]>();
    for (const member of members) {
      for (const key of scene.nodes[member]?.outputs ?? []) {
        writers.set(key, [...(writers.get(key) ?? []), member]);
      }
    }
    for (const [key, owners] of writers) {
      if (owners.length > 1) {
        problems.push(
          `group "${name}" runs in parallel but ${owners.map((o) => `"${o}"`).join(" and ")} ` +
            `both write state key "${key}" — give them distinct output keys`,
        );
      }
    }
  }

  for (const [name, node] of Object.entries(scene.nodes)) {
    const model = node.model ?? scene.defaults.model;
    if (!model) {
      problems.push(`node "${name}" has no model and defaults.model is unset`);
    } else if (!model.includes("/")) {
      problems.push(`node "${name}" model "${model}" must be "<provider>/<model>"`);
    }

    const runtime = runtimeOf(scene, node);

    if (runtime === "model") {
      // A model node is a pure HTTP call — granting it skills/MCP/tools would
      // silently do nothing, which is worse than an error.
      for (const field of ["skills", "mcp", "tools"] as const) {
        const value = node[field];
        if (value !== undefined && (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0)) {
          problems.push(
            `node "${name}" is runtime "model" but declares ${field} — ` +
              `only agent nodes can use ${field}; set runtime: "agent" or remove it`,
          );
        }
      }
      if (model && !model.startsWith("openrouter/")) {
        problems.push(
          `node "${name}" is runtime "model" but its model "${model}" is not "openrouter/…" — ` +
            `direct calls go through OpenRouter; use runtime: "agent" for other providers`,
        );
      }
    } else {
      for (const skill of node.skills ?? []) {
        if (!reg.skills.has(skill)) {
          const known = [...reg.skills.keys()].sort().join(", ") || "none installed";
          problems.push(`node "${name}" requests unknown skill "${skill}" — registry has: ${known}`);
        }
      }
      for (const server of node.mcp ?? []) {
        if (!reg.mcp.has(server)) {
          const known = [...reg.mcp.keys()].sort().join(", ") || "none configured";
          problems.push(`node "${name}" requests unknown MCP server "${server}" — registry has: ${known}`);
        }
      }
    }
  }

  for (const [i, edge] of scene.edges.entries()) {
    if (!isTarget(edge.from)) problems.push(`edge #${i + 1} starts at unknown node/group "${edge.from}"`);
    if (!isTarget(edge.to)) problems.push(`edge #${i + 1} points to unknown node/group "${edge.to}"`);
  }

  if (!isTarget(scene.entry)) problems.push(`entry "${scene.entry}" is not a known node or group`);
  if (scene.exit && !isTarget(scene.exit)) problems.push(`exit "${scene.exit}" is not a known node or group`);

  // Reachability: a node that can never run is almost always an authoring slip.
  if (isTarget(scene.entry)) {
    const reachable = new Set<string>();
    const queue = [scene.entry];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || reachable.has(current)) continue;
      reachable.add(current);
      for (const member of resolveTarget(scene, current)) reachable.add(member);
      for (const edge of scene.edges) {
        if (edge.from === current || resolveTarget(scene, current).includes(edge.from)) {
          if (!reachable.has(edge.to)) queue.push(edge.to);
        }
      }
    }

    for (const name of nodeNames) {
      const inGroup = [...groupNames].some((g) => reachable.has(g) && (scene.groups[g] ?? []).includes(name));
      if (!reachable.has(name) && !inGroup) {
        problems.push(`node "${name}" is unreachable from entry "${scene.entry}"`);
      }
    }
    if (scene.exit && !reachable.has(scene.exit)) {
      problems.push(`exit "${scene.exit}" is unreachable from entry "${scene.entry}"`);
    }
  }

  return problems;
}

/** Validates an already-imported spec. Used by the loader and by the editor's save path. */
export function validateSpec(doc: unknown, file: string, reg: Registry): Scene {
  const parsed = sceneSchema.safeParse(doc);
  if (!parsed.success) {
    throw new SceneError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.join(".") || "<root>";
        return `${path}: ${issue.message}`;
      }),
    );
  }

  const scene: Scene = {
    ...(parsed.data as SceneSpec),
    file,
    defaults: parsed.data.defaults ?? {},
    groups: parsed.data.groups ?? {},
    edges: (parsed.data.edges ?? []) as EdgeSpec[],
  };

  const problems = checkReferences(scene, reg);
  if (problems.length > 0) throw new SceneError(problems);
  return scene;
}

/**
 * Imports and validates a scene module.
 *
 * The `?v=<mtime>` query defeats Node's module cache so `graph serve` sees edits
 * without a restart — a bare import would pin the first version forever.
 */
export async function loadScene(file: string, reg: Registry): Promise<Scene> {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new SceneError([`cannot read scene file: ${file}`]);
  if (!/\.(ts|mts|js|mjs)$/.test(abs)) {
    throw new SceneError([`scene must be a TypeScript module (.ts), got: ${file}`]);
  }

  const url = `${pathToFileURL(abs).href}?v=${statSync(abs).mtimeMs}`;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (err) {
    throw new SceneError([`scene failed to import: ${(err as Error).message}`]);
  }

  const doc = mod["default"];
  if (doc === undefined) {
    throw new SceneError([`${file} has no default export — export default scene({ … })`]);
  }

  return validateSpec(doc, abs, reg);
}
