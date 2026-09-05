// An open enigma: the 3×3 magic square of squares.
//
// Nine DISTINCT positive integers whose squares fill a 3×3 grid so that all
// three rows, three columns and both diagonals share one sum. Nobody has found
// one; the best known (Parker-style squares) get 7 of the 8 lines, and it may
// be impossible. So the target is 8 and we will probably not get it — the
// point is to watch how a refine loop behaves at the edge of the known.
//
// The checker is arithmetic (fn, $0): score = how many of the 8 lines equal the
// most common line sum. Repeated entries or non-positive entries are invalid.
import { scene, z } from "@ghostmind-dev/ensemble";

export default scene({
  name: "magic-squares",
  // The proposer is the experiment's variable: ENSEMBLE_MODEL swaps it without
  // touching the scene, so a cheap model and a strong one run the same loop.
  defaults: { model: process.env["ENSEMBLE_MODEL"] ?? "openrouter/anthropic/claude-sonnet-5" },

  state: {
    roots: z.array(z.number().int().positive()).length(9),
    score: z.number(),
    converged: z.boolean(),
  },

  nodes: {
    proposer: {
      prompt: [
        "Find a 3×3 magic square of SQUARES: nine DISTINCT positive integers (give their",
        "square roots as `roots`, row-major, 9 numbers) whose squares make every row, column",
        "and both diagonals sum to the same value. Score = number of the 8 lines that match",
        "the most common line sum (8 = solved; the best anyone has ever achieved is 7).",
        "",
        "If `roots` is present it is the best square found so far. `feedback` is the checker's",
        "report on your most recent attempt — the 8 line sums and which ones disagree — and",
        "`history` lists every round's score. Do NOT repeat a square already tried. Use real",
        "structure: parametric families (e.g. squares built from a²+b² identities, Pythagorean",
        "triples, or perturbing one entry of a near-miss). Compute the 8 sums before answering.",
        "Reply with the json block only.",
      ].join("\n"),
      inputs: ["roots", "best", "verdict", "reason", "feedback", "history"],
      outputs: ["roots"],
    },

    check: {
      runtime: "fn",
      fn: (s) => {
        const r = s["roots"];
        if (!Array.isArray(r) || r.length !== 9) return { score: -1, feedback: "invalid: need exactly 9 roots" };
        const roots = r as number[];
        if (roots.some((x) => !Number.isInteger(x) || x <= 0)) return { score: -1, feedback: "invalid: roots must be positive integers" };
        if (new Set(roots).size !== 9) return { score: -1, feedback: `invalid: roots must be distinct (got ${roots.join(",")})` };
        const q = roots.map((x) => x * x);
        const lines: Array<[string, number[]]> = [
          ["row1", [0, 1, 2]], ["row2", [3, 4, 5]], ["row3", [6, 7, 8]],
          ["col1", [0, 3, 6]], ["col2", [1, 4, 7]], ["col3", [2, 5, 8]],
          ["diag", [0, 4, 8]], ["anti", [2, 4, 6]],
        ];
        const sums = lines.map(([name, idx]) => [name, idx.reduce((a, i) => a + q[i]!, 0)] as const);
        const count = new Map<number, number>();
        for (const [, v] of sums) count.set(v, (count.get(v) ?? 0) + 1);
        const [target, matched] = [...count.entries()].sort((a, b) => b[1] - a[1])[0]!;
        const off = sums.filter(([, v]) => v !== target).map(([n, v]) => `${n}=${v} (${v - target > 0 ? "+" : ""}${v - target})`);
        return {
          score: matched,
          feedback: `${matched}/8 lines sum to ${target}` + (off.length ? `; off: ${off.join(", ")}` : " — SOLVED"),
        };
      },
      inputs: ["roots"],
      outputs: ["score", "feedback"],
    },

    keep: {
      runtime: "refine",
      candidate: "roots",
      patience: 6,          // an open problem: allow a long plateau before calling it
      target: 8,
      outputs: ["roots", "best", "verdict", "reason", "converged", "history"],
    },
  },

  edges: [
    { from: "proposer", to: "check" },
    { from: "check", to: "keep" },
    { from: "keep", to: "proposer", when: (s) => !s.converged, maxLoops: 25 },
  ],

  entry: "proposer",
  exit: "keep",
});
