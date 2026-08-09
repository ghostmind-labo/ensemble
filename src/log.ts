/** Terminal output. No dependency — ANSI codes directly, disabled when not a TTY. */

const on = process.stdout.isTTY && !process.env["NO_COLOR"];
const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
};

export function info(msg: string): void {
  console.log(msg);
}

export function warn(msg: string): void {
  console.warn(`${c.yellow("warn")} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${c.red("error")} ${msg}`);
}

/** `1.2s` / `340ms` / `2m 05s` — short enough to sit inline in a run log. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${String(sec).padStart(2, "0")}s`;
}

export function cost(usd: number): string {
  if (usd <= 0) return "";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Indents every line of a block so node transcripts nest under their header. */
export function indent(text: string, pad = "  "): string {
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

/** Clips long transcripts in the streaming log; full text still goes to state. */
export function clip(text: string, max = 600): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n${c.dim(`… +${trimmed.length - max} more chars`)}`;
}
