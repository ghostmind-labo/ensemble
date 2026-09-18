/**
 * 04 · robot — a little brain: look, decide, act.
 *
 * One pass of a perception loop. A camera frame comes in, a vision model says
 * what it sees, Jev decides what to do about it, and your handler does it.
 *
 * The shape is forced by one fact and it is worth stating plainly: **Jev cannot
 * see.** It takes text only. So perception has to be a `model` node, and its
 * job is to turn pixels into a sentence the decider can weigh. `validate`
 * enforces this — send an image key to a decide node and it refuses by name.
 *
 * That split is also why the loop is affordable. Looking is the expensive part
 * and happens once; the judgement on top of it is ~100ms and ~$0.00002, so a
 * brain can afford to ask four questions per frame instead of one overloaded
 * one, and every answer comes back with its own confidence.
 *
 * ── the connection ───────────────────────────────────────────────────────────
 * A brain is a loop, and the loop is just calling this function. There is no
 * daemon to start and nothing to keep running: a runner IS the tick.
 *
 *   for await (const frame of camera) {
 *     const { result, run } = await brain(
 *       { goal: "keep the corridor clear", frame },
 *       { budget: 0.05, onEvent: (e) => telemetry.send(e) },   // ← live feed out
 *     );
 *     log.append(run);                                        // ← the record
 *   }
 *
 * `onEvent` fires as it happens — `node:start` when something begins, with what
 * it is waiting on, `node:end` with the full answer and its distribution. Point
 * it at a socket and you have a live view of the brain from anywhere, without
 * this library owning a UI.
 *
 *   ensemble validate examples/04-robot/brain.mts
 *   ensemble run examples/04-robot/brain.mts --input frame=https://example.com/f.jpg "keep the corridor clear"
 */
import { choice, noul, runner, score } from "../../src/index.ts";

export default runner({
  name: "robot-brain",
  description: "One tick of a perception loop: look at a frame, decide, act.",
  // `frame` is an image URL or a data: URL. It arrives from outside the run.
  inputs: ["goal", "frame"],

  work: {
    advance: ({ state }) => `advancing — ${String(state["scene"]).slice(0, 60)}`,
    retreat: ({ state }) => `backing off — ${String(state["scene"]).slice(0, 60)}`,
    hold: () => "holding position",
    alert: ({ state, goal }) => `ALERT (${state["urgency"]}): ${goal} — ${String(state["scene"]).slice(0, 80)}`,
  },

  nodes: {
    // Perception. The only node that touches pixels, and the reason a model
    // node exists at all.
    look: {
      model: "google/gemini-2.5-flash",
      system: "You are a robot's eyes. Describe only what is visible. No advice, no speculation.",
      prompt: (state) =>
        `In two sentences: what is in front of the robot, and is anything in its way? Its task is: ${String(state["goal"])}.`,
      sees: ["frame"],
      reads: ["goal"],
      writes: ["scene"],
      temperature: 0,
      maxTokens: 200,
    },

    // Judgement. Four questions, one round trip, each with its own confidence.
    assess: {
      decide: {
        action: choice("What should the robot do next?", {
          advance: { what: "The way is clear enough to continue", not_for: "Anything blocking or unsafe" },
          retreat: { what: "Something is too close or unsafe; back away", not_for: "A clear path" },
          hold: { what: "Unclear or changing; wait and look again", not_for: "A clear path, or a real hazard" },
        }),
        hazard: noul("Is there anything in view that could injure a person?", {
          true: { what: "A person is at risk, or could be within seconds" },
          false: { what: "Nothing in view endangers anyone" },
        }),
        urgency: score("How quickly must something happen?", [
          { what: "No time pressure at all" },
          { what: "Should be handled within a minute" },
          { what: "Immediate — seconds matter" },
        ]),
      },
      // Note what is NOT here: "frame". Jev takes text only, and `scene` is
      // what the eyes wrote down. validate() refuses the alternative.
      reads: ["goal", "scene"],
      gate: { on: "action", min: 0.8, to: "raise" },
    },

    go: { work: "advance", reads: ["scene"], writes: ["did"] },
    back: { work: "retreat", reads: ["scene"], writes: ["did"] },
    wait: { work: "hold", writes: ["did"] },
    raise: { work: "alert", reads: ["scene", "urgency"], writes: ["did"] },
  },

  edges: [
    // Safety first, and in code: a hazard outranks whatever the classifier
    // chose, and urgency is a number.
    { from: "assess", to: "raise", on: "hazard>=0.6" },
    { from: "assess", to: "raise", when: (s) => Number(s["urgency"]) >= 1.7 },
    // Then the ordinary decision. Every option is wired, so nothing can fall
    // through to a stop the robot did not intend.
    { from: "assess", to: "go", on: "action=advance" },
    { from: "assess", to: "back", on: "action=retreat" },
    { from: "assess", to: "wait", on: "action=hold" },

    { from: "look", to: "assess" },
  ],

  entry: "look",
  result: "did",
});
