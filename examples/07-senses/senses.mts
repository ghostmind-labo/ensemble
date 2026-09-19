/**
 * 07 · senses — look, listen and count at once, then decide once.
 *
 * A brain does not run its senses one after another. Here three lanes start
 * from one node and run concurrently: a vision model describes the frame, a
 * handler fetches what the sensors say, and code counts how many times this
 * scene has been seen before. They meet at a join, where Jev reads all three
 * as text and decides once.
 *
 * Two things make this provable rather than merely hopeful:
 *
 *   · `fork: true` on every edge leaving `sense`. They fire together, one lane
 *     each; a node's edges are all forks or none.
 *   · `join: "all"` on `assess`. It runs once, after every lane has arrived.
 *     `validate` refuses lanes that write or read the same key, so the merge
 *     cannot depend on timing.
 *
 * And one thing makes it a brain rather than a reflex: `memory`. `seen` is
 * declared on the runner, so it arrives like an input, a code node writes it,
 * and `supervise` carries it to the next tick. graph.json says the system
 * remembers `seen`; nothing else is remembered, and that is visible too.
 *
 *   node --import ./run.mts …   or   npm run validate examples/07-senses/senses.mts
 *   node plugin/skills/ensemble-build/scripts/dryrun.mts examples/07-senses/senses.mts "watch the door" --explore
 */
import { choice, noul, runner } from "../../src/index.ts";

export default runner({
  name: "senses",
  description: "Three senses in parallel, one calibrated decision, a memory of what was seen.",
  inputs: ["goal", "frame", "sensors"],
  memory: ["seen"],

  work: {
    // Your sensor bus. Here: whatever arrived in `sensors`, as one line.
    sensors: ({ state }) => `sensors: ${String(state["sensors"] ?? "quiet")}`,
    act: ({ state }) => `acting on "${state["action"]}" — ${String(state["scene"]).slice(0, 60)}`,
    hold: () => "holding",
  },

  nodes: {
    sense: { code: () => Date.now(), writes: ["at"] },

    // Lane e0: eyes. The only node that touches pixels.
    look: {
      model: "google/gemini-2.5-flash",
      system: "You are a robot's eyes. Describe only what is visible, in one sentence.",
      prompt: (s) => `What is in front of the robot? Its task: ${String(s["goal"])}.`,
      sees: ["frame"],
      reads: ["goal"],
      writes: ["scene"],
      temperature: 0,
      maxTokens: 120,
    },
    // Lane e1: ears. A handler, so any library goes here.
    listen: { work: "sensors", reads: ["sensors"], writes: ["heard"] },
    // Lane e2: memory. Arithmetic, so code, and it writes the remembered key.
    recall: {
      code: (s) => Number(s["seen"] ?? 0) + 1,
      reads: ["seen"],
      writes: ["seen"],
    },

    // The join. Jev reads what the senses wrote, never the frame itself.
    assess: {
      join: "all",
      decide: {
        action: choice("What should the robot do now?", {
          approach: { what: "Something worth a closer look, and it is safe", not_for: "Anything unsafe or nothing of interest" },
          avoid: { what: "Something to keep away from", not_for: "A clear scene" },
          wait: { what: "Nothing new, or too unclear to act on", not_for: "A clear reason to move" },
        }),
        novel: noul("Is this scene different from what a robot on this task would usually see?"),
      },
      reads: ["goal", "scene", "heard"],
      gate: { on: "action", min: 0.7, to: "stay" },
    },

    go: { work: "act", reads: ["action", "scene"], writes: ["did"] },
    stay: { work: "hold", writes: ["did"] },
  },

  edges: [
    { from: "sense", to: "look", fork: true },
    { from: "sense", to: "listen", fork: true },
    { from: "sense", to: "recall", fork: true },
    { from: "look", to: "assess" },
    { from: "listen", to: "assess" },
    { from: "recall", to: "assess" },

    { from: "assess", to: "stay", on: "action=wait" },
    { from: "assess", to: "go", on: "action=approach" },
    { from: "assess", to: "go", on: "action=avoid" },
  ],

  entry: "sense",
  result: "did",
});
