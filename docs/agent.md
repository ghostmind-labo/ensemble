# The agent as a component

`@ghostmind-dev/agent` is a separate, independent package: the engine an app builds
its own tool-using agent from. It has its own loop, its own guards, a dollar cap,
go/pause/stop hooks, an append-only event log, and Jev as a guide that keeps a weaker
model on course. Ensemble does not depend on it, and it does not depend on ensemble.

The two do opposite jobs, and fit together cleanly:

| | The agent | Ensemble |
|---|---|---|
| **Who picks the next step** | The model, at run time: a tool, the result, another tool | You, when you write the graph. Jev picks among the branches you declared |
| **Good at** | Open-ended requests nobody anticipated | Repeatable processes that must be provable, bounded and cheap |
| **Known before it runs** | The tools it *could* use | Every branch and every key's origin, proven by `validate` |

So the agent is a **special component**: one `work` node that holds a whole agent.
Ensemble supplies what surrounds it — the route in, the budget and the stop signal,
a record of what it cost, and a calibrated check of what it produced. The agent never
marks its own work as good enough; a `decide` node after it does.

> Status: `@ghostmind-dev/agent` 0.1.0 is not yet published to npm. The pattern below
> was tested by installing its packed tarball next to `@ghostmind-dev/ensemble` in a
> fresh project.

## The shape

```
triage (Jev) ──direct──▶ answer (code) ───────────────────────▶ deliver
     └──agent──▶ agent (work: runAgent) ─▶ review (Jev) ──ok──▶ deliver
                          ▲                      └─weak─▶ tally ─(1 retry)─┘
```

- **Before it:** a `decide` node decides whether the request needs an agent at all.
  Most don't, and those take the cheap, provable path.
- **The agent:** one `work` node. Its loop is opaque to `graph.json`, which shows one
  step; its cost, status and step count land in `run.json` through `report()`.
- **After it:** a `decide` node asks whether the reply answers the request. A weak
  reply goes round once more; the loop budget lives on the edge, so it cannot spin.

## The runner

```ts
import { choice, noul, runner } from "@ghostmind-dev/ensemble";
import { eventLog, openrouter, runAgent, type AgentTool } from "@ghostmind-dev/agent";

const tools: AgentTool[] = [/* your tools: reads, and writes that ask approval */];

export default runner({
  name: "agent-in-a-graph",
  inputs: ["goal"],

  work: {
    // The whole agent is one step. Ensemble bounds it (signal), prices it (report),
    // and judges it (the review node after it).
    agent: async ({ goal, signal, report }) => {
      const log = eventLog();
      const result = await runAgent({
        provider: openrouter({ model: process.env.AGENT_MODEL! }),
        task: { goal, expectation: "One or two sentences: the answer, and what was changed." },
        toolsets: [{ name: "app", description: "What this agent can do.", tools }],
        approve: async (request) => askYourPerson(request.summary),
        budget: { maxUsd: 0.05 },
        signal,
        log,
      });
      report({
        cost: result.cost,
        meta: { status: result.status, reason: result.reason, steps: result.steps, toolCalls: result.toolCalls },
      });
      return { reply: result.answer ?? "", agent_status: result.status };
    },
  },

  nodes: {
    triage: {
      decide: {
        route: choice(
          { question: "How should this request be handled?", focus: "Does it need live data or a change made?" },
          {
            direct: { what: "Answerable from general knowledge", not_for: "Anything needing a tool" },
            agent: { what: "Needs a tool: live data, or saving something", not_for: "Small talk" },
          },
        ),
      },
      reads: ["goal"],
    },
    answer: { code: (s) => String(s["goal"]), reads: ["goal"], writes: ["reply"] },
    agent: { work: "agent", reads: ["goal"], writes: ["reply", "agent_status"] },
    review: { decide: { answered: noul("Does the reply fully answer what the person asked?") }, reads: ["goal", "reply"] },
    tally: { code: (s) => Number(s["rounds"] ?? 0) + 1, reads: ["rounds"], writes: ["rounds"] },
    deliver: { code: (s) => String(s["reply"]), reads: ["reply"], writes: ["final"] },
  },

  edges: [
    { from: "triage", to: "answer", on: "route=direct" },
    { from: "triage", to: "agent", on: "route=agent" },
    { from: "answer", to: "deliver" },
    { from: "agent", to: "review" },
    { from: "review", to: "tally", when: (s) => Number(s["answered"]) < 0.5 },
    { from: "review", to: "deliver" },
    { from: "tally", to: "agent", maxLoops: 1 },
    { from: "tally", to: "deliver" },
  ],

  entry: "triage",
  result: "final",
});
```

`ensemble validate` proves it; the dry-runner explores every branch for $0 once the
agent runs on a scripted model (`scriptedModel()` from the agent package), which is
how both halves are tested offline.

## When to reach for it

- **Use explicit nodes** when the steps are known: they appear in `graph.json`, are
  proven by `validate`, and each decision is calibrated.
- **Use the agent in a `work` node** when the steps are not known in advance — the
  request is open-ended and the right tools depend on what the first one returns.
- **Let ensemble supervise it** when it must run for long or unattended: `supervise()`
  around the runner adds budgets per day, a journal to resume from, and a watcher that
  asks Jev whether the work is still on track.

Keep the agent's own budget (`budget.maxUsd`) *inside* the step and ensemble's run
budget *around* it: the first stops a runaway loop, the second a runaway graph.
