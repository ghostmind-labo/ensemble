# In-process: an agent inside a `work` node

This is one of four ways to use an agent from a graph. The other three declare an
external agent and reach it through a standard protocol ([A2A](agents-a2a.md),
[ACP](agents-acp.md), [MCP](agents-mcp.md)); [Agents](agents.md) compares them. Reach
for this one when you want the agent's own API in your hands: its hooks, its event log,
tools you write in the same file.

| | In-process (`work` node) | Declared (`agent` node) |
|---|---|---|
| **The agent is** | A library you import and call | A separate program or service |
| **You need installed** | The library: `npm i @ghostmind-dev/agento`, or any agent SDK | Nothing (A2A, remote MCP), or the agent's command (ACP, local MCP) |
| **Tools, hooks, approvals** | Yours, in code: an `approve` callback can ask a person | The agent's own; an ACP permission request is answered by a declared policy |
| **`graph.json` shows** | One `work` step, by handler name. The loop is opaque | The agent's name, protocol, address or command |
| **Cost in `run.json`** | What your handler passes to `report({ cost })`. Skip it and the step looks free | What the protocol reports, else `"unknown"` |
| **What can go wrong** | A cost that is never reported; a handler that ignores `signal` and outlives the run | See each protocol's page |
| **Local library** | Yes | Yes |
| **Hosted ensemble** | No: the sandbox imports `@ghostmind-dev/ensemble` and nothing else | A2A, and MCP on a remote server ([the table](agents.md#in-hosted-ensemble)) |

`@ghostmind-dev/agento` is a separate, independent package: the engine an app builds
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

`@ghostmind-dev/agento` replaces the earlier `@ghostmind-dev/agent` package name. The
library API below (`runAgent`, `openrouter`, `eventLog`) is checked against its source.
It needs `OPENROUTER_API_KEY` and nothing else
([what that covers](agents-build.md#5-requirements-for-an-agent-meant-for-the-catalog)).
The same engine is also a command, so it can be declared instead of imported: as an
[`acp`](agents-acp.md#the-declarations-to-use) agent or an
[`mcp`](agents-mcp.md#agento-mcp) one.

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
import { eventLog, openrouter, runAgent, type AgentTool } from "@ghostmind-dev/agento";

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

`npx ensemble validate` proves it. The dry run
(`node plugin/skills/ensemble-build/scripts/dryrun.mts runner.mts --explore`) runs
`work` handlers for real, so it explores every branch for $0 once the agent is on a
scripted model (`scriptedModel()`, exported by `@ghostmind-dev/agento`), or with
`--stub-work`, which replaces the handler. That is how both halves are tested offline.

## When to reach for it

- **Use explicit nodes** when the steps are known: they appear in `graph.json`, are
  proven by `validate`, and each decision is calibrated.
- **Use the agent in a `work` node** when the steps are not known in advance — the
  request is open-ended and the right tools depend on what the first one returns.
- **Let ensemble supervise it** when it must run for long or unattended: `supervise()`
  around the runner adds budgets per day, a journal to resume from, and a watcher that
  asks Jev whether the work is still on track.

Keep the agent's own budget (`budget.maxUsd`) *inside* the step and ensemble's run
budget *around* it: the first stops a runaway loop, the second a runaway graph. Pass
`signal` through, as the runner above does: it is how `stepTimeout`, the budget and a
cancelled run reach the loop.

## Safety

The agent's tools are code you wrote, running in your process, so
[the safety rule](agents.md#the-safety-rule) takes this form here: give the agent only
the tools the step needs, put every write behind `approve`, and when nobody is there to
approve, leave the write tools out of `toolsets` rather than offering and refusing
them. The `review` node after it is what judges the result.
