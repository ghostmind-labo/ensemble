/**
 * Scene-level capability blocks — the "everything is an object" rule applied
 * to the SCENE, not just its nodes.
 *
 * A runtime object answers "what can a NODE be?". A capability object answers
 * "what can a SCENE declare?" — a top-level block (`research: {...}`) that
 * changes how the whole run behaves. Registering one teaches the validator its
 * schema and rules, lets it hand extra tools to every agent node, and lets it
 * retune the engine's guard defaults — with zero engine or validator edits.
 *
 * `research` is the first mounted capability, not a special case: the engine
 * knows only this interface. A library user mounts their own the same way
 * (`registerCapability({...})`) — a `memory` block, a `git` block, a spend
 * policy — and scenes may then declare it like any built-in.
 */
import type { ZodTypeAny } from "zod";
import type { BuiltinTool } from "./tools/builtin.ts";
// Type-only: erased at runtime, so no import cycle with scene.ts.
import type { Scene } from "./scene.ts";

export interface CapabilityObject<V = unknown> {
  /** The scene-level key, e.g. "research". */
  name: string;
  /** One line for docs and error messages. */
  summary: string;
  /** Shape of the block's value; validated before any semantic checks. */
  schema: ZodTypeAny;
  /** Semantic validation against the whole scene (messages, not exceptions). */
  check?: (value: V, scene: Scene) => string[];
  /**
   * Extra tools offered to every agent node while this capability is active.
   * This is how a capability grants power: the tools exist only because the
   * scene declared the block, and they carry their own scoping.
   */
  tools?: (value: V, ctx: { runDir: string }) => BuiltinTool[];
  /**
   * Adjusted engine guard defaults while active. Explicit run options always
   * win; this only moves the DEFAULT (e.g. research widens the loop guards
   * because a research scene loops by design).
   */
  tune?: (value: V) => { maxNodeRuns?: number; timeoutMs?: number };
  /**
   * Built-in tools WITHDRAWN from every agent node while this capability is
   * active — the counterpart to `tools`, and just as necessary.
   *
   * A capability that narrows the world has to be able to close doors, not
   * only open them. Research mode is the case in point: it scopes writes to
   * the artefact under study, which is worthless if the proposer can still
   * reach `bash` and rewrite its own evaluator. Withdrawal beats denial —
   * the tool is absent from the request, so there is no allowlist to defeat.
   */
  withdraws?: (value: V) => string[];
}

export const CAPABILITIES: Record<string, CapabilityObject> = {};

/**
 * Mounts a capability — same groundwork rule as runtimes, tools and stores:
 * a scene-level feature is an object handed to a register function.
 */
export function registerCapability<V>(cap: CapabilityObject<V>): void {
  CAPABILITIES[cap.name] = cap as CapabilityObject;
}

/** The capabilities a given scene actually declares, with their block values. */
export function activeCapabilities(scene: Scene): Array<{ cap: CapabilityObject; value: unknown }> {
  return Object.values(CAPABILITIES)
    .filter((cap) => (scene as unknown as Record<string, unknown>)[cap.name] !== undefined)
    .map((cap) => ({ cap, value: (scene as unknown as Record<string, unknown>)[cap.name] }));
}
