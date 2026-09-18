/**
 * 05 · assistant — skills and MCP, chosen rather than looped over.
 *
 * The request arrives, and three things have to be worked out before anything
 * happens: which skill applies, whether a file needs reading, and whether this
 * is even answerable. One decide node settles all three in a single call, and
 * the rest of the graph is ordinary wiring.
 *
 * What this replaces is the agent loop. The old way was to hand a model every
 * skill and every MCP tool and let it work it out, one round trip at a time.
 * The trouble was never that it failed often — it was that nothing about it
 * could be drawn, proved, or repeated. Here:
 *
 *   · `skillOptions()` enumerates the skill registry into a `choice`. Skills
 *     are LOCAL FILES, so the options are known offline and the graph stays
 *     complete — the thing a live model catalogue can never be.
 *   · the `mcp` node names ONE server and ONE tool. `graph.json` therefore says
 *     exactly what this workflow can reach, before it runs.
 *   · `skills: { from: "skill" }` inlines the chosen body into the answering
 *     model's system prompt. A skill is instructions, and instructions are text.
 *
 * TypeSafe measured the first of those: choosing among 182 skills, an agent
 * working from truncated index entries loaded the wrong one 16.8% of the time,
 * against 7.3% when a System One model ranked them first.
 *
 *   ensemble validate examples/05-assistant/assistant.mts   # free, offline
 *   ensemble graph    examples/05-assistant/assistant.mts | jq '.nodes[].mcp'
 *   ensemble run      examples/05-assistant/assistant.mts --input path=README.md "explain this repo to a designer"
 */
import { choice, loadSkills, noul, runner, skillOptions } from "../../src/index.ts";

// Synchronous, local, free — so it is safe at module scope and `validate` and
// `graph` stay offline. Project skills shadow global ones, which shadow plugins.
const skills = loadSkills();

export default runner({
  name: "assistant",
  description: "Pick a skill, read a file if one is needed, answer with that skill in hand.",
  // `path` arrives from the caller (`--input path=src/jev.ts`) and has a default
  // in the args function below. Declaring it is what lets validate prove the mcp
  // node is never handed an undefined path.
  inputs: ["goal", "path"],
  skills,

  // One tool call per node, so this is the complete list of what the workflow
  // can reach. An agent loop could never tell you that.
  mcpServers: {
    fs: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
    },
  },

  work: {
    decline: ({ goal }) => `I can't help with that: ${goal}`,
  },

  nodes: {
    triage: {
      decide: {
        // Enumerated from disk. Add a skill to the project and it appears here
        // with no code change — and `ensemble graph` shows it as a branch.
        skill: choice(
          { question: "Which skill best fits this request?", focus: "Match the request, not the topic in general." },
          skillOptions(skills, { chars: 200 }),
        ),
        needs_file: noul("Does answering this require reading a file from the project?", {
          true: { what: "Names a file, or asks about code or docs that must be read" },
          false: { what: "Answerable from the request alone" },
        }),
        answerable: noul("Is this a request that can be answered at all?", {
          true: { what: "A real question or task" },
          false: { what: "Empty, nonsense, or asking for something impossible" },
        }),
      },
      reads: ["goal"],
      // `skill` is a big choice, so an unsure answer is worth catching.
      gate: { on: "skill", min: 0.45, to: "answer" },
    },

    // One server, one tool, arguments from code. No loop.
    read: {
      mcp: { server: "fs", tool: "read_text_file" },
      args: (state) => ({ path: String(state["path"] ?? "README.md") }),
      reads: ["path"],
      writes: ["file_text"],
    },

    answer: {
      model: "anthropic/claude-sonnet-4.5",
      // The chosen skill's body is prepended to the system prompt. "none" — the
      // escape hatch skillOptions adds — attaches nothing, deliberately.
      skills: { from: "skill" },
      prompt: (state) =>
        `${String(state["goal"])}` +
        (state["file_text"] ? `\n\n<file>\n${String(state["file_text"]).slice(0, 20_000)}\n</file>` : ""),
      reads: ["goal", "file_text"],
      writes: ["reply"],
      maxTokens: 1200,
    },

    refuse: { work: "decline", reads: ["goal"], writes: ["reply"] },
  },

  edges: [
    // Order matters: first match wins, so the refusal is checked before anything
    // is read or generated.
    { from: "triage", to: "refuse", on: "!answerable" },
    { from: "triage", to: "read", on: "needs_file>=0.6" },
    { from: "triage", to: "answer" },
    { from: "read", to: "answer" },
  ],

  entry: "triage",
  result: "reply",
});
