/**
 * Public API.
 *
 * `graph` is usable two ways: as a CLI (`graph run …`) and as a library, when you
 * want to build scenes programmatically or embed the engine in your own tool.
 *
 * ```ts
 * import { loadScene, loadRegistry, runScene } from "@ghostmind-dev/ensemble";
 *
 * const registry = loadRegistry();
 * const scene = loadScene("scenes/example.yaml", registry);
 *
 * const result = await runScene(scene, "compare Bun and Deno", {
 *   onEvent: (e) => { if (e.type === "node:end") console.log(e.node, e.cost); },
 * });
 * ```
 */

// --- scenes -----------------------------------------------------------------
export { scene } from "./dsl.ts";
export { research, ProgramError, isProgram, defaultProposer, ITERATION_EDGE } from "./autoresearch.ts";
export type { ResearchProgram } from "./autoresearch.ts";
export type { SceneSpec, StateSchema, TypedState } from "./dsl.ts";
// Re-exported so a scene can declare state shapes without its own node_modules:
// the resolver hook only maps this package, so `import { z } from "zod"` would
// fail in a bare directory. `import { scene, z } from "@ghostmind-dev/ensemble"`.
export { z } from "zod";
export { loadScene, validateSpec, SceneError, splitModel, resolveTarget, runtimeOf } from "./scene.ts";
export type { Scene, NodeSpec, EdgeSpec } from "./scene.ts";
export type { ResearchSpec } from "./research.ts";
export { experimentRuntime, researchTools, parseMetric, parseBudget, measure, runExperiment } from "./research.ts";
// Refine — keep-or-revert on the blackboard: the same discipline as research
// mode, for a state key scored by a node instead of a file scored by a command.
export { refineRuntime, decideRefine, REFINE_OUTPUTS } from "./refine.ts";
export type { RefineSpec, RefineRound, RefineVerdict } from "./refine.ts";

// --- the registry: skills and MCP servers discovered on disk -----------------
export { loadRegistry } from "./registry.ts";
export type { Registry, Skill, McpServer } from "./registry.ts";

// --- execution --------------------------------------------------------------
export { runScene, readJournal, hashScene, JOURNAL_VERSION } from "./engine.ts";
// The groundwork: runtimes are objects; mount your own without forking.
export { RUNTIMES, registerRuntime } from "./runtimes/index.ts";
export type { RuntimeObject, RuntimeCallArgs, RuntimeParkArgs, RuntimeComputeArgs } from "./runtimes/index.ts";
export type { RunOptions, RunResult, Journal, ResumeState, NodeCost, PendingAsk } from "./engine.ts";
export { callAgent } from "./runtimes/agent.ts";
export type { AgentCallRequest, ToolCallEvent } from "./runtimes/agent.ts";
export { callModel } from "./runtimes/model.ts";
export type { NodeResult, ModelCallRequest } from "./runtimes/model.ts";
export { McpHub } from "./mcp.ts";
export type { McpTool, ServerStatus } from "./mcp.ts";
export { BUILTIN_TOOLS, BUILTIN_NAMES, registerTool } from "./tools/builtin.ts";
export type { BuiltinTool } from "./tools/builtin.ts";

// --- agents: the coding loop itself, as an object ----------------------------
export { registerAgentBackend, AGENT_BACKENDS } from "./agents/index.ts";
export type { AgentBackend, AgentCliRequest, AgentCliResult } from "./agents/index.ts";
export { opencodeBackend } from "./agents/opencode.ts";
export { spawnBounded } from "./process.ts";
export type { BoundedResult, BoundedOptions } from "./process.ts";

// --- the data graph: what depends on what, derived and proved ----------------
export { dataflow, checkDataflow, probeReads, readsOf, SEEDED } from "./dataflow.ts";
export type { Dataflow } from "./dataflow.ts";

// --- edges: how the next node is chosen, as an object ------------------------
export { registerEdgeKind, EDGE_KINDS, sequentialEdges, conditionLabel } from "./edges.ts";
export type { EdgeKind, EdgeSelectArgs, EdgeSelection } from "./edges.ts";

// --- capabilities: what a SCENE can declare, as objects -----------------------
export { registerCapability, CAPABILITIES, activeCapabilities } from "./capabilities.ts";
export type { CapabilityObject } from "./capabilities.ts";

// --- stores: where run artifacts go, as objects -------------------------------
export { fileRunStore } from "./store.ts";
export type { RunStore, CostsArtifact } from "./store.ts";

// --- events -----------------------------------------------------------------
export { combineSinks } from "./events.ts";
export type { RunEvent, EventSink, NodeMeta } from "./events.ts";
export { createTerminalReporter } from "./reporter.ts";

// --- state ------------------------------------------------------------------
export { extractOutputs, extractJsonBlock, renderInputs, outputContract } from "./state.ts";
export type { State, Extraction } from "./state.ts";

// --- rendering --------------------------------------------------------------
export { toMermaid, toTerminal, toHtml, toLayout } from "./view.ts";
export type { Layout, LayoutNode, LayoutTarget } from "./view.ts";

// --- local server -----------------------------------------------------------
export { serve } from "./serve.ts";
export type { ServeOptions } from "./serve.ts";

// --- ensemble as an MCP server ----------------------------------------------
export { buildEnsembleServer, serveMcpStdio } from "./mcp-serve.ts";

// Replay — the free re-run: a recorded run played back through the real engine.
export { replayRun, readTape, routeLabel } from "./replay.ts";
export { nullRunStore } from "./store.ts";
export type { NodeCaller } from "./engine.ts";
export type { ReplayReport, ReplayOptions, Tape, RouteStep } from "./replay.ts";
