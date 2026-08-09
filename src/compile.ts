/**
 * Compiles scene nodes into opencode agent definitions.
 *
 * This is where "each node can access any skill, but we define specifically
 * which ones it gets" becomes real: every generated agent starts from
 * `skill: { "*": deny }` and then allowlists exactly what the node declared.
 *
 * Agents are written into `.opencode/agents/` under the scene's directory,
 * because opencode discovers project agents by walking up from its cwd — so the
 * server must be started with that directory as its root.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { Scene, NodeSpec } from "./scene.ts";
import { runtimeOf } from "./scene.ts";
import type { Registry } from "./registry.ts";

export interface CompiledAgent {
  node: string;
  /** Namespaced so concurrent scenes never collide in the agent registry. */
  agentName: string;
  file: string;
  model: string;
  skills: string[];
  mcp: string[];
}

export interface Compilation {
  root: string;
  agentDir: string;
  agents: Map<string, CompiledAgent>;
}

function agentNameFor(scene: Scene, node: string): string {
  return `ensemble-${scene.name}-${node}`;
}

/**
 * Default-deny, then allowlist. Also denies every MCP server the node did not
 * ask for: opencode namespaces MCP tools as `<server>_<tool>`, so a per-server
 * glob is the correct granularity.
 */
function buildPermissions(node: NodeSpec, reg: Registry): Record<string, unknown> {
  const skill: Record<string, string> = { "*": "deny" };
  for (const name of node.skills ?? []) skill[name] = "allow";

  const permission: Record<string, unknown> = { skill };

  const mcp = node.mcp ?? [];
  const denied = [...reg.mcp.keys()].filter((server) => !mcp.includes(server));
  if (denied.length > 0 || mcp.length > 0) {
    const tools: Record<string, string> = {};
    for (const server of denied) tools[`${server}*`] = "deny";
    for (const server of mcp) tools[`${server}*`] = "allow";
    permission["tools"] = tools;
  }

  return permission;
}

/**
 * Tool gating. Defaults to read-only: a graph node should not mutate the
 * filesystem unless its scene says so.
 */
function buildTools(node: NodeSpec, scene: Scene): Record<string, boolean> {
  const tools: Record<string, boolean> = {
    write: false,
    edit: false,
    patch: false,
    ...scene.defaults.tools,
    ...node.tools,
  };

  // A node with zero skills has no reason to hold the skill tool at all.
  if ((node.skills ?? []).length === 0) tools["skill"] = false;

  return tools;
}

function renderAgent(scene: Scene, name: string, node: NodeSpec, reg: Registry): string {
  const model = node.model ?? scene.defaults.model;
  const temperature = node.temperature ?? scene.defaults.temperature;

  const frontmatter: Record<string, unknown> = {
    description: node.description ?? `Graph node "${name}" from scene "${scene.name}"`,
    mode: "subagent",
    // Hidden from @-autocomplete: these are machine-generated, not for humans.
    hidden: true,
    ...(model ? { model } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    tools: buildTools(node, scene),
    permission: buildPermissions(node, reg),
  };

  const body = (node.prompt ?? `You are the "${name}" node in the "${scene.name}" graph.`).trim();

  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body}\n`;
}

export function compileScene(scene: Scene, reg: Registry): Compilation {
  // Root is the invocation directory, not the scene's folder: opencode discovers
  // project agents by walking up from its cwd, and a scene tucked in scenes/
  // should not scatter .opencode/ and .graph/ next to the YAML.
  const root = resolve(process.cwd());
  const agentDir = join(root, ".opencode", "agents");

  // Clear only this scene's agents so sibling scenes in the same directory survive.
  if (existsSync(agentDir)) {
    for (const existing of Object.keys(scene.nodes)) {
      const stale = join(agentDir, `${agentNameFor(scene, existing)}.md`);
      if (existsSync(stale)) rmSync(stale);
    }
  }
  mkdirSync(agentDir, { recursive: true });

  const agents = new Map<string, CompiledAgent>();

  for (const [name, node] of Object.entries(scene.nodes)) {
    // model-runtime nodes never touch opencode; no agent to generate.
    if (runtimeOf(scene, node) !== "agent") continue;
    const agentName = agentNameFor(scene, name);
    const file = join(agentDir, `${agentName}.md`);
    writeFileSync(file, renderAgent(scene, name, node, reg), "utf8");

    agents.set(name, {
      node: name,
      agentName,
      file,
      model: node.model ?? scene.defaults.model ?? "",
      skills: node.skills ?? [],
      mcp: node.mcp ?? [],
    });
  }

  return { root, agentDir, agents };
}
