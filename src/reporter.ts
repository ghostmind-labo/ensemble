/**
 * Terminal renderer for run events.
 *
 * Pulled out of the engine so the engine only emits data. `graph run` attaches
 * this; `graph serve` attaches an SSE forwarder instead.
 */
import type { RunEvent, EventSink } from "./events.ts";
import { c, info, warn, duration, cost, indent, clip } from "./log.ts";

export function createTerminalReporter(opts: { verbose: boolean }): EventSink {
  // Model → node, so a completed block can name the node even though several ran
  // concurrently. Without this, a group of three prints three headers and three
  // footers in completion order, and nothing says which footer belongs to which.
  const models = new Map<string, string>();
  const warnings = new Map<string, string[]>();
  // node → aggregated spend, for the end-of-run breakdown.
  const spend = new Map<string, { runs: number; cost: number; tokensIn: number; tokensOut: number }>();

  return (event: RunEvent): void => {
    switch (event.type) {
      case "run:start":
        info(
          `${c.bold(event.scene)} ${c.dim("·")} ${event.nodes.length} nodes ` +
            `${c.dim("·")} run ${c.dim(event.runId)}`,
        );
        info(c.dim(`goal: ${event.goal}`));
        break;

      case "target:start":
        if (event.parallel) {
          info(`\n${c.dim("┏")} group ${c.bold(event.target)} ${c.dim(`(${event.members.length} in parallel)`)}`);
        }
        break;

      // Starting is announced as a single line. The body is held back and printed
      // as one contiguous block on completion, so concurrent nodes cannot
      // interleave their output.
      case "node:start":
        models.set(event.node, event.model);
        warnings.delete(event.node);
        info(
          `${c.dim("▶")} ${c.bold(c.magenta(event.node))} ${c.dim(event.model)}` +
            (event.skills.length > 0 ? c.dim(`  skills: ${event.skills.join(", ")}`) : ""),
        );
        break;

      case "node:tool":
        info(
          `${c.dim("│")}  ${event.ok ? c.cyan("⚒") : c.red("⚒")} ${c.bold(event.tool)} ` +
            `${c.dim(`${duration(event.ms)} · ${event.preview}`)}`,
        );
        break;

      case "node:retry":
        warn(`${event.node}: ${event.problem} — reprompting once`);
        break;

      case "node:ask":
        info(
          `\n${c.cyan("⏸")} ${c.bold(c.magenta(event.node))} ${c.dim("needs an answer")}\n` +
            indent(event.question, "   ") +
            `\n${c.dim(`   expects: ${event.outputs.join(", ")}`)}`,
        );
        break;

      case "node:lossy":
        warnings.set(event.node, [
          ...(warnings.get(event.node) ?? []),
          `kept only ${event.extractedLength} of ${event.replyLength} chars — the model wrote its ` +
            `answer as prose and summarised into the json block; the detail was dropped`,
        ]);
        break;

      case "node:end": {
        const tally = spend.get(event.node) ?? { runs: 0, cost: 0, tokensIn: 0, tokensOut: 0 };
        tally.runs += 1;
        tally.cost += event.cost;
        tally.tokensIn += event.tokensIn;
        tally.tokensOut += event.tokensOut;
        spend.set(event.node, tally);

        const model = models.get(event.node) ?? `${event.providerID}/${event.modelID}`;
        const head = `\n${c.dim("┌─")} ${c.bold(c.magenta(event.node))} ${c.dim(model)}`;

        if (!event.ok) {
          info(head);
          if (event.text) info(indent(c.dim(clip(event.text, 1200)), `${c.dim("│")}  `));
          info(`${c.dim("└─")} ${c.bold(c.magenta(event.node))} ${c.red("failed")} ${event.error ?? "unknown error"}`);
          break;
        }

        const meta = [
          c.dim(`${event.tokensIn}→${event.tokensOut} tok`),
          cost(event.cost) ? c.dim(cost(event.cost)) : "",
          c.dim(duration(event.ms)),
        ]
          .filter(Boolean)
          .join(c.dim(" · "));

        info(head);
        const body = opts.verbose ? event.text.trim() : clip(event.text);
        if (body) info(indent(c.dim(body), `${c.dim("│")}  `));
        for (const note of warnings.get(event.node) ?? []) {
          info(`${c.dim("│")}  ${c.yellow("! ")}${c.yellow(note)}`);
        }
        info(`${c.dim("└─")} ${c.bold(c.magenta(event.node))} ${c.green("ok")} ${meta}`);
        break;
      }

      case "edge":
        if (event.skipped) {
          info(c.dim(`  ${event.from}→${event.to} exhausted maxLoops, skipping`));
        } else {
          info(c.dim(`  → ${event.to}${event.when ? ` (${event.when})` : ""}`));
        }
        break;

      case "run:end": {
        if (event.ok) {
          const under =
            event.budget !== undefined ? ` of $${event.budget} budget` : "";
          info(
            `\n${c.green(c.bold("done"))} ${c.dim(`${event.nodeRuns} node run(s)`)}` +
              `${cost(event.totalCost) ? c.dim(` · ${cost(event.totalCost)}${under}`) : ""}`,
          );
        }

        // Where the money went — printed for failed runs too, since "which node
        // burned the budget" matters most exactly when a run died on it.
        if (event.totalCost > 0 && spend.size > 1) {
          const rows = [...spend.entries()].sort((a, b) => b[1].cost - a[1].cost);
          const width = Math.max(...rows.map(([node]) => node.length));
          info(c.dim("\ncost by node"));
          for (const [node, t] of rows) {
            const share = Math.round((t.cost / event.totalCost) * 100);
            info(
              `  ${c.magenta(node.padEnd(width))}  ${(cost(t.cost) || "$0").padStart(7)}` +
                c.dim(
                  `  ${String(share).padStart(3)}%  ${t.runs} run(s) · ${t.tokensIn}→${t.tokensOut} tok`,
                ),
            );
          }
        }
        break;
      }

      case "state":
        break;
    }
  };
}
