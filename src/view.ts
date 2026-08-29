/**
 * Visual representation of a scene.
 *
 * Two renderings from one source of truth:
 *   - a terminal sketch, for when you just want to eyeball the wiring
 *   - Mermaid, which pastes into anything and is the substrate a future visual
 *     editor would round-trip through
 */
import type { Scene } from "./scene.ts";
import { runtimeOf } from "./scene.ts";
import { RUNTIMES } from "./runtimes/index.ts";
import { conditionLabel } from "./edges.ts";
import { c } from "./log.ts";

/** `openrouter/anthropic/claude-haiku-4.5` → `anthropic/claude-haiku-4.5` */
function shortModel(ref: string): string {
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(slash + 1);
}

function nodesOf(scene: Scene, target: string): string[] {
  return scene.groups[target] ?? [target];
}

/** Mermaid ids must be bare identifiers; scene names allow hyphens. */
function id(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function escapeLabel(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toMermaid(scene: Scene): string {
  const lines = ["flowchart TD"];
  const grouped = new Set<string>();

  for (const members of Object.values(scene.groups)) {
    for (const member of members) grouped.add(member);
  }

  const nodeLabel = (name: string): string => {
    const spec = scene.nodes[name];
    if (!spec) return name;
    const model = shortModel(spec.model ?? scene.defaults.model ?? "?");
    const parts = [`<b>${escapeLabel(name)}</b>`, escapeLabel(model)];
    if ((spec.skills ?? []).length > 0) parts.push(`🛠 ${escapeLabel((spec.skills ?? []).join(", "))}`);
    if ((spec.mcp ?? []).length > 0) parts.push(`🔌 ${escapeLabel((spec.mcp ?? []).join(", "))}`);
    return parts.join("<br/>");
  };

  // Groups first, as Mermaid subgraphs.
  for (const [group, members] of Object.entries(scene.groups)) {
    lines.push(`  subgraph ${id(group)}["${escapeLabel(group)} · parallel"]`);
    lines.push("    direction LR");
    for (const member of members) {
      lines.push(`    ${id(member)}["${nodeLabel(member)}"]`);
    }
    lines.push("  end");
  }

  for (const name of Object.keys(scene.nodes)) {
    if (grouped.has(name)) continue;
    lines.push(`  ${id(name)}["${nodeLabel(name)}"]`);
  }

  for (const edge of scene.edges) {
    const label = edge.when
      ? `|"${escapeLabel(conditionLabel(edge.when))}${edge.maxLoops ? ` ⟲${edge.maxLoops}` : ""}"|`
      : "";
    lines.push(`  ${id(edge.from)} -->${label} ${id(edge.to)}`);
  }

  lines.push(`  START(( )) --> ${id(scene.entry)}`);
  if (scene.exit) lines.push(`  ${id(scene.exit)} --> DONE((( )))`);

  // Styling: entry/exit markers muted, group members tinted.
  lines.push("  classDef grp fill:#eef2ff,stroke:#6366f1,stroke-width:1px;");
  lines.push("  classDef term fill:#111,stroke:#111,color:#fff;");
  const members = [...grouped].map(id).join(",");
  if (members) lines.push(`  class ${members} grp;`);
  lines.push(`  class START${scene.exit ? ",DONE" : ""} term;`);

  return lines.join("\n");
}

/** Terminal sketch: entry, each hop, and the edges out of it. */
export function toTerminal(scene: Scene): string {
  const out: string[] = [];
  out.push(`${c.bold(scene.name)}  ${c.dim(`${Object.keys(scene.nodes).length} nodes`)}`);
  out.push("");

  const describe = (name: string, pad: string): void => {
    const spec = scene.nodes[name];
    if (!spec) return;
    const model = shortModel(spec.model ?? scene.defaults.model ?? "?");
    const runtime = runtimeOf(scene, spec);
    const badge = RUNTIMES[runtime]?.badge ?? "•";
    const tag =
      runtime === "agent" ? c.yellow(`${badge}agent`) : runtime === "model" ? c.dim(`${badge}model`) : c.cyan(`${badge}${runtime}`);
    out.push(`${pad}${c.magenta(c.bold(name))} ${c.dim(model)} ${tag}`);
    if ((spec.skills ?? []).length > 0) out.push(`${pad}  ${c.dim("skills:")} ${c.cyan((spec.skills ?? []).join(", "))}`);
    if ((spec.mcp ?? []).length > 0) out.push(`${pad}  ${c.dim("mcp:")} ${c.cyan((spec.mcp ?? []).join(", "))}`);
    if ((spec.inputs ?? []).length > 0) out.push(`${pad}  ${c.dim(`in  ← ${(spec.inputs ?? []).join(", ")}`)}`);
    if ((spec.outputs ?? []).length > 0) out.push(`${pad}  ${c.dim(`out → ${(spec.outputs ?? []).join(", ")}`)}`);
  };

  // Walk breadth-first from the entry so the printout follows execution order.
  const seen = new Set<string>();
  const queue = [scene.entry];

  while (queue.length > 0) {
    const target = queue.shift();
    if (target === undefined || seen.has(target)) continue;
    seen.add(target);

    const members = nodesOf(scene, target);
    const isGroup = scene.groups[target] !== undefined;

    if (isGroup) {
      out.push(`${c.blue("┏")} ${c.bold(target)} ${c.dim(`(${members.length} in parallel)`)}`);
      for (const member of members) describe(member, "┃ ");
      out.push(`${c.blue("┗")}`);
    } else {
      describe(target, "");
    }

    const outgoing = scene.edges.filter((e) => e.from === target || members.includes(e.from));
    for (const edge of outgoing) {
      const cond = edge.when ? ` ${c.yellow(`if ${conditionLabel(edge.when)}`)}` : "";
      const cap = edge.maxLoops ? c.dim(` (max ${edge.maxLoops}×)`) : "";
      out.push(`  ${c.dim("└→")} ${c.bold(edge.to)}${cond}${cap}`);
      queue.push(edge.to);
    }

    if (scene.exit === target || members.includes(scene.exit ?? "")) {
      out.push(`  ${c.green("■ exit")}`);
    }
    out.push("");
  }

  return out.join("\n");
}

export interface LayoutNode {
  name: string;
  model: string;
  runtime: string;
  skills: string[];
  mcp: string[];
  inputs: string[];
  outputs: string[];
  prompt: string;
}

export interface LayoutTarget {
  /** Node name, or group name when `members.length > 1` or it is a declared group. */
  name: string;
  group: boolean;
  members: LayoutNode[];
  /** Row in the drawing; BFS depth from the entry. */
  layer: number;
  /** Column within the row. */
  index: number;
}

export interface Layout {
  name: string;
  entry: string;
  exit: string | undefined;
  targets: LayoutTarget[];
  edges: Array<{ from: string; to: string; when?: string; maxLoops?: number; back: boolean }>;
}

/**
 * Assigns each target a (layer, index) for the browser to draw.
 *
 * BFS depth rather than longest-path, because scenes are cyclic by design and a
 * longest-path ranking has no meaning once a back-edge exists. An edge pointing
 * to an already-placed, shallower target is flagged `back` so the UI can route
 * it around the graph instead of through it.
 */
export function toLayout(scene: Scene): Layout {
  const describe = (name: string): LayoutNode => {
    const spec = scene.nodes[name];
    return {
      name,
      model: spec?.model ?? scene.defaults.model ?? "",
      runtime: spec ? runtimeOf(scene, spec) : "model",
      skills: spec?.skills ?? [],
      mcp: spec?.mcp ?? [],
      inputs: spec?.inputs ?? [],
      outputs: spec?.outputs ?? [],
      prompt: spec?.prompt ?? "",
    };
  };

  const layerOf = new Map<string, number>();
  const order: string[] = [];
  const queue: Array<{ target: string; layer: number }> = [{ target: scene.entry, layer: 0 }];

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || layerOf.has(item.target)) continue;
    layerOf.set(item.target, item.layer);
    order.push(item.target);

    const members = nodesOf(scene, item.target);
    for (const edge of scene.edges) {
      if (edge.from === item.target || members.includes(edge.from)) {
        if (!layerOf.has(edge.to)) queue.push({ target: edge.to, layer: item.layer + 1 });
      }
    }
  }

  const perLayer = new Map<number, number>();
  const targets: LayoutTarget[] = order.map((name) => {
    const layer = layerOf.get(name) ?? 0;
    const index = perLayer.get(layer) ?? 0;
    perLayer.set(layer, index + 1);
    const members = nodesOf(scene, name);
    return {
      name,
      group: scene.groups[name] !== undefined,
      members: members.map(describe),
      layer,
      index,
    };
  });

  // An edge's source may be a group member; resolve it to the drawn target.
  const targetOf = (node: string): string => {
    for (const [group, members] of Object.entries(scene.groups)) {
      if (members.includes(node)) return group;
    }
    return node;
  };

  const edges = scene.edges.map((edge) => {
    const from = targetOf(edge.from);
    const fromLayer = layerOf.get(from) ?? 0;
    const toLayer = layerOf.get(edge.to) ?? 0;
    return {
      from,
      to: edge.to,
      ...(edge.when ? { when: conditionLabel(edge.when) } : {}),
      ...(edge.maxLoops ? { maxLoops: edge.maxLoops } : {}),
      back: toLayer <= fromLayer,
    };
  });

  return { name: scene.name, entry: scene.entry, exit: scene.exit, targets, edges };
}

/**
 * Standalone HTML. Mermaid is loaded from a CDN, so the file needs network on
 * first open; the .mmd source is embedded verbatim so nothing is lost offline.
 */
export function toHtml(scene: Scene): string {
  const diagram = toMermaid(scene);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeLabel(scene.name)} — graph</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e5e5e5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0e0e10; --fg:#eee; --muted:#999; --line:#2a2a2e; }
  }
  body { margin:0; padding:2rem; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  h1 { font-size:1.4rem; margin:0 0 .25rem; }
  p.sub { color:var(--muted); margin:0 0 2rem; }
  .diagram { overflow-x:auto; border:1px solid var(--line); border-radius:12px; padding:1.5rem; }
  details { margin-top:2rem; }
  pre { overflow-x:auto; background:rgba(127,127,127,.1); padding:1rem; border-radius:8px; }
</style>
</head>
<body>
  <h1>${escapeLabel(scene.name)}</h1>
  <p class="sub">${Object.keys(scene.nodes).length} nodes ·
     ${Object.keys(scene.groups).length} groups ·
     ${scene.edges.length} edges</p>
  <div class="diagram"><pre class="mermaid">${escapeLabel(diagram)}</pre></div>
  <details><summary>Mermaid source</summary><pre>${escapeLabel(diagram)}</pre></details>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: true, securityLevel: "loose",
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
  </script>
</body>
</html>
`;
}
