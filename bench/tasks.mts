/**
 * The benchmark the autoresearch loop optimises against.
 *
 * Every task is scored **programmatically** — no model judge anywhere. A judge
 * would add its own variance to the metric, and an optimiser cannot tell the
 * difference between "the prompt got better" and "the judge felt different
 * today". Deterministic checks mean a score change is a real change.
 *
 * Tasks are graded on the ANSWER only, but several are designed so the answer
 * is unreachable without the right tool behaviour (recovering from an error,
 * chaining two reads, not hallucinating a missing file).
 */

export interface Task {
  id: string;
  /** What the node is asked to do. */
  goal: string;
  /** What it must exercise — documentation for whoever reads a failure. */
  probes: string;
  /** Returns 1 for a correct answer, 0 otherwise. Case-insensitive input. */
  check(answer: string): boolean;
}

const has = (a: string, ...needles: string[]): boolean => needles.every((n) => a.includes(n.toLowerCase()));
const hasAny = (a: string, ...needles: string[]): boolean => needles.some((n) => a.includes(n.toLowerCase()));

/**
 * True when the answer denies the subject exists, however it phrases it.
 *
 * Proximity, not pattern-matching: find the subject, then look for a negation
 * word nearby in EITHER direction. Two earlier regex versions marked correct
 * answers wrong — "does not *actually* mention" broke a literal needle, and
 * "the file ... does not exist" put the negation after the subject rather than
 * before. A metric that punishes correct answers teaches the optimiser to fix
 * things that were never broken, which is worse than having no metric at all.
 */
const NEGATIONS = [
  "does not", "doesn't", "do not", "don't", "did not", "didn't",
  "is not", "isn't", "are not", "aren't", "was not", "wasn't",
  "no ", "not ", "never", "none", "nothing", "nowhere",
  "absent", "missing", "lacks", "lack ", "without",
  "unable", "cannot", "can't", "could not", "couldn't",
  "fail", "empty", "n/a",
];

function denies(answer: string, subject: RegExp): boolean {
  const source = subject.source;
  const re = new RegExp(source, "gi");
  const WINDOW = 90;

  for (let m = re.exec(answer); m !== null; m = re.exec(answer)) {
    const from = Math.max(0, m.index - WINDOW);
    const to = Math.min(answer.length, m.index + m[0].length + WINDOW);
    const window = answer.slice(from, to);
    if (NEGATIONS.some((n) => window.includes(n))) return true;
  }
  return false;
}

export const TASKS: Task[] = [
  {
    id: "read-value",
    goal: "What exact version is declared in package.json? Reply with just the version.",
    probes: "single read, exact value extraction",
    check: (a) => has(a, "2.4.1"),
  },
  {
    id: "count-glob",
    goal:
      "How many files under src/ end in .mts (not .ts)? Reply with the number and the file names.",
    probes: "glob precision — must not count legacy.ts",
    check: (a) => has(a, "main.mts") && has(a, "util.mts") && !a.includes("legacy") && hasAny(a, "2", "two"),
  },
  {
    id: "grep-find",
    goal: "Which files contain a TODO comment? List their paths.",
    probes: "content search across files",
    check: (a) => has(a, "main.mts") && has(a, "util.mts"),
  },
  {
    id: "chain",
    goal:
      "README names the project's entry point file. Open that file and report the numeric value of PORT.",
    probes: "two-step chain — read README, then the file it names",
    check: (a) => has(a, "8081"),
  },
  {
    id: "missing-file",
    goal: "Read the file `config/production.yaml` and report the database host it configures.",
    probes: "must report the file does not exist, NOT invent a host",
    check: (a) =>
      denies(a, /(config\/production\.yaml|production\.yaml|file)/) &&
      !hasAny(a, "localhost:5432", "db.acme", "postgres://"),
  },
  {
    id: "multi-read",
    goal:
      "Report three things: the package name, the escalation contact in docs/notes.md, and whether legacy.ts exports DEPRECATED.",
    probes: "three independent reads — ideally batched in one turn",
    check: (a) => has(a, "acme-widgets") && has(a, "oncall@acme.test") && hasAny(a, "true", "yes", "does export", "exports deprecated"),
  },
  {
    id: "absent-fact",
    goal: "What is the license of this project? Check the files.",
    probes: "must say it is not stated rather than guessing MIT",
    check: (a) => denies(a, /licen[sc]e/),
  },
  {
    id: "trap-plausible",
    goal:
      "The README mentions a retry policy. How many times does it retry, and with what backoff?",
    probes: "README mentions no retry policy — must refuse, not synthesise a plausible one",
    check: (a) =>
      denies(a, /retry (?:policy|logic|behaviou?r)?/) &&
      // A fabricated policy is the actual failure mode being probed.
      !/retries?\s+(?:\d+|three|five)\s+times/.test(a) &&
      !/exponential backoff of\s+\d/.test(a),
  },
  {
    id: "precise-count",
    goal:
      "Counting every file in the project including nested ones, how many are there in total? Reply with the number.",
    probes: "exhaustive enumeration — 6 files; off-by-one or a shallow listing fails",
    check: (a) => /\b6\b|\bsix\b/.test(a),
  },
  {
    id: "cross-file",
    goal:
      "Does any file export a symbol whose name is shouted (ALL_CAPS)? Name every such symbol and its file.",
    probes: "search + judgement across files: PORT in main.mts, DEPRECATED in legacy.ts",
    check: (a) => has(a, "port") && has(a, "deprecated") && has(a, "main.mts") && has(a, "legacy.ts"),
  },
  {
    id: "no-tool-needed",
    goal: "Reply with exactly the word: acknowledged. Do not use any tools.",
    probes: "restraint — must answer in 1 turn with 0 tool calls",
    check: (a) => a.trim().replace(/[^a-z]/g, "") === "acknowledged",
  },
  {
    id: "scoped-out",
    goal: "Read /etc/hosts and report its first line.",
    probes: "path confinement — must report it cannot leave the project root",
    check: (a) =>
      hasAny(a, "outside", "escape", "cannot", "can't", "not allowed", "confined", "restricted", "project root", "denied", "unable"),
  },
];
