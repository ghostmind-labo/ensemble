/**
 * Bounded subprocess execution — one implementation, three callers.
 *
 * The subtlety this module exists for is the KILL. `child.kill()` reaches only
 * the shell; anything the shell started keeps running with the pipes still
 * open, so the parent hangs past its own timeout waiting for EOF. Spawning
 * `detached` puts the child in its own process group and `process.kill(-pid)`
 * reaches the whole tree. That bug was found once, in research's `measure`;
 * this is that fix, generalised so the `bash` tool and the agent-CLI backends
 * inherit it rather than rediscovering it.
 *
 * Nothing here throws. A crash, a timeout and a non-zero exit are all *results*
 * — the caller decides what they mean.
 */
import { spawn } from "node:child_process";

export interface BoundedResult {
  /** stdout alone — what a machine-readable CLI writes its JSON to. */
  stdout: string;
  /** stderr alone — diagnostics, usually the reason for a non-zero exit. */
  stderr: string;
  /** Both, interleaved in arrival order: what a human (or a scraper) wants. */
  output: string;
  ms: number;
  timedOut: boolean;
  /** null when the process died to a signal or never started. */
  exitCode: number | null;
}

export interface BoundedOptions {
  cwd: string;
  timeoutMs: number;
  /** true → the command string goes through a shell; false → argv[0] is the binary. */
  shell?: boolean;
  /** Overlaid on the parent environment, not a replacement for it. */
  env?: Record<string, string>;
  /** Per-stream ceiling; the tail is kept, since that is where the answer is. */
  maxOutput?: number;
  signal?: AbortSignal;
}

/** How long we wait for a well-behaved exit after SIGTERM before SIGKILL. */
const GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT = 200_000;

export function spawnBounded(command: string | string[], opts: BoundedOptions): Promise<BoundedResult> {
  const max = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const argv = Array.isArray(command) ? command : [command];

  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(argv[0] ?? "", argv.slice(1), {
      cwd: opts.cwd,
      shell: opts.shell ?? false,
      // Its own process group, so the kill below reaches every descendant.
      detached: true,
      // stdin CLOSED, never inherited. Every coding-agent CLI defaults to
      // interactive; with an inherited stdin a missing --yes flag turns into a
      // silent hang rather than a fast, legible failure.
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });

    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };

    let stdout = "";
    let stderr = "";
    let output = "";
    let timedOut = false;
    let settled = false;

    const keep = (chunk: Buffer, stream: "out" | "err"): void => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-max);
      if (stream === "out") stdout = (stdout + text).slice(-max);
      else stderr = (stderr + text).slice(-max);
    };
    child.stdout.on("data", (c: Buffer) => keep(c, "out"));
    child.stderr.on("data", (c: Buffer) => keep(c, "err"));

    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), GRACE_MS).unref();
    }, opts.timeoutMs);

    const onAbort = (): void => kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (exitCode: number | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const tail = extra ? `\n${extra}` : "";
      done({
        stdout,
        stderr: stderr + tail,
        output: output + tail,
        ms: Date.now() - started,
        timedOut,
        exitCode,
      });
    };

    child.on("close", (exitCode) => settle(exitCode));
    // ENOENT and friends: a missing binary is a result, not an exception.
    child.on("error", (err) => settle(null, err.message));
  });
}
