import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { loadRegistry } from "./registry.ts";
import { loadScene, SceneError } from "./scene.ts";
import { runScene, readJournal, hashScene } from "./engine.ts";
import { createTerminalReporter } from "./reporter.ts";
import { toMermaid, toTerminal, toHtml } from "./view.ts";
import { c, info, error, duration } from "./log.ts";
import { packageVersion } from "./version.ts";

const USAGE = `
${c.bold("ensemble")} ${c.dim(`v${packageVersion()}`)} — multi-model agent ensembles

${c.bold("Usage")}
  ensemble run <scene.ts> "<goal>"   Execute a scene against a goal
  ensemble resume <run-dir>            Continue a stopped run from its checkpoint
  ensemble serve [scenes-dir]          Live viewer + run console in the browser
  ensemble view <scene.ts>           Draw the graph (terminal, mermaid, or html)
  ensemble validate <scene.ts>       Check a scene without running it
  ensemble skills                      List the skill + MCP registry (from config)
  ensemble mcp                         Connect MCP servers and list their tools
  ensemble mcp serve                   Expose ensemble AS an MCP server (stdio) —
                                       run/status/peek/stop/resume tools for agents
  ensemble mcp login <server>          Authorize an MCP server that needs OAuth
  ensemble mcp logout <server>         Forget that server's stored tokens
  ensemble models [filter]             List models available through OpenRouter
  ensemble version                     Print the installed version

${c.bold("Options")}
  --port <n>        serve: port to listen on (default 7777) — give each project
                    its own port to watch several at once
  --max-runs <n>    Global node-execution cap (default 50)
  --timeout <min>   Wall-clock limit in minutes (default 20)
  --budget <usd>    Hard cost cap for the run, e.g. --budget 0.50
                    (ENSEMBLE_BUDGET sets a machine-wide default)
  --verbose         Print full node transcripts instead of clipped ones
  --mermaid         view: print Mermaid source instead of the terminal sketch
  --html [file]     view: write a standalone HTML page and print its path
  --no-open         serve: do not launch a browser
  --version, -V     Print the installed version
  --help

${c.bold("Where scenes live")}
  .ensemble/scenes/*.mts     ${c.dim("the convention — everything ensemble in one place")}
  .ensemble/runs/            ${c.dim("run artifacts, created for you")}
  ${c.dim("`ensemble run <path>` accepts any path; `serve` defaults to .ensemble/scenes")}

${c.bold("First time")}
  1. export OPENROUTER_API_KEY=sk-or-...      ${c.dim("the only credential needed")}
  2. write .ensemble/scenes/my.mts:           ${c.dim("no package.json, no install")}
       import { scene } from "@ghostmind-dev/ensemble";
       export default scene({
         name: "ask",
         defaults: { model: "openrouter/anthropic/claude-sonnet-5" },
         nodes: { answer: { outputs: ["answer"] } },
         entry: "answer", exit: "answer",
       });
  3. ensemble validate .ensemble/scenes/my.mts        ${c.dim("free — catches mistakes")}
  4. ensemble run .ensemble/scenes/my.mts "goal" --budget 0.25

${c.bold("Driving it from an AI agent")} ${c.dim("(Claude Code, or any MCP host)")}
  claude mcp add ensemble -s user -- ensemble mcp serve

  Registers ensemble's tools once, for every project: the agent starts runs,
  polls status, peeks at state mid-run, stops and resumes them — no shell.
  ${c.dim("Then just ask: \"build me a scene that…\" — see `ensemble mcp serve`.")}
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
      info(`  ${c.cyan(server.name)}  ${c.dim(server.type)}  ${state}  ${c.dim(server.source)}`);
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

  // Unresolved ${VAR} is the likeliest cause of a confusing auth failure — say so
  // before connecting rather than after a 401.
  for (const problem of registry.problems.filter((p) => p.includes("${"))) {
    info(`${c.yellow("!")} ${c.yellow(problem)}`);
  }

  info(c.dim(`connecting ${servers.length} server(s)…`));
  const { FileOAuthProvider } = await import("./oauth.ts");
  const hub = new McpHub(
    process.cwd(),
    (name) => new FileOAuthProvider(name, () => {}),
  );
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
            : s.status === "needs_auth"
              ? c.yellow("needs auth")
              : c.red("failed");
      const tools = s.toolCount !== undefined ? c.dim(`  ${s.toolCount} tool(s)`) : "";
      const from = registry.mcp.get(s.name)?.source;
      info(`  ${c.cyan(s.name.padEnd(width))}  ${state}${tools}${from ? c.dim(`  ${from}`) : ""}`);
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

/**
 * `ensemble login <server>` — the interactive half of OAuth.
 *
 * Connecting with an auth provider makes the SDK drive the flow: it opens the
 * browser, we catch the redirect on a loopback port, hand back the code, and
 * reconnect with real tokens. Tokens persist in ~/.config/ensemble/auth.json,
 * so this is once per server, not once per run.
 */
async function cmdLogin(name: string | undefined, opts: { logout: boolean }): Promise<number> {
  const { FileOAuthProvider, waitForCallback, forgetTokens, listAuthorized, CALLBACK_PORT } =
    await import("./oauth.ts");
  const registry = loadRegistry();

  if (!name) {
    const authed = listAuthorized();
    info("\n" + c.bold("Authorized servers"));
    if (authed.length === 0) info(c.dim("  none"));
    else for (const s of authed) info(`  ${c.green("✓")} ${c.cyan(s)}`);
    info(c.dim("\nusage: ensemble mcp login <server>   |   ensemble mcp logout <server>"));
    info("");
    return 0;
  }

  if (opts.logout) {
    info(forgetTokens(name) ? `${c.green("logged out")} ${name}` : `no stored tokens for ${name}`);
    return 0;
  }

  const server = registry.mcp.get(name);
  if (!server) {
    error(`no MCP server named "${name}" — declared: ${[...registry.mcp.keys()].join(", ") || "none"}`);
    return 1;
  }
  if (server.type !== "remote" || !server.url) {
    error(`"${name}" is a local server — OAuth applies to remote servers only`);
    return 1;
  }

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );

  const callback = waitForCallback();
  const headless = Boolean(process.env["ENSEMBLE_NO_BROWSER"]);
  const provider = new FileOAuthProvider(name, (url) => {
    info(`\n${c.bold(`Authorize ${name}`)}`);
    info(headless ? c.dim("open this URL to continue:") : c.dim("your browser should open; if not, visit:"));
    info(`  ${c.cyan(url)}`);
    info(c.dim(`\nwaiting for the redirect on 127.0.0.1:${CALLBACK_PORT} …`));
  });

  const url = new URL(server.url);
  try {
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    const client = new Client({ name: "ensemble", version: "0.2.2" }, { capabilities: {} });

    try {
      // Already holding valid tokens? Then this simply succeeds.
      await client.connect(transport);
      info(`${c.green("already authorized")} — ${name} connected`);
      await client.close();
      return 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const needsAuth =
        (err as Error)?.name === "UnauthorizedError" || /unauthoriz|401|403/i.test(message);
      if (!needsAuth) throw err;
    }

    // The provider has now sent the browser off; wait for the code to come back.
    const code = await callback.code;
    await transport.finishAuth(code);

    const client2 = new Client({ name: "ensemble", version: "0.2.2" }, { capabilities: {} });
    await client2.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
    const tools = await client2.listTools();
    await client2.close();

    info(`\n${c.green("authorized")} ${c.cyan(name)} ${c.dim(`— ${tools.tools.length} tool(s)`)}`);
    info(c.dim("tokens saved to ~/.config/ensemble/auth.json\n"));
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    callback.close();
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
  opts: { maxRuns?: number; timeout?: number; budget?: number; verbose: boolean },
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
    maxNodeRuns: opts.maxRuns,
    timeoutMs: opts.timeout ? opts.timeout * 60_000 : undefined,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    onEvent: createTerminalReporter({ verbose: opts.verbose }),
  });

  return report(scene, result, started);
}

/**
 * Shared tail of `run` and `resume`: the headline answer and where the
 * artifacts landed. A stopped run advertises how to pick it back up, since the
 * journal beside its state is the whole point of stopping cleanly.
 */
function report(
  scene: Awaited<ReturnType<typeof loadScene>>,
  result: Awaited<ReturnType<typeof runScene>>,
  started: number,
): number {
  if (!result.ok) {
    // Parked on an ask node is not a failure — it is the scene working as
    // designed, waiting on a human or an agent.
    if (result.waiting) {
      const { node, question, outputs } = result.waiting;
      info(`\n${c.bold(c.cyan("⏸ waiting"))} ${c.dim(`on ${node}, after ${duration(Date.now() - started)}`)}`);
      info(`\n${question}\n`);
      info(c.dim("answer and continue:"));
      info(
        `  ensemble resume ${result.runDir} ` + outputs.map((k) => `--answer ${k}="…"`).join(" "),
      );
      return 0;
    }
    error(result.reason);
    info(c.dim(`\nfailed after ${duration(Date.now() - started)}`));
    info(c.dim(`resume → ensemble resume ${result.runDir}`));
    return 1;
  }

  // The exit node's first declared output is the headline answer.
  const finalKey = scene.exit ? scene.nodes[scene.exit]?.outputs?.[0] : undefined;
  const headline = finalKey ? result.state[finalKey] : undefined;
  if (typeof headline === "string" && headline.trim()) {
    info(`\n${c.bold("Result")}\n${headline.trim()}`);
  }
  info(c.dim(`\nstate → ${result.runDir}/state.json`));
  info(c.dim(`costs → ${result.runDir}/costs.json`));
  return 0;
}

/**
 * `ensemble resume <run-dir>` — continue a run that stopped early.
 *
 * The journal carries the graph position, loop counters, and spend, so the
 * continuation skips everything already paid for. A budget applies to the
 * cumulative total, which is what makes `--budget` a pause button rather than a
 * kill switch: stop cheap, look at the state, then decide to spend more.
 */
async function cmdResume(
  dir: string | undefined,
  opts: { maxRuns?: number; timeout?: number; budget?: number; answers?: string[]; verbose: boolean },
): Promise<number> {
  if (!dir) {
    error("resume needs a run directory: ensemble resume .ensemble/runs/<id>");
    return 2;
  }

  let resumeFrom;
  try {
    resumeFrom = readJournal(dir);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const { journal } = resumeFrom;
  const reg = loadRegistry();
  let scene;
  try {
    scene = await loadScene(journal.scene.file, reg);
  } catch (err) {
    if (err instanceof SceneError) {
      error(`the scene this run came from (${journal.scene.file}) is not valid:\n`);
      for (const problem of err.problems) console.error(`  • ${problem}`);
      console.error("");
      return 1;
    }
    throw err;
  }

  // An edited scene is allowed — you often fix the thing that stalled the run —
  // but edge indexes back the loop counters, so say so rather than silently
  // applying stale budgets to renumbered edges.
  if (hashScene(journal.scene.file) !== journal.scene.hash) {
    info(
      `${c.yellow("!")} ${c.yellow(`${journal.scene.file} changed since this run started`)} — ` +
        c.dim("maxLoops counters are keyed by edge order and may no longer line up"),
    );
  }

  // --answer key=value, repeatable. Everything after the first "=" is the value,
  // so answers may contain "=" freely.
  const answers: Record<string, unknown> = {};
  for (const pair of opts.answers ?? []) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      error(`--answer must be key=value, got "${pair}"`);
      return 2;
    }
    answers[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  // A parked run needs its answer, or it parks again on the same question.
  if (journal.pending) {
    const missing = journal.pending.outputs.filter((k) => answers[k] === undefined);
    if (missing.length > 0) {
      error(
        `this run is waiting on "${journal.pending.node}":\n\n  ${journal.pending.question}\n\n` +
          `Answer it and resume:\n  ensemble resume ${dir} ` +
          missing.map((k) => `--answer ${k}="…"`).join(" "),
      );
      return 1;
    }
  }

  info(
    `${c.bold("resuming")} ${c.bold(c.magenta(journal.scene.name))} ${c.dim("at")} ` +
      `${c.cyan(journal.resumeAt ?? "?")} ${c.dim(`· ${journal.nodeRuns} node run(s) already done`)}` +
      `${journal.totalCost > 0 ? c.dim(` · $${journal.totalCost.toFixed(4)} spent`) : ""}`,
  );
  if (journal.stoppedBecause) info(c.dim(`stopped because: ${journal.stoppedBecause}`));
  if (Object.keys(answers).length > 0) info(c.dim(`answering: ${Object.keys(answers).join(", ")}`));

  const started = Date.now();
  const result = await runScene(scene, journal.goal, {
    resumeFrom,
    ...(Object.keys(answers).length > 0 ? { answers } : {}),
    maxNodeRuns: opts.maxRuns,
    timeoutMs: opts.timeout ? opts.timeout * 60_000 : undefined,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    onEvent: createTerminalReporter({ verbose: opts.verbose }),
  });

  return report(scene, result, started);
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
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        // -v is verbose (long-standing); -V is version, as is conventional.
        version: { type: "boolean", short: "V", default: false },
        verbose: { type: "boolean", short: "v", default: false },
      port: { type: "string" },
      "max-runs": { type: "string" },
      timeout: { type: "string" },
      budget: { type: "string" },
      // Repeatable: --answer key=value --answer other=value
      answer: { type: "string", multiple: true },
      mermaid: { type: "boolean", default: false },
      // Optional value: `--html` alone picks a filename from the scene name.
      html: { type: "string" },
        // node:util parseArgs has no --no-x negation, so it is its own flag.
        "no-open": { type: "boolean", default: false },
        logout: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    // An unknown flag is a typo, not a crash — parseArgs throws, and the raw
    // stack trace tells the user nothing about what to do next.
    error(`${err instanceof Error ? err.message.split(". To specify")[0] : String(err)}\n`);
    info(USAGE);
    return 2;
  }

  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  // Version is checked before anything else so it works with no command.
  if (values.version || command === "version") {
    info(packageVersion());
    return 0;
  }

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
        maxRuns: num(values["max-runs"]),
        timeout: num(values.timeout),
        budget: num(values.budget),
        verbose: values.verbose ?? false,
      });
    case "resume":
      return cmdResume(rest[0], {
        maxRuns: num(values["max-runs"]),
        timeout: num(values.timeout),
        budget: num(values.budget),
        ...(values.answer ? { answers: values.answer } : {}),
        verbose: values.verbose ?? false,
      });
    case "serve": {
      const { serve } = await import("./serve.ts");
      const port = num(values.port) ?? 7777;
      // Convention is `.ensemble/scenes`; `./scenes` is honoured when a project
      // already uses it. An explicit argument always wins.
      const defaultScenesDir = (): string | undefined => {
        if (existsSync(".ensemble/scenes")) return ".ensemble/scenes";
        if (existsSync("scenes")) return "scenes"; // legacy layout
        return undefined;
      };

      const dir = rest[0] ?? defaultScenesDir();
      if (!dir) {
        // Serving a directory with no scenes is a silent dead end — the browser
        // shows an empty list and nothing explains why.
        error(
          `no scenes here — run \`ensemble serve\` from a project root that has an ` +
            `.ensemble/ folder.\n\n` +
            `Expected layout:\n` +
            `  .ensemble/scenes/*.mts   your workflows\n` +
            `  .ensemble/runs/          run artifacts (created for you)\n\n` +
            `Start one:  mkdir -p .ensemble/scenes\n` +
            `Or point at a folder:  ensemble serve <dir>`,
        );
        return 1;
      }
      try {
        await serve({
          port,
          scenesDir: dir,
          open: !(values["no-open"] ?? false),
        });
      } catch (err) {
        // One viewer per port, so a second `serve` is a common, recoverable
        // mistake — worth a sentence instead of a Node stack trace.
        if ((err as { code?: string }).code === "EADDRINUSE") {
          error(
            `port ${port} is already in use — another \`ensemble serve\` is probably running.\n` +
              `Open http://127.0.0.1:${port} to use it, or start this one elsewhere: ` +
              `ensemble serve --port ${port + 1}`,
          );
          return 1;
        }
        throw err;
      }
      return 0; // serve blocks until SIGINT
    }
    case "mcp": {
      // `mcp login <server>` / `mcp logout <server>` — the subject is the server.
      const sub = rest[0];
      if (sub === "login") return cmdLogin(rest[1], { logout: false });
      if (sub === "logout") return cmdLogin(rest[1], { logout: true });
      if (sub === "auth") return cmdLogin(rest[1], { logout: false });
      if (sub === "serve") {
        // stdio MCP: stdout belongs to the protocol; this call never returns.
        const { serveMcpStdio } = await import("./mcp-serve.ts");
        await serveMcpStdio();
        return 0;
      }
      return cmdMcp();
    }
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

const isServe =
  process.argv[2] === "serve" || (process.argv[2] === "mcp" && process.argv[3] === "serve");

main()
  .then((code) => finish(code, isServe))
  .catch((err: unknown) => {
    error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    finish(1, false);
  });
