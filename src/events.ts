/**
 * Run events.
 *
 * The engine emits these; the terminal logger and the web UI are both just
 * consumers. Keeping one event vocabulary means `graph run` and `graph serve`
 * can never drift in what they report.
 */
import type { State } from "./state.ts";

export interface NodeMeta {
  node: string;
  model: string;
  /** "model" = direct OpenRouter call, "agent" = opencode. */
  runtime: "model" | "agent";
  skills: string[];
  mcp: string[];
}

export type RunEvent =
  | { type: "run:start"; runId: string; scene: string; goal: string; nodes: NodeMeta[] }
  | { type: "target:start"; target: string; members: string[]; parallel: boolean }
  | { type: "node:start"; node: string; model: string; skills: string[] }
  /** Live token text from a model-runtime node (agent nodes report only on completion). */
  | { type: "node:delta"; node: string; delta: string }
  | { type: "node:retry"; node: string; problem: string }
  /** An agent node executed a tool. */
  | {
      type: "node:tool";
      node: string;
      tool: string;
      args: Record<string, unknown>;
      ok: boolean;
      preview: string;
      ms: number;
    }
  /** The node's outputs look like a summary of a much longer reply. */
  | { type: "node:lossy"; node: string; extractedLength: number; replyLength: number }
  | {
      type: "node:end";
      node: string;
      ok: boolean;
      text: string;
      providerID: string;
      modelID: string;
      cost: number;
      tokensIn: number;
      tokensOut: number;
      ms: number;
      error?: string;
    }
  | { type: "edge"; from: string; to: string; when?: string; skipped?: boolean }
  | { type: "state"; state: State }
  | {
      type: "run:end";
      ok: boolean;
      reason?: string;
      state: State;
      totalCost: number;
      nodeRuns: number;
      /** The USD cap the run was under, when one was set. */
      budget?: number;
    };

export type EventSink = (event: RunEvent) => void;

/** Fan-out so a run can drive the terminal and any number of SSE clients at once. */
export function combineSinks(...sinks: Array<EventSink | undefined>): EventSink {
  const active = sinks.filter((sink): sink is EventSink => typeof sink === "function");
  return (event) => {
    for (const sink of active) {
      try {
        sink(event);
      } catch {
        // A broken consumer (e.g. a disconnected browser) must never abort a run.
      }
    }
  };
}
