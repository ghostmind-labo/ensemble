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
export type { SceneSpec } from "./dsl.ts";
export { loadScene, validateSpec, SceneError, splitModel, resolveTarget, runtimeOf } from "./scene.ts";
export type { Scene, NodeSpec, EdgeSpec } from "./scene.ts";

// --- the registry opencode owns ---------------------------------------------
export { loadRegistry } from "./registry.ts";
export type { Registry, Skill, McpServer } from "./registry.ts";

// --- execution --------------------------------------------------------------
export { runScene, readJournal, hashScene, JOURNAL_VERSION } from "./engine.ts";
export type { RunOptions, RunResult, Journal, ResumeState, NodeCost } from "./engine.ts";
export { callAgent } from "./runtimes/agent.ts";
export type { AgentCallRequest, ToolCallEvent } from "./runtimes/agent.ts";
export { callModel } from "./runtimes/model.ts";
export type { NodeResult, ModelCallRequest } from "./runtimes/model.ts";
export { McpHub } from "./mcp.ts";
export type { McpTool, ServerStatus } from "./mcp.ts";
export { BUILTIN_TOOLS, BUILTIN_NAMES } from "./tools/builtin.ts";

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
