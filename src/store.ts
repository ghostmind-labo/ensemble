/**
 * The run store — where a run's artifacts go, as an OBJECT.
 *
 * The engine does not write files; it hands artifacts to a store object. The
 * default (`fileRunStore`) writes exactly what ensemble has always written:
 * state.json, costs.json, journal.json, events.jsonl, result.md, and one line
 * in the machine index. Swapping the object (RunOptions.store) is how a remote
 * mirror, a database, or a test capture happens — without engine edits.
 *
 * One honest caveat, stated rather than hidden: `resume` reads the journal from
 * the run DIRECTORY. A custom store that wants its runs to stay resumable must
 * keep writing those files too — the easy way is to wrap `fileRunStore` and
 * add behaviour around it rather than replace it.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { State } from "./dsl.ts";
import type { RunEvent } from "./events.ts";
import { recordRun, type IndexEntry } from "./index-file.ts";

export interface CostsArtifact {
  totalCost: number;
  nodeRuns: number;
  budget?: number;
  nodes: Record<string, { runs: number; cost: number; tokensIn: number; tokensOut: number }>;
}

export interface RunStore {
  name: string;
  /**
   * Called once before anything else — a file store creates the run directory
   * here. A store that keeps nothing on disk (replay's null store) omits it,
   * and then no directory is ever created for the run.
   */
  prepare?(runDir: string): void;
  /** The blackboard, after every target. */
  writeState(runDir: string, state: State): void;
  /** The per-node receipt, alongside the state. */
  writeCosts(runDir: string, costs: CostsArtifact): void;
  /** The graph position — what resume uses. Shape owned by the engine. */
  writeJournal(runDir: string, journal: unknown): void;
  /** One event, as it happens (node:delta excluded upstream). */
  appendEvent(runDir: string, event: RunEvent): void;
  /** The rendered result, on clean completion. */
  writeResult(runDir: string, markdown: string): void;
  /** One pointer line in the machine-level index, at run start. */
  recordIndex(entry: IndexEntry): void;
}

export const fileRunStore: RunStore = {
  name: "file",
  prepare: (runDir) => mkdirSync(runDir, { recursive: true }),
  writeState: (runDir, state) =>
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2), "utf8"),
  writeCosts: (runDir, costs) =>
    writeFileSync(join(runDir, "costs.json"), JSON.stringify(costs, null, 2), "utf8"),
  writeJournal: (runDir, journal) =>
    writeFileSync(join(runDir, "journal.json"), JSON.stringify(journal, null, 2), "utf8"),
  appendEvent: (runDir, event) =>
    appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8"),
  writeResult: (runDir, markdown) => writeFileSync(join(runDir, "result.md"), markdown, "utf8"),
  recordIndex: (entry) => recordRun(entry),
};

/**
 * The store that keeps nothing — every artifact is discarded and no run
 * directory is created. This is what makes a replay weightless: the run is
 * real (real engine, real predicates, real schemas) but it leaves no trace in
 * `.ensemble/runs/` and no line in the machine index, so a thousand replays
 * cost the viewer nothing to scroll past.
 */
export const nullRunStore: RunStore = {
  name: "null",
  writeState: () => {},
  writeCosts: () => {},
  writeJournal: () => {},
  appendEvent: () => {},
  writeResult: () => {},
  recordIndex: () => {},
};
