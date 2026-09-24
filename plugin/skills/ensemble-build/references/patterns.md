# Graph patterns

Pick the shape that matches the use case, then adapt it. Real use cases usually
combine two or three. Every snippet uses the v2 API. Imports come from
`@ghostmind-dev/ensemble`.

## Contents
1. Triage: one choice, every option wired, a gate
2. Safety override before routing
3. Refine loop: score, count in code, loop budget
4. Perception tick: look, then decide on the sentence
5. Model chosen at run time
6. Skill routing and a single tool call
7. Staged classification (too many options or nested categories)
8. A spec generated from data
9. Composed runners
10. Many checks at once, combined in code
11. Choosing between patterns
12. A loop that runs for days, with a watcher
13. Fan out, then decide once: fork and join
14. Gate an action, then check it happened
15. A person in the loop

---

## 1. Triage

The smallest complete idea. Every option has an edge, so validation can prove
nothing falls through, and the gate catches the unsure answers.

```ts
nodes: {
  classify: {
    decide: {
      team: choice("Which team should handle this request?", {
        billing: { what: "Charges, invoices, refunds", not_for: "Where a parcel is" },
        orders:  { what: "Delivery, cancellation, returns", not_for: "Money questions" },
        account: { what: "Login, profile, deletion", not_for: "Anything about an order" },
      }),
    },
    reads: ["goal"],
    gate: { on: "team", min: 0.7, to: "escalate" },
  },
  to_billing: { work: "billing", reads: ["goal"], writes: ["reply"] },
  to_orders:  { work: "orders",  reads: ["goal"], writes: ["reply"] },
  to_account: { work: "account", reads: ["goal"], writes: ["reply"] },
  escalate:   { work: "human",   reads: ["goal"], writes: ["reply"] },
},
edges: [
  { from: "classify", to: "to_billing", on: "team=billing" },
  { from: "classify", to: "to_orders",  on: "team=orders" },
  { from: "classify", to: "to_account", on: "team=account" },
],
```

If several options go to the same place, one bare default edge says that more
honestly than repeating identical edges.

## 2. Safety override before routing

Checks that must win go **first**, because edges are tried in order. Ask them in
the same node as the routing question, which costs nothing extra.

```ts
decide: {
  action: choice("What should happen next?", { … }),
  harmful: noul("Does the request ask for something that could hurt someone?", {
    true:  { what: "Self-harm, violence, or instructions that endanger people" },
    false: { what: "Ordinary requests, including frustrated or rude ones" },
  }),
  answerable: noul("Is this something that can be acted on at all?"),
},
…
edges: [
  { from: "assess", to: "refuse",  on: "harmful>=0.3" },   // low threshold: false negatives cost more
  { from: "assess", to: "clarify", on: "!answerable" },
  { from: "assess", to: "a", on: "action=a" },
  { from: "assess", to: "b", on: "action=b" },
],
```

Set each threshold from what an error costs: a missed hazard is worse than a
false alarm, so its threshold goes low.

**Don't gate the node that holds the overrides.** A gate fires before any edge,
so a low-confidence `action` would jump straight to `gate.to` and skip the
`harmful` check. When the routing choice needs a gate, split the node:

```ts
screen: { decide: { harmful: noul(…), answerable: noul(…) }, reads: ["goal"] },
route:  { decide: { action: choice(…) }, reads: ["goal"], gate: { on: "action", min: 0.7, to: "human" } },
…
edges: [
  { from: "screen", to: "refuse",  on: "harmful>=0.3" },
  { from: "screen", to: "clarify", on: "!answerable" },
  { from: "screen", to: "route" },               // only clean input reaches the gated choice
  { from: "route", to: "a", on: "action=a" },
  { from: "route", to: "b", on: "action=b" },
],
```

That costs one more round trip of about 100 ms. The alternative is making
`gate.to` the same safe exit the overrides use.

## 3. Refine loop

Is the draft good enough? That's a question about meaning, so Jev answers it. How
many rounds have passed? That's counting, so code does it. The loop budget sits
on the edge.

```ts
nodes: {
  draft:  { work: "write", reads: ["goal", "quality", "rounds"], writes: ["draft"] },
  review: {
    decide: {
      quality: score("How good is this draft against what was asked?", [
        { what: "Off-target or unusable" },
        { what: "Serviceable but thin" },
        { what: "Genuinely good: specific, nothing to add" },
      ]),
      blocker: noul("Does the draft contain a claim that is wrong or unsupported?"),
    },
    reads: ["goal", "draft"],
  },
  tally: { code: (s) => Number(s.rounds ?? 0) + 1, reads: ["rounds"], writes: ["rounds"] },
  ship:  { work: "publish", reads: ["draft"], writes: ["url"] },
},
edges: [
  { from: "draft", to: "review" },
  { from: "review", to: "tally", when: (s) => Number(s.quality) < 1.5 || Number(s.blocker) >= 0.5 },
  { from: "review", to: "ship" },
  { from: "tally", to: "draft", maxLoops: 3 },
  { from: "tally", to: "ship" },
],
```

`quality` and `rounds` are read by `draft` before anything writes them. That's
allowed because they are written *somewhere*, and on the first pass they are
`undefined`. Handle that in the handler.

The writer can be a `model` node instead of a `work` handler:
`draft: { model: …, prompt: (s) => …, reads: [...], writes: ["draft"] }`.

## 4. Perception tick

Jev can't see. A vision model turns pixels into a sentence, and the decision is
made on the sentence. One tick is one call of the runner, and the caller's loop is
the brain.

```ts
inputs: ["goal", "frame"],
nodes: {
  look: {
    model: "<a vision model id, looked up live>",
    system: "Describe only what is visible. No advice.",
    prompt: (s) => `In two sentences: what is in view, and is anything in the way? Task: ${s.goal}`,
    sees: ["frame"], reads: ["goal"], writes: ["scene"], temperature: 0, maxTokens: 200,
  },
  assess: {
    decide: { action: choice(…), hazard: noul(…), urgency: score(…) },
    reads: ["goal", "scene"],          // never "frame"
    // The gate fires BEFORE the hazard edges below, so it must lead somewhere
    // safe for a hazard too. Here it goes to the same place a hazard does.
    gate: { on: "action", min: 0.8, to: "alert" },
  },
  …
},
edges: [
  { from: "look", to: "assess" },
  { from: "assess", to: "alert", on: "hazard>=0.6" },
  { from: "assess", to: "alert", when: (s) => Number(s.urgency) >= 1.7 },
  { from: "assess", to: "go", on: "action=advance" },
  …
],
```

The caller runs `for await (const frame of camera) await brain({ goal, frame }, { budget: 0.05 })`.

## 5. Model chosen at run time

Never let a `choice` enumerate the live model catalogue. The options wouldn't be
known in advance, and `graph.json` couldn't list the branches. Ask the stable
question and resolve today's model id in code.

```ts
nodes: {
  classify: {
    decide: {
      fidelity: choice("How much does quality matter here?", {
        draft: { what: "A rough look, to be iterated on", not_for: "Anything shipping to users" },
        final: { what: "Going in front of users as-is", not_for: "A quick sketch" },
      }),
    },
    reads: ["goal"],
  },
  pick_model: {
    code: async (s) => {
      const pool = shortlist(await catalog(), { vision: true, maxPromptUsdPerM: s.fidelity === "final" ? 5 : 0.5 })
        .filter((m) => m.promptUsd > 0);          // price 0 = meta-router with unknown price, not free
      if (!pool.length) throw new Error("no model fits the filter");
      return pool[s.fidelity === "final" ? pool.length - 1 : 0]!.id;
    },
    reads: ["fidelity"], writes: ["model_id"],
  },
  work_it: { model: { from: "model_id" }, prompt: (s) => String(s.goal), writes: ["text"] },
},
edges: [
  { from: "classify", to: "pick_model" },
  { from: "pick_model", to: "work_it" },
],
```

## 6. Skill routing and a single tool call

Skills are local files, so their names *can* be options: they are known when the
module loads, and the graph stays complete. Choosing a skill is a classification.

```ts
const skills = loadSkills();                 // module scope: sync, local, free

export default runner({
  …, inputs: ["goal", "path"], skills,
  mcpServers: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()] } },
  nodes: {
    triage: {
      decide: {
        skill: choice({ question: "Which skill best fits this request?", focus: "Match the request, not the topic" },
                      skillOptions(skills, { chars: 200 })),
        needs_file: noul("Does answering require reading a file from the project?"),
      },
      reads: ["goal"],
      gate: { on: "skill", min: 0.45, to: "answer" },
    },
    read:   { mcp: { server: "fs", tool: "read_text_file" }, args: (s) => ({ path: String(s.path ?? "README.md") }),
              reads: ["path"], writes: ["file_text"] },
    answer: { model: "<id>", skills: { from: "skill" }, prompt: (s) => …, reads: ["goal", "file_text"], writes: ["reply"] },
  },
  edges: [
    { from: "triage", to: "read", on: "needs_file>=0.6" },
    { from: "triage", to: "answer" },
    { from: "read", to: "answer" },
  ],
});
```

The same shape picks an MCP tool: list the tools once at authoring time, freeze
them into `toolOptions(tools)` for a `choice`, then use
`mcp: { server, tool: { from: "tool" } }`. Wire `tool=none` to a different branch.

## 7. Staged classification

Split a classification into stages when there are more than about 20 options,
when options cluster into families, or when a flat list would put near-identical
options side by side. Each stage then has only a few narrow boundaries.

```ts
nodes: {
  family: {
    decide: { family: choice("Which area does this concern?", { hardware: {…}, software: {…}, billing: {…} }) },
    reads: ["goal"],
    gate: { on: "family", min: 0.6, to: "human" },
  },
  hw: { decide: { issue: choice("Which hardware problem?", { … }) }, reads: ["goal"], gate: { on: "issue", min: 0.6, to: "human" } },
  sw: { decide: { issue_sw: choice("Which software problem?", { … }) }, reads: ["goal"] },
  …
},
edges: [
  { from: "family", to: "hw", on: "family=hardware" },
  { from: "family", to: "sw", on: "family=software" },
  { from: "family", to: "bill", on: "family=billing" },
  // then each stage's options wired to handlers
],
```

Question keys are state keys, so two stages that both write `issue` would collide.
Give each stage its own key, or accept that the later one overwrites.

## 8. A spec generated from data

When the categories, policies or handlers come from a list, build the nodes and
edges from it. The list is known when the module loads, so validation and
`graph` still see everything. This is how a large graph stays small to write.

```ts
const QUEUES = {
  billing: { what: "Charges, invoices, refunds", not_for: "Delivery status" },
  shipping: { what: "Where a parcel is, delivery dates", not_for: "Money" },
  returns: { what: "Sending something back", not_for: "A parcel that never arrived" },
} as const;
type Queue = keyof typeof QUEUES;
const names = Object.keys(QUEUES) as Queue[];

export default runner({
  name: "router",
  inputs: ["goal"],
  work: Object.fromEntries(names.map((q) => [q, ({ goal }: { goal: string }) => enqueue(q, goal)])),
  nodes: {
    classify: { decide: { queue: choice("Which queue owns this?", QUEUES) }, reads: ["goal"],
                gate: { on: "queue", min: 0.7, to: "human" } },
    ...Object.fromEntries(names.map((q) => [`to_${q}`, { work: q, reads: ["goal"], writes: ["ticket"] }])),
    human: { work: "human", reads: ["goal"], writes: ["ticket"] },
  },
  edges: names.map((q) => ({ from: "classify", to: `to_${q}`, on: `queue=${q}` })),
  entry: "classify",
  result: "ticket",
});
```

Remember to register `human` in `work` too. Building the map with a spread
(`{ ...Object.fromEntries(…), human: … }`) keeps it one expression.

## 9. Composed runners

When a use case has distinct stages that each deserve their own proof, write one
runner per stage and let a `work` handler call the next. Each file validates and
dry-runs on its own, and the parent's graph shows the child as one metered step.

```ts
import refund from "./refund.mts";   // another runner

work: {
  refund: async ({ goal, state, signal, report }) => {
    const { result, run } = await refund({ goal, order_id: state.order_id }, { signal });
    report({ cost: run.run.cost.total, meta: { runner: "refund", run: run.run.id } });
    return result;
  },
},
```

Pass `signal` so a budget stop or a cancel reaches the child, and `report` its
cost so the parent's budget stays honest.

Dry-run each child on its own with `--explore`. The dry-run's stubs don't reach a
child, so a parent dry run blocks the child's paid calls and fails that branch
with a message saying so. Dry-run the parent with `--stub-work` to test its own
wiring.

## 10. Many checks at once, combined in code

A fixed set of lanes is a fork and a join (pattern 13), but a variable number of
them is never the graph's job. For independent checks the cheaper shape is
several questions in one decide node, which go out in one request and are
answered independently. Then either route on them with ordered edges, or fold
them into one value in a `code` node when the rule is arithmetic.

```ts
screen: {
  decide: {
    pii:        noul("Does the text contain personal data about a private person?"),
    legal:      noul("Does it make a legal claim or threat?"),
    off_policy: noul("Does it ask for something our policy forbids?"),
    tone:       score("How hostile is the tone?", [{ what: "Neutral" }, { what: "Frustrated" }, { what: "Abusive" }]),
  },
  reads: ["message"],
},
risk: {
  code: (s) => {
    const tone = Number(s.tone) / 2;               // 3 levels → 0..1 (divide by levels − 1)
    return Math.max(Number(s.pii), Number(s.legal), Number(s.off_policy), tone * 0.8);
  },
  reads: ["pii", "legal", "off_policy", "tone"], writes: ["risk"],
},
…
edges: [
  { from: "screen", to: "risk" },
  { from: "risk", to: "review", when: (s) => Number(s.risk) >= 0.6 },
  { from: "risk", to: "send" },
],
```

Scores from rubrics of different lengths aren't comparable. Divide by
`levels − 1` before combining them.

When the outcome is a **label** (approve / reject / review) rather than a number,
have the `code` node return the label plus the reasons, and route on it with
`when:`. Comparing a string that code produced is deterministic, so `when:` is
the right form for it. (`on:` is only for answers Jev gave.)

```ts
const T = { reject: 0.8, review: 0.3 };            // every threshold in one table
verdict: {
  code: (s) => {
    const hits = ["nudity", "violence", "watermark"].filter((k) => Number(s[k]) >= T.reject);
    const doubts = ["nudity", "violence", "watermark"].filter((k) => Number(s[k]) >= T.review);
    const decision = hits.length ? "reject" : doubts.length ? "review" : "approve";
    return { decision, reasons: hits.length ? hits : doubts };
  },
  reads: ["nudity", "violence", "watermark"], writes: ["decision", "reasons"],
},
…
edges: [
  { from: "verdict", to: "reject",  when: (s) => s.decision === "reject" },
  { from: "verdict", to: "review",  when: (s) => s.decision === "review" },
  { from: "verdict", to: "approve" },
],
```

## 11. Choosing between patterns

| The use case says… | Start from |
|---|---|
| "route / triage / classify / send to the right X" | 1 (and 7 if > ~20 options, 8 if the list is data) |
| "make sure it never…", "flag if…" | 2 or 10 |
| "keep improving until…", "retry until good" | 3 |
| "watch / look at / camera / screenshot / image" | 4 |
| "use the best/cheapest model for…" | 5 |
| "pick the right skill / tool / doc" | 6 |
| "several stages, each with its own decisions" | 9 |
| "an agent that keeps choosing tools until done" | a `work` handler that runs the agent (any SDK), supervised and watched: 12 |
| "keep running / monitor / every N minutes / for days" | 12 |
| "at the same time / in parallel / all three then decide" | 13 |
| "before it runs a command / sends / pays / deletes" | 14 |
| "a person approves / signs off / reviews before…" | 15 |
| "keep working if the classifier is down" | `fallback:` on the decide node (15) |
| "click the right button / pick from what's on the page now" | a `work` handler that rebuilds the menu each turn. The options change every step, so they can't be a declared `choice` |

## 12. A loop that runs for days, with a watcher

The tick is any runner from 1–10, and it can be a free-running agent inside one
`work` handler. `supervise` adds what a long life needs: memory between ticks,
budgets that stop or rest, a journal a restart resumes from, and a stop after a
failure streak. The watcher is a second, tiny runner that checks the numbers in
code first and only then asks Jev about meaning. Full code:
`examples/06-watch/watch.mts`.

```ts
const watcher = runner({
  name: "watcher",
  inputs: ["goal", "vitals", "recent"],
  nodes: {
    vitals: { code: () => null },                       // a place for the arithmetic edges to leave from
    judge: {
      decide: {
        progress: noul("Do the recent ticks show the work moving toward the goal?"),
        looping:  noul("Do the recent ticks keep producing the same result while nothing changes?"),
      },
      reads: ["goal", "recent"],                        // the story as text; never the numbers
    },
    carry_on: { code: () => "continue" },
    flag:     { code: () => "alert" },
    halt:     { code: () => "stop" },
  },
  edges: [
    { from: "vitals", to: "halt", when: (s) => { const v = s.vitals as Vitals | undefined; return Number(v?.failureRate) >= 0.5; } },
    { from: "vitals", to: "judge" },
    { from: "judge", to: "flag", on: "looping>=0.7" },
    { from: "judge", to: "carry_on", on: "progress>=0.5" },
    { from: "judge", to: "flag" },
  ],
  entry: "vitals",
});

await supervise(worker, {                      // worker declares memory: ["topics"] and a node writes it
  next: async () => ({ goal: await inbox.next() }),
  memory: { topics: "" },                      // starting value, until the first checkpoint
  budget: { total: 20, perDay: 5, perRun: 0.05 },
  run: { stepTimeout: 120_000 },
  watch: { every: 10, runner: watcher, goal: "answer each message helpfully" },
  journal: ".ensemble/live",
  onAlert: ({ reason }) => pager.send(reason),
});
```

Design rules:

- **Memory is declared on the runner** (`memory: ["topics"]`) and written by a
  node in the graph, usually a `code` node that appends and trims. It arrives
  like an input, so validation proves the tick's data flow and `graph.json`
  says what the system remembers. A tally or the last few results, never a
  growing transcript.
- **Always set `stepTimeout` and `budget.total`.** A multi-day loop with neither
  can hang or overspend without anyone noticing.
- **The watcher is calibrated like any runner.** Label a few `recent` texts as
  on-track or drifting and run `ensemble calibrate` on it before trusting it,
  with a `holdout` split so the wording is not fitted to the examples.
- **The watched work must not author the evidence.** `recent` defaults to facts
  the supervisor wrote. Opt into the tick's own output (`evidence: "facts+text"`)
  only when that output cannot carry anything from outside the system.
- **Dry-run the tick and the watcher separately.** Test `supervise` itself with
  a stub `decider` in `run` and `watch.run`, and `maxTicks: 3`.

## 13. Fan out, then decide once: fork and join

When several things must be known before one decision, and none depends on
another, run them at the same time. Full code: `examples/07-senses/senses.mts`.

```ts
nodes: {
  sense:  { code: () => Date.now(), writes: ["at"] },
  look:   { model: "…", sees: ["frame"], reads: ["goal"], writes: ["scene"] },   // lane e0
  listen: { work: "sensors", reads: ["sensors"], writes: ["heard"] },            // lane e1
  recall: { code: (s) => Number(s.seen ?? 0) + 1, reads: ["seen"], writes: ["seen"] }, // lane e2, writes memory
  assess: { join: "all", decide: { action: choice(…) }, reads: ["goal", "scene", "heard"], gate: {…} },
  …
},
edges: [
  { from: "sense", to: "look",   fork: true },
  { from: "sense", to: "listen", fork: true },
  { from: "sense", to: "recall", fork: true },
  { from: "look", to: "assess" }, { from: "listen", to: "assess" }, { from: "recall", to: "assess" },
  { from: "assess", to: "go",   on: "action=approach" },
  …
],
```

Rules:

- **Each lane writes its own keys.** `validate` refuses two lanes touching the
  same key, in either direction. Combine after the join, in a `code` node if
  arithmetic is needed.
- **Forks can be conditional.** `{ from: "triage", to: "billing", on: "queue=billing", fork: true }`
  alongside other forks lets a decide node start only the lanes it chose.
- **A lane can be as long as it likes**, and can itself fork, as long as it
  ends at the join or at an exit.
- **A variable number of lanes is a handler.** `Promise.all` over a list inside
  one `work` node, with `report({ cost })`. The graph shows one step; that is
  the honest picture when the width isn't known until run time.
- **Dry-run it.** `--explore` follows every lane; an untaken fork edge is listed
  like any other.

## 14. Gate an action, then check it happened

Two separate facts, and the classic mistake is to treat the first as the second.
**A confident "safe to run" is not permission to skip review of the risky case,
and a confident "done" is not proof that anything was done.**

```ts
nodes: {
  vet: {
    decide: {
      destructive: noul("Would running this command delete, overwrite or move data that cannot be recovered?"),
      reaches_out:  noul("Would running this command send data to a machine other than this one?"),
    },
    reads: ["command"],
  },
  run_it:  { work: "execute", reads: ["command"], writes: ["receipt"] },
  confirm: {                                  // deterministic, and free
    code: async (s) => existsSync(String(s.expected_path)) && (await stat(String(s.expected_path))).size > 0,
    reads: ["expected_path", "receipt"],
    writes: ["verified"],
  },
  ask_a_person: { work: "request_approval", reads: ["command"], writes: ["receipt"] },
  done:   { work: "report", reads: ["receipt"], writes: ["outcome"] },
  failed: { work: "report_failure", reads: ["receipt"], writes: ["outcome"] },
},
edges: [
  // Asymmetric on purpose: the model may only make the CHEAP mistake.
  // Auto-run only when it is very sure the command is harmless; everything
  // else goes to a person. Never the other way round.
  { from: "vet", to: "run_it", when: (s) => {
      const destructive = Number(s.destructive), reaches = Number(s.reaches_out);
      return destructive < 0.1 && reaches < 0.1;
  } },
  { from: "vet", to: "ask_a_person" },

  { from: "run_it", to: "confirm" },
  { from: "confirm", to: "done",   when: (s) => s.verified === true },
  { from: "confirm", to: "failed" },
]
```

Rules:

- **The gate is asymmetric.** Choose which mistake the model is allowed to make.
  Here a false "dangerous" costs a person a click; a false "safe" costs data. So
  the auto-run threshold sits near zero and every other case escalates.
- **Check the effect, not the decision.** After an action, a `code` node looks at
  the world — the file exists, the row is there, the API returned the id —
  instead of asking a model whether it went well. It is free, deterministic, and
  the only thing that turns "it said it did it" into "it did it".
- **Under `supervise`, this is also what makes a restart safe.** A tick that
  died after `run_it` but before `confirm` comes back through
  `next({ interrupted })` with the steps it already took, so the next attempt can
  check before running the command a second time.

## 15. A person in the loop

A person is just another decider: a `decide` node with `by: "human"` asks the
same closed questions Jev would, so the graph stays complete and `validate`
still proves every answer is wired. The shape that earns it: **Jev handles the
common case, a person handles the uncertain or consequential one.**

```ts
nodes: {
  classify: {
    decide: { action: choice("What should happen to this refund request?", { approve: …, reject: …, investigate: … }) },
    reads: ["request", "history"],
    gate: { on: "action", min: 0.8, to: "review" },   // unsure → a person
    fallback: "review",                                // decider down → a person
  },
  review: {
    decide: { action: choice("What should happen to this refund request?", { approve: …, reject: …, investigate: … }) },
    reads: ["request", "history", "action"],          // the person sees what Jev proposed
    by: "human",
    comment: "review_note",
  },
  …
},
edges: [
  // Money over a threshold always goes to a person, whatever Jev said — arithmetic, in code.
  { from: "classify", to: "review",  when: (s) => { const amount = Number(s.amount); return amount > 500; } },
  { from: "classify", to: "pay",     on: "action=approve" },
  { from: "classify", to: "refuse",  on: "action=reject" },
  { from: "classify", to: "dig",     on: "action=investigate" },
  // The person's answer is routed exactly like Jev's.
  { from: "review", to: "pay",    on: "action=approve" },
  { from: "review", to: "refuse", on: "action=reject" },
  { from: "review", to: "dig",    on: "action=investigate" },
],
```

Rules:

- **Ask the person the same question Jev was asked.** Then both answers land on
  the same key, the downstream edges are shared, and `run.json` shows who
  decided. Put Jev's proposal in the person's `reads` so they see it.
- **Three roads to a person, each for a different reason:** a `gate` (Jev is
  unsure), a `when:` (the stakes are high whatever Jev thinks), and a `fallback`
  (Jev could not answer at all).
- **Short runs wait, long ones pause.** A `human` handler in the run options
  waits for a terminal, a chat button, a form. Without one the run pauses and
  returns `paused`; store it and call `runner.resume(paused, answer)` when the
  answer arrives — minutes or days later, in another process. Under `supervise`,
  paused ticks are parked (`onPaused`) and the loop keeps going.
- **Never inside a fork.** A run can pause on one lane only; ask after the join.
- **Dry-run it like any decision.** The dry run answers for the person from the
  same `--answer` script (`--answer review.action=reject`), and `--explore` walks
  every answer they could give.
