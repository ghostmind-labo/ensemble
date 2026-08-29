// A tour of the object model — every kind of node in one cheap scene.
//
// Point it at any small task. What it demonstrates is the SHAPE: four different
// kinds of worker on one blackboard, each costing a different amount, plus a
// custom edge kind mounted from this very file.
//
// Cheap by design: one model call to plan, one agent that does real file work,
// and a free deterministic check. Watch it with `ensemble serve`.
import { scene, z, registerEdgeKind, conditionLabel } from "@ghostmind-dev/ensemble";

// ── an edge kind, mounted from a scene file ───────────────────────────────
// Identical to "sequential" except it announces itself, which is the point:
// selection is an object, and the engine holds no branch for this.
registerEdgeKind({
  name: "sequential-verbose",
  summary: "first match wins, and says so in the log",
  fields: {},
  select: ({ edges, cursor, members, state, taken, emit }) => {
    for (const [i, e] of edges.entries()) {
      if (e.from !== cursor && !members.includes(e.from)) continue;
      if (e.when && !e.when({ ...state } as never)) continue;
      if (e.maxLoops !== undefined) {
        if ((taken.get(i) ?? 0) >= e.maxLoops) {
          emit({ type: "edge", from: e.from, to: e.to, skipped: true });
          continue;
        }
        taken.set(i, (taken.get(i) ?? 0) + 1);
      }
      emit({ type: "edge", from: cursor, to: e.to, ...(e.when ? { when: conditionLabel(e.when) } : {}) });
      return { next: e.to };
    }
    return {};
  },
});

export default scene({
  name: "objects",
  edgeKind: "sequential-verbose",

  defaults: {
    model: "openrouter/deepseek/deepseek-v4-flash",
    // Scene-wide DISARM. The planner has no business running shell commands;
    // `build` opts back in below. Before 0.21 this key was silently ignored.
    tools: { bash: false },
  },

  state: {
    plan: z.string(),
    report: z.string(),
    ok: z.boolean(),
    attempts: z.number(),
  },

  nodes: {
    // ⚡ one model call. No tools, no loop — pure think.
    plan: {
      runtime: "model",
      prompt: "Plan the task in 3 short bullet points. Be concrete about the file to write.",
      outputs: ["plan"],
    },

    // ⛭ the armed agent: it can now WRITE and VERIFY, which it could not before 0.21.
    build: {
      runtime: "agent",
      tools: { bash: true },       // opts back in over the scene-wide disarm
      maxTurns: 8,
      prompt: [
        "Carry out the plan by writing files under ./out/ (create it if needed).",
        "Then VERIFY your own work with the bash tool — list the file and print its",
        "contents — and report exactly what you observed. Do not claim success you",
        "did not verify.",
      ].join(" "),
      inputs: ["plan"],
      outputs: ["report"],
    },

    // λ free, instant, deterministic. Never pay a model to check a substring.
    check: {
      runtime: "fn",
      fn: (s) => ({
        ok: /exit 0/.test(String(s.report)),
        attempts: (Number(s.attempts) || 0) + 1,
      }),
      inputs: ["report", "attempts"],
      outputs: ["ok", "attempts"],
    },

    // ⏸ parks the run until a human answers. Costs nothing while it waits.
    signoff: {
      runtime: "ask",
      question: "The agent says it verified its work. Accept?",
      inputs: ["report"],
      outputs: ["accepted"],
    },
  },

  edges: [
    { from: "plan", to: "build" },
    { from: "build", to: "check" },
    // Loop back FIRST — first match wins, so the retry must precede the exit.
    { from: "check", to: "build", when: (s) => !s.ok, maxLoops: 2 },
    { from: "check", to: "signoff" },
  ],

  entry: "plan",
  exit: "signoff",
});
