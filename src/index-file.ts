/**
 * The machine-level run index — how one viewer finds every run on the box.
 *
 * A run's journal is the authoritative record, but journals live inside each
 * project's `.ensemble/runs/`, and nothing knows which projects exist. This file
 * is the discovery layer: one line per run, pointing at its directory.
 *
 * **Append-only JSONL, deliberately.** Several runners write concurrently — an
 * agent fanning out, a CLI run, a resume — and N processes rewriting one nested
 * JSON document would corrupt it. A single short `appendFileSync` is atomic
 * enough for this, and the reader assembles the project → scene → runs tree.
 *
 * It holds only pointers, so it is disposable: delete it and it refills as runs
 * happen. The journals remain the truth, which is why a stale or missing line
 * can never be worse than a missing row in a list.
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

export interface IndexEntry {
  runId: string;
  /** Absolute path to the run directory — where the journal actually lives. */
  runDir: string;
  /** Project root, i.e. the directory that owns `.ensemble/`. */
  project: string;
  scene: string;
  /** Absolute path to the scene file, so the viewer can offer to open it. */
  sceneFile: string;
  startedAt: string;
}

export function indexPath(): string {
  return process.env["ENSEMBLE_INDEX"] ?? join(homedir(), ".ensemble", "index.jsonl");
}

/**
 * Records a run once, at start. Never throws: failing to be listed must not
 * fail the run itself.
 */
export function recordRun(entry: IndexEntry): void {
  try {
    const file = indexPath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Discovery is a convenience; the journal in the run dir is the real record.
  }
}

/**
 * Every indexed run, newest first, deduped by runId (last line wins).
 *
 * Entries whose directory has since been deleted are dropped, so a pruned
 * `.ensemble/` does not leave ghosts in the list forever.
 */
export function readIndex(limit = 200): IndexEntry[] {
  const file = indexPath();
  if (!existsSync(file)) return [];

  const byId = new Map<string, IndexEntry>();
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as IndexEntry;
        if (entry.runId && entry.runDir) byId.set(entry.runId, entry);
      } catch {
        // One malformed line must not hide every other run.
      }
    }
  } catch {
    return [];
  }

  return [...byId.values()]
    .filter((e) => existsSync(e.runDir))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, limit);
}

/**
 * Rewrites the file with only live entries.
 *
 * Append-only grows forever, so this is the compaction step — called when the
 * viewer reads and finds a lot of dead weight, never on the run path.
 */
export function compactIndex(): number {
  try {
    const live = readIndex(10_000);
    writeFileSync(indexPath(), live.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
    return live.length;
  } catch {
    return 0;
  }
}

/** `…/myapp/.ensemble/runs/<id>` → `…/myapp`, the project that owns the run. */
export function projectOfRunDir(runDir: string): string {
  // runs/<id> → runs → .ensemble → project
  return dirname(dirname(dirname(runDir)));
}

/** A short, human label for a project directory. */
export function projectLabel(project: string): string {
  return basename(project) || project;
}
