import { parseArgs } from "node:util";
import { loadRegistry } from "./registry.ts";
import { loadScene, SceneError } from "./scene.ts";
import { runScene } from "./engine.ts";
import { createTerminalReporter } from "./reporter.ts";
import { toMermaid, toTerminal, toHtml } from "./view.ts";
import { c, info, error, duration } from "./log.ts";

const USAGE = `
${c.bold("ensemble")} — multi-model agent ensembles

${c.bold("Usage")}
  ensemble run <scene.ts> "<goal>"   Execute a scene against a goal
  ensemble serve [scenes-dir]          Live viewer + run console in the browser
  ensemble view <scene.ts>           Draw the graph (terminal, mermaid, or html)
  ensemble validate <scene.ts>       Check a scene without running it
  ensemble skills                      List the skill + MCP registry (from config)
  ensemble mcp                         Connect MCP servers and list their tools
  ensemble models [filter]             List models available through OpenRouter

${c.bold("Options")}
  --port <n>        Attach to an opencode server already on this port
  --max-runs <n>    Global node-execution cap (default 50)
  --timeout <min>   Wall-clock limit in minutes (default 20)
  --verbose         Print full node transcripts instead of clipped ones
  --mermaid         view: print Mermaid source instead of the terminal sketch
  --html [file]     view: write a standalone HTML page and print its path
  --no-open         serve: do not launch a browser
  --help
`.trim();

async function cmdSkills(): Promise<number> {
  const reg = loadRegistry();

  info(c.bold(`\nSkills (${reg.skills.size})`));
  if (reg.skills.size === 0) {
    info(c.dim("  none found"));
  } else {
    const width = Math.max(...[...reg.skills.keys()].map((k) => k.length));
    for (const skill of [...reg.skills.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const desc = skill.description.split("\n")[0] ?? "";
      const short = desc.length > 72 ? `${desc.slice(0, 72)}…` : desc;
      info(`  ${c.cyan(skill.name.padEnd(width))}  ${short}`);
      info(`  ${" ".repeat(width)}  ${c.dim(skill.source)}`);
    }
  }

  info(c.bold(`\nMCP servers (${reg.mcp.size})`) + c.dim("  declared in config"));
  if (reg.mcp.size === 0) {
    info(c.dim("  none configured — declare them in ensemble.json; `ensemble mcp` connects them"));
  } else {
    for (const server of [...reg.mcp.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const state = server.enabled ? c.green("enabled") : c.dim("disabled");
      info(`  ${c.cyan(server.name)}  ${c.dim(server.type)}  ${state}`);
    }
  }

  if (reg.problems.length > 0) {
    info(c.bold(c.yellow(`\nSkipped (${reg.problems.length})`)));
    for (const problem of reg.problems) info(`  ${c.yellow("!")} ${problem}`);
  }

  if (reg.configPath) info(c.dim(`\nconfig: ${reg.configPath}`));
  info("");
  return 0;
}

async function cmdValidate(path: string | undefined): Promise<number> {
  if (!path) {
    error("validate needs a scene file: ensemble validate <scene.ts>");
    return 2;
  }

  const reg = loadRegistry();
  try {
    const scene = await loadScene(path, reg);
    const nodes = Object.keys(scene.nodes).length;
    const groups = Object.keys(scene.groups).length;
    info(
      `${c.green("valid")}  ${c.bold(scene.name)} — ${nodes} node(s), ` +
        `${groups} group(s), ${scene.edges.length} edge(s), entry ${c.cyan(scene.entry)}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof SceneError) {
      error(`${path} is not a valid scene:\n`);
      for (const problem of err.problems) console.error(`  • ${problem}`);
      console.error("");
      return 1;
    }
    throw err;
  }
}

/**
 * Live MCP verification.
 *
 * `ensemble skills` reads ensemble.json, which only says what was *declared*.
 * This actually connects each server and reports what happened — a server can be
 * configured and still fail to start, or start and expose nothing.
 */
async function cmdMcp(): Promise<number> {
  const { McpHub } = await import("./mcp.ts");
  const registry = loadRegistry();
  const servers = [...registry.mcp.values()];

  if (servers.length === 0) {
    info("\n" + c.bold("MCP servers (0)"));
    info(c.dim("  none configured\n"));
    info("  Declare them in " + c.cyan("ensemble.json") + " (this project) or " +
         c.cyan("~/.config/ensemble/ensemble.json") + " (global):\n");
    info(
      c.dim(
        [
          "  {",
          '    "mcp": {',
          '      "fs": {',
          '        "type": "local",',
          '        "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."]',
          "      }",
          "    }",
          "  }",
        ].join("\n"),
      ),
    );
    info("");
    return 0;
  }

  info(c.dim(`connecting ${servers.length} server(s)…`));
  const hub = new McpHub(process.cwd());
  try {
    await hub.connect(servers);
    const statuses = hub.status();
    info("\n" + c.bold(`MCP servers (${statuses.length})`));

    const width = Math.max(...statuses.map((s) => s.name.length));
    for (const s of statuses) {
      const state =
        s.status === "connected"
          ? c.green("connected")
          : s.status === "disabled"
            ? c.dim("disabled")
            : c.red("failed");
      const tools = s.toolCount !== undefined ? c.dim(`  ${s.toolCount} tool(s)`) : "";
      info(`  ${c.cyan(s.name.padEnd(width))}  ${state}${tools}`);
      if (s.error) info(`  ${" ".repeat(width)}  ${c.red(s.error)}`);
    }

    const connected = statuses.filter((s) => s.status === "connected").map((s) => s.name);
    if (connected.length > 0) {
      info("\n" + c.bold("Tools"));
      for (const name of connected) {
        for (const tool of hub.toolsFor([name])) {
          const first = tool.description.split("\n")[0] ?? "";
          info(`  ${c.dim(tool.name)}  ${c.dim(first.slice(0, 70))}`);
        }
      }
    }
    if (registry.configPath) info(c.dim("\nconfig: " + registry.configPath));
    info("");
    return 0;
  } finally {
    await hub.close();
  }
}

async function cmdView(
  path: string | undefined,
  opts: { mermaid: boolean; html: string | undefined },
): Promise<number> {
  if (!path) {
    error("view needs a scene file: ensemble view <scene.ts>");
    return 2;
  }

  const reg = loadRegistry();
  let scene;
  try {
    scene = await loadScene(path, reg);
  } catch (err) {
    if (err instanceof SceneError) {
      error(`${path} is not a valid scene:\n`);
      for (const problem of err.problems) console.error(`  • ${problem}`);
      console.error("");
      return 1;
    }
    throw err;
  }

  if (opts.html !== undefined) {
    const { writeFileSync } = await import("node:fs");
    const out = opts.html.length > 0 ? opts.html : `${scene.name}.html`;
    writeFileSync(out, toHtml(scene), "utf8");
    info(`${c.green("wrote")} ${out}`);
    return 0;
  }

  info(opts.mermaid ? toMermaid(scene) : `\n${toTerminal(scene)}`);
  return 0;
}

async function cmdRun(
  path: string | undefined,
  goal: string | undefined,
  opts: { port?: number; maxRuns?: number; timeout?: number; verbose: boolean },
): Promise<number> {
  if (!path || !goal) {
    error('run needs a scene and a goal: ensemble run <scene.ts> "<goal>"');
    return 2;
  }

  const reg = loadRegistry();
  let scene;
  try {
    scene = await loadScene(path, reg);
  } catch (err) {
    if (err instanceof SceneError) {
      error(`${path} is not a valid scene:\n`);
      for (const problem of err.problems) console.error(`  • ${problem}`);
      console.error("");
      return 1;
    }
    throw err;
  }

  const started = Date.now();
  const result = await runScene(scene, goal, {
    port: opts.port,
    maxNodeRuns: opts.maxRuns,
    timeoutMs: opts.timeout ? opts.timeout * 60_000 : undefined,
    onEvent: createTerminalReporter({ verbose: opts.verbose }),
  });

  if (!result.ok) {
    error(result.reason);
    info(c.dim(`\nfailed after ${duration(Date.now() - started)}`));
    return 1;
  }

  // The exit node's first declared output is the headline answer.
  const finalKey = scene.exit ? scene.nodes[scene.exit]?.outputs?.[0] : undefined;
  const headline = finalKey ? result.state[finalKey] : undefined;
  if (typeof headline === "string" && headline.trim()) {
    info(`\n${c.bold("Result")}\n${headline.trim()}`);
  }
  info(c.dim(`\nstate → ${result.runDir}/state.json`));
  return 0;
}

async function cmdModels(filter: string | undefined): Promise<number> {
  // Straight from OpenRouter — the only provider `runtime: "model"` and the agent
  // loop speak to. No local tooling involved.
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) {
      error(`OpenRouter ${res.status} ${res.statusText}`);
      return 1;
    }
    const body = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string")
      .filter((id) => !filter || id.toLowerCase().includes(filter.toLowerCase()))
      .sort();

    for (const id of models) info(`openrouter/${id}`);
    info(c.dim(`\n${models.length} model(s)`));
    return 0;
  } catch (err) {
    error(`could not reach OpenRouter: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      port: { type: "string" },
      "max-runs": { type: "string" },
      timeout: { type: "string" },
      mermaid: { type: "boolean", default: false },
      // Optional value: `--html` alone picks a filename from the scene name.
      html: { type: "string" },
      // node:util parseArgs has no --no-x negation, so it is its own flag.
      "no-open": { type: "boolean", default: false },
    },
  });

  const [command, ...rest] = positionals;

  if (values.help || !command) {
    info(USAGE);
    return command ? 0 : 1;
  }

  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  switch (command) {
    case "skills":
      return cmdSkills();
    case "validate":
      return cmdValidate(rest[0]);
    case "view":
      return cmdView(rest[0], {
        mermaid: values.mermaid ?? false,
        html: values.html,
      });
    case "run":
      return cmdRun(rest[0], rest[1], {
        port: num(values.port),
        maxRuns: num(values["max-runs"]),
        timeout: num(values.timeout),
        verbose: values.verbose ?? false,
      });
    case "serve": {
      const { serve } = await import("./serve.ts");
      await serve({
        port: num(values.port) ?? 7777,
        scenesDir: rest[0] ?? "scenes",
        open: !(values["no-open"] ?? false),
      });
      return 0; // serve blocks until SIGINT
    }
    case "mcp":
      return cmdMcp();
    case "models":
      return cmdModels(rest[0]);
    default:
      error(`unknown command: ${command}\n`);
      info(USAGE);
      return 2;
  }
}

/**
 * `serve` blocks forever by design; every other command should exit as soon as
 * its work is done. A run holds an SSE connection to opencode, and a stray open
 * handle would otherwise hang the process, so we exit explicitly after flushing.
 */
function finish(code: number, keepAlive: boolean): void {
  process.exitCode = code;
  if (keepAlive) return;

  const done = (): void => process.exit(code);
  if (process.stdout.write("")) done();
  else process.stdout.once("drain", done);
}

const isServe = process.argv[2] === "serve";

main()
  .then((code) => finish(code, isServe))
  .catch((err: unknown) => {
    error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    finish(1, false);
  });
