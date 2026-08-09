/**
 * `graph serve` — a local server for the visual viewer.
 *
 * Deliberately dependency-free (node:http) and deliberately local-only: it binds
 * 127.0.0.1 and reads/writes files in the project it was started from. Scenes on
 * disk stay the source of truth; this is a window onto them, not a second store.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, watch } from "node:fs";
import { join, dirname, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "./registry.ts";
import { loadScene, SceneError } from "./scene.ts";
import { toLayout, toMermaid } from "./view.ts";
import { runScene } from "./engine.ts";
import type { RunEvent } from "./events.ts";
import { c, info, error } from "./log.ts";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");

interface Client {
  res: ServerResponse;
  id: number;
}

export interface ServeOptions {
  port: number;
  scenesDir: string;
  open: boolean;
}

export async function serve(opts: ServeOptions): Promise<void> {
  const root = resolve(process.cwd());
  const scenesDir = resolve(opts.scenesDir);

  const clients = new Set<Client>();
  let nextClientId = 1;

  /** Replayed to any browser that connects mid-run so it isn't stuck on an empty canvas. */
  let currentRun: { events: RunEvent[]; active: boolean; abort: AbortController } | undefined;

  const broadcast = (payload: unknown): void => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.res.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  };

  const listScenes = (): string[] => {
    if (!existsSync(scenesDir)) return [];
    return readdirSync(scenesDir)
      .filter((f) => [".ts", ".mts"].includes(extname(f)))
      .sort();
  };

  /** Confines every scene read/write to the scenes directory. */
  const resolveScene = (name: string): string | undefined => {
    const file = resolve(join(scenesDir, basename(name)));
    if (!file.startsWith(scenesDir)) return undefined;
    return existsSync(file) ? file : undefined;
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    res.end(payload);
  };

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1 << 20) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;

      try {
        // ---- static UI ----
        if (req.method === "GET" && (path === "/" || path === "/index.html")) {
          const file = join(UI_DIR, "index.html");
          if (!existsSync(file)) {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("ui/index.html is missing");
            return;
          }
          const html = readFileSync(file, "utf8");
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(html);
          return;
        }

        // ---- scene list ----
        if (req.method === "GET" && path === "/api/scenes") {
          const registry = loadRegistry(root);
          const scenes = await Promise.all(listScenes().map(async (file) => {
            try {
              const scene = await loadScene(join(scenesDir, file), registry);
              return {
                file,
                name: scene.name,
                nodes: Object.keys(scene.nodes).length,
                edges: scene.edges.length,
                valid: true as const,
              };
            } catch (err) {
              return {
                file,
                name: file,
                nodes: 0,
                edges: 0,
                valid: false as const,
                problems: err instanceof SceneError ? err.problems : [String(err)],
              };
            }
          }));
          json(res, 200, { scenes, scenesDir });
          return;
        }

        // ---- one scene: layout + source ----
        if (req.method === "GET" && path === "/api/scene") {
          const name = url.searchParams.get("file") ?? "";
          const file = resolveScene(name);
          if (!file) {
            json(res, 404, { error: `no such scene: ${name}` });
            return;
          }
          try {
            const scene = await loadScene(file, loadRegistry(root));
            json(res, 200, {
              file: basename(file),
              layout: toLayout(scene),
              mermaid: toMermaid(scene),
              source: readFileSync(file, "utf8"),
            });
          } catch (err) {
            json(res, 422, {
              error: "invalid scene",
              problems: err instanceof SceneError ? err.problems : [String(err)],
              source: readFileSync(file, "utf8"),
            });
          }
          return;
        }

        // ---- save a scene (the "modify it" path) ----
        if (req.method === "PUT" && path === "/api/scene") {
          const body = await readBody(req);
          const file = resolveScene(String(body["file"] ?? ""));
          const source = String(body["source"] ?? "");

          if (!file) {
            json(res, 404, { error: "no such scene" });
            return;
          }
          if (!source.trim()) {
            json(res, 400, { error: "source is empty" });
            return;
          }

          // Validate BEFORE overwriting: the edited source goes to a sibling temp
          // file, gets imported and checked, and only then replaces the original.
          // A broken save can never destroy a working scene.
          const tmp = join(scenesDir, `.ensemble-edit-${Date.now()}-${basename(file)}`);
          try {
            const { writeFileSync: write, rmSync: rm, renameSync: rename } = await import("node:fs");
            write(tmp, source, "utf8");
            try {
              await loadScene(tmp, loadRegistry(root));
            } catch (err) {
              rm(tmp);
              json(res, 422, {
                error: "not saved — the edited scene is invalid",
                problems: err instanceof SceneError ? err.problems : [String(err)],
              });
              return;
            }
            rename(tmp, file);
            broadcast({ type: "scenes:changed", file: basename(file) });
            json(res, 200, { saved: true });
          } catch (err) {
            json(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // ---- registry (drives future pickers) ----
        if (req.method === "GET" && path === "/api/registry") {
          const registry = loadRegistry(root);
          json(res, 200, {
            skills: [...registry.skills.values()],
            mcp: [...registry.mcp.values()],
            problems: registry.problems,
            configPath: registry.configPath,
          });
          return;
        }

        // ---- start a run ----
        if (req.method === "POST" && path === "/api/run") {
          if (currentRun?.active) {
            json(res, 409, { error: "a run is already in progress" });
            return;
          }

          const body = await readBody(req);
          const file = resolveScene(String(body["file"] ?? ""));
          const goal = String(body["goal"] ?? "").trim();

          if (!file) {
            json(res, 404, { error: "no such scene" });
            return;
          }
          if (!goal) {
            json(res, 400, { error: "goal is required" });
            return;
          }

          let scene;
          try {
            scene = await loadScene(file, loadRegistry(root));
          } catch (err) {
            json(res, 422, {
              error: "invalid scene",
              problems: err instanceof SceneError ? err.problems : [String(err)],
            });
            return;
          }

          const abort = new AbortController();
          currentRun = { events: [], active: true, abort };
          json(res, 202, { started: true });

          void runScene(scene, goal, {
            signal: abort.signal,
            onEvent: (event) => {
              currentRun?.events.push(event);
              broadcast(event);
            },
          })
            .catch((err: unknown) => {
              broadcast({
                type: "run:end",
                ok: false,
                reason: err instanceof Error ? err.message : String(err),
                state: {},
                totalCost: 0,
                nodeRuns: 0,
              } satisfies RunEvent);
            })
            .finally(() => {
              if (currentRun) currentRun.active = false;
            });
          return;
        }

        // ---- stop a run ----
        if (req.method === "POST" && path === "/api/stop") {
          currentRun?.abort.abort();
          json(res, 200, { stopped: true });
          return;
        }

        // ---- event stream ----
        if (req.method === "GET" && path === "/api/events") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          res.write(": connected\n\n");

          const client: Client = { res, id: nextClientId++ };
          clients.add(client);

          // Replay the in-flight run so a late browser sees the full picture.
          if (currentRun) {
            for (const event of currentRun.events) {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          }

          const keepAlive = setInterval(() => {
            try {
              res.write(": ping\n\n");
            } catch {
              clearInterval(keepAlive);
            }
          }, 25_000);

          req.on("close", () => {
            clearInterval(keepAlive);
            clients.delete(client);
          });
          return;
        }

        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  // Re-render the browser when a scene file changes on disk.
  if (existsSync(scenesDir)) {
    try {
      watch(scenesDir, { persistent: false }, (_event, filename) => {
        if (filename && [".ts", ".mts"].includes(extname(filename))) {
          broadcast({ type: "scenes:changed", file: filename });
        }
      });
    } catch {
      // Watching is a convenience; the UI has a manual refresh too.
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(opts.port, "127.0.0.1", () => resolveListen());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const href = `http://127.0.0.1:${port}`;

  info(`${c.bold("ensemble serve")} ${c.dim("·")} ${c.cyan(href)}`);
  info(c.dim(`scenes: ${scenesDir}`));
  info(c.dim(`${listScenes().length} scene(s) · watching for changes · ctrl-c to stop`));

  if (opts.open) {
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
      spawn(cmd, [href], { stdio: "ignore", detached: true }).unref();
    } catch {
      // Non-fatal: the URL is printed above.
    }
  }

  process.on("SIGINT", () => {
    info(c.dim("\nstopping…"));
    currentRun?.abort.abort();
    server.close();
    process.exit(0);
  });
}

export function serveFailed(err: unknown): void {
  error(err instanceof Error ? err.message : String(err));
}
