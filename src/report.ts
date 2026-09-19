/**
 * The live view — a terminal reporter, deliberately not a TUI.
 *
 * While a run is in flight you want two things: which node is working right
 * now, and what it said when it finished. That is a spinner line rewritten in
 * place, and it costs eighty dependency-free lines.
 *
 * A full-screen TUI was the other option and is the wrong one here. It would
 * take over the terminal, break `| jq`, and become a renderer this library has
 * to keep — which is exactly what was just removed along with the browser
 * viewer. The seam is `RunEvent` instead: anyone who wants a TUI, a web page or
 * a progress bar in someone else's UI consumes the same three events and owns
 * their own rendering. This module is just the one that ships.
 *
 * When stderr is not a TTY (a pipe, CI, a log file) the spinner disappears on
 * its own and each node prints one plain line when it completes.
 */
import type { RunEvent, RunStep } from "./execute.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR = "\x1b[2K\r";

const dim = (text: string, color: boolean): string => (color ? `\x1b[2m${text}\x1b[0m` : text);
const bold = (text: string, color: boolean): string => (color ? `\x1b[1m${text}\x1b[0m` : text);

export const money = (usd: number): string =>
  usd === 0 ? "free" : usd < 0.01 ? `$${usd.toFixed(6)}` : `$${usd.toFixed(4)}`;

const BADGE: Record<RunStep["kind"], string> = { decide: "?", work: "⚙", code: "ƒ", model: "✦", mcp: "⇄" };

/** What a finished step said, in one line. */
export function summarise(step: RunStep, color = false): string {
  // A lane tag only when there is more than one lane to tell apart.
  const name = step.lane && step.lane !== "main" ? `${step.node} ${dim(`[${step.lane}]`, color)}` : step.node;
  const head = `${BADGE[step.kind]} ${name.padEnd(16 + (name.length - step.node.length))} ${dim(`${String(step.ms).padStart(6)}ms ${money(step.cost).padStart(10)}`, color)}`;
  if (step.error) return `${head}  ✗ ${step.error}`;

  if (step.answers) {
    const said = Object.entries(step.answers)
      .map(([key, answer]) => {
        const value = typeof answer.value === "number" ? answer.value.toFixed(2) : answer.value;
        const shown = `${key}=${bold(String(value), color)}`;
        return answer.confidence === undefined ? shown : `${shown}${dim(` ${answer.confidence.toFixed(2)}`, color)}`;
      })
      .join("  ");
    const gate = step.gate && !step.gate.passed ? `  ⚠ gated at ${step.gate.measured.toFixed(2)} < ${step.gate.min}` : "";
    return `${head}  ${said}${gate}`;
  }

  const wrote = Object.keys(step.writes ?? {});
  return wrote.length ? `${head}  ${dim(`wrote ${wrote.join(", ")}`, color)}` : head;
}

export interface ReporterOptions {
  stream?: NodeJS.WriteStream;
  /** Force the spinner on or off. Defaults to whether the stream is a TTY. */
  live?: boolean;
  color?: boolean;
}

/**
 * Build an `onEvent` handler that renders progress to a stream.
 *
 * Returns the handler with a `stop()` attached — call it if you abandon a run
 * without waiting for `run:end`, or the spinner interval keeps the process
 * alive.
 */
export function reporter(options: ReporterOptions = {}): ((event: RunEvent) => void) & { stop(): void } {
  const stream = options.stream ?? process.stderr;
  const live = options.live ?? Boolean(stream.isTTY);
  const color = options.color ?? Boolean(stream.isTTY);

  let timer: NodeJS.Timeout | undefined;
  let frame = 0;

  const stop = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    stream.write(CLEAR);
  };

  const spin = (label: string): void => {
    stop();
    if (!live) return;
    frame = 0;
    const paint = (): void => {
      stream.write(`${CLEAR}${dim(FRAMES[frame % FRAMES.length]!, color)} ${label}`);
      frame++;
    };
    paint();
    timer = setInterval(paint, 80);
    timer.unref?.();
  };

  const handle = (event: RunEvent): void => {
    switch (event.type) {
      case "node:start":
        spin(`${event.node} ${dim(`— ${event.waiting}`, color)}`);
        return;
      case "node:end":
        stop();
        stream.write(`  ${summarise(event.step, color)}\n`);
        return;
      case "run:end": {
        stop();
        const { status, cost } = event.run.run;
        const mark = status === "completed" ? "✓" : "✗";
        stream.write(`  ${mark} ${status} · ${money(cost.total)} · ${event.run.steps.length} steps\n`);
        return;
      }
    }
  };

  return Object.assign(handle, { stop });
}
