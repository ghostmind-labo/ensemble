// Skills: read from disk in the Claude Code layout, chosen by a decide node,
// inlined into a model node's prompt. Offline — a temp tree and a stub caller.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  choice,
  findSkill,
  loadSkills,
  parseSkill,
  renderSkills,
  runner,
  skillOptions,
  validate,
  type Answer,
  type Caller,
  type Decider,
  type ModelRequest,
  type Question,
} from "../src/index.ts";

/** Write `<root>/<dir>/<name>/SKILL.md`. */
function put(root: string, dir: string, name: string, description: string, body = "do the thing"): void {
  const at = join(root, dir, name);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

// ── 1 · frontmatter, including the long quoted descriptions real skills use ──
{
  const skill = parseSkill(
    `---\nname: hf-cli\ndescription: "Hugging Face Hub CLI. Use when: auth; cache; jobs."\nallowed-tools: Bash\n---\n\nInstall it with curl.\n`,
    "/x/hf-cli/SKILL.md",
    "plugin",
  )!;
  assert.equal(skill.name, "hf-cli");
  assert.equal(skill.description, "Hugging Face Hub CLI. Use when: auth; cache; jobs.", "quotes are stripped");
  assert.equal(skill.body, "Install it with curl.");
  assert.equal(skill.scope, "plugin");

  // a folded continuation, which long descriptions wrap onto
  const folded = parseSkill(
    `---\nname: wide\ndescription: first part\n  and the rest of it\n---\nbody\n`,
    "/x/wide/SKILL.md",
    "global",
  )!;
  assert.equal(folded.description, "first part and the rest of it");

  // the name falls back to the folder, and a file with no frontmatter is not a skill
  assert.equal(parseSkill(`---\ndescription: d\n---\nb`, "/x/from-folder/SKILL.md", "project")!.name, "from-folder");
  assert.equal(parseSkill("no frontmatter here", "/x/y/SKILL.md", "project"), undefined);
}
console.log("ok · 1 SKILL.md frontmatter parses, quotes, folds and folder-name fallback included");

// ── 2 · precedence: project beats global, and both beat plugins ─────────────
{
  const home = mkdtempSync(join(tmpdir(), "ens-home-"));
  const project = mkdtempSync(join(tmpdir(), "ens-proj-"));

  put(project, ".claude/skills", "shared", "the PROJECT one");
  put(project, ".ensemble/skills", "only-project", "project only");
  put(home, ".claude/skills", "shared", "the GLOBAL one");
  put(home, ".claude/skills", "only-global", "global only");
  put(home, ".claude/plugins/cache/mkt/pack/1.0.0/skills", "shared", "the PLUGIN one");
  put(home, ".claude/plugins/cache/mkt/pack/1.0.0/skills", "only-plugin", "plugin only");

  const skills = loadSkills({ project, home });
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));

  assert.equal(byName["shared"]!.description, "the PROJECT one", "the nearest definition wins");
  assert.equal(byName["shared"]!.scope, "project");
  assert.equal(byName["only-global"]!.scope, "global");
  assert.equal(byName["only-plugin"]!.scope, "plugin", "installed plugins are scanned too");
  assert.deepEqual(skills.map((s) => s.name), ["only-global", "only-plugin", "only-project", "shared"]);

  assert.ok(!loadSkills({ project, home, plugins: false }).some((s) => s.name === "only-plugin"));
  assert.equal(findSkill(skills, "nope"), undefined);
  assert.deepEqual(loadSkills({ project: join(project, "nowhere"), home: join(home, "nowhere") }), []);
}
console.log("ok · 2 project beats global beats plugin, and a missing tree is empty, not an error");

// ── 3 · skillOptions is choice criteria, trimmed, with a way out ────────────
{
  const many = Array.from({ length: 300 }, (_, i) => ({
    name: `s${i}`,
    description: "x".repeat(400),
    body: "b",
    scope: "global" as const,
    path: `/s${i}`,
  }));
  const options = skillOptions(many, { chars: 50 });

  assert.equal(Object.keys(options).length, 201, "200 skills plus the escape hatch");
  assert.equal(options["s0"]!.what.length, 50, "descriptions are trimmed — every option costs tokens");
  assert.match(options["s0"]!.what, /…$/);
  assert.match(options["none"]!.what, /No skill here fits/, "suggesting nothing beats suggesting wrong");

  assert.equal(Object.keys(skillOptions(many, { none: false })).length, 200, "200 is the default cap");
  assert.equal(
    Object.keys(skillOptions(many, { none: false, max: 999 })).length,
    254,
    "and a bigger ask is clamped below Choice's 255, leaving room for the escape hatch",
  );
  assert.equal(skillOptions(many, { none: "nothing applies" })["none"]!.what, "nothing applies");

  // the options ARE enumerable offline, which is why this may go in a choice
  const q = choice("Which skill fits?", skillOptions(many.slice(0, 3)));
  assert.deepEqual(Object.keys(q.criteria), ["s0", "s1", "s2", "none"]);
}
console.log("ok · 3 skillOptions trims, caps and always offers a way out");

// ── 4 · renderSkills wraps bodies for a prompt ──────────────────────────────
{
  const rendered = renderSkills([
    { name: "a", description: "d", body: "first body", scope: "global", path: "/a" },
    { name: "b", description: "d", body: "second body", scope: "global", path: "/b" },
  ]);
  assert.equal(rendered, '<skill name="a">\nfirst body\n</skill>\n\n<skill name="b">\nsecond body\n</skill>');
}
console.log("ok · 4 skill bodies are wrapped and named for a prompt");

// ── 5 · a decide node picks one, a model node is given it ───────────────────
{
  const home = mkdtempSync(join(tmpdir(), "ens-home-"));
  const project = mkdtempSync(join(tmpdir(), "ens-proj-"));
  put(project, ".claude/skills", "brandkit", "Making brand boards and logo systems.", "BRAND RULES HERE");
  put(project, ".claude/skills", "eli5", "Explaining things simply.", "ELI5 RULES HERE");
  const skills = loadSkills({ project, home, plugins: false });

  const flow = runner({
    name: "with-skills",
    inputs: ["goal"],
    skills,
    nodes: {
      pick: {
        decide: { skill: choice("Which skill fits this request?", skillOptions(skills)) },
        reads: ["goal"],
      },
      answer: {
        model: "some/model",
        prompt: (s) => String(s["goal"]),
        skills: { from: "skill" },
        reads: ["goal"],
        writes: ["reply"],
      },
    },
    edges: [{ from: "pick", to: "answer" }],
    entry: "pick",
    result: "reply",
  });
  assert.deepEqual(flow.validate(), []);

  // the graph enumerates the skills, because they are local files
  const graph = flow.graph();
  const options = graph.nodes.find((n) => n.id === "pick")!.decide!.questions[0]!.options!.map((o) => o.name);
  assert.deepEqual(options, ["brandkit", "eli5", "none"]);
  assert.equal(graph.nodes.find((n) => n.id === "answer")!.model!.skillsFrom, "skill");

  const chose = (name: string): Decider => async (_s, questions: Record<string, Question>) => {
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(questions)) {
      answers[key] = { type: "choice", choice: name, confidence: 0.9, probabilities: { [name]: 0.9 } };
    }
    return { model: "stub", answers, usage: { input_tokens: 300, output_tokens: 8 }, cost: 0.0000126 };
  };
  let sent: ModelRequest | undefined;
  const caller: Caller = async (request) => {
    sent = request;
    return { model: request.model, text: "answered", images: [], cost: 0.002, usage: { prompt_tokens: 9, completion_tokens: 2 } };
  };

  const { run } = await flow({ goal: "design a logo system" }, { decider: chose("brandkit"), caller });
  assert.match(sent!.system!, /BRAND RULES HERE/, "the chosen skill's body reached the model");
  assert.doesNotMatch(sent!.system!, /ELI5/, "and only that one");
  assert.deepEqual((run.steps[1]!.meta as { skills: string[] }).skills, ["brandkit"]);

  // "none" is a real answer: no skill is attached, and nothing fails
  sent = undefined;
  await flow({ goal: "what time is it" }, { decider: chose("none"), caller });
  assert.equal(sent!.system, undefined, "declining attaches nothing");
}
console.log("ok · 5 a choice picks a skill and the model node is handed exactly that body");

// ── 6 · a named skill that is not loaded is caught before the run ───────────
{
  const problems = validate({
    name: "x",
    skills: [{ name: "real", description: "d", body: "b", scope: "global", path: "/r" }],
    nodes: { n: { model: "m", prompt: "p", skills: ["ghost"], writes: ["out"] } },
    entry: "n",
  });
  assert.ok(problems.some((p) => /names skill "ghost", which is not in the runner's registry/.test(p)));
  assert.ok(problems.some((p) => /Loaded: "real"/.test(p)));

  assert.ok(
    validate({
      name: "x",
      nodes: { n: { model: "m", prompt: "p", skills: ["ghost"], writes: ["out"] } },
      entry: "n",
    }).some((p) => /the runner loaded no skills — pass skills: loadSkills\(\)/.test(p)),
  );

  // "none" is always allowed, registry or not
  assert.deepEqual(
    validate({ name: "x", nodes: { n: { model: "m", prompt: "p", skills: ["none"], writes: ["o"] } }, entry: "n" }),
    [],
  );
}
console.log("ok · 6 a skill a runner never loaded is named at validation, not at run time");

console.log("6 cases");
