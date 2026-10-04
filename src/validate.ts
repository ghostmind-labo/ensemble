/**
 * The proof.
 *
 * Every check here exists because the alternative is a workflow that runs and
 * looks fine. A branch nobody wired silently falls through to the exit. A key
 * nobody writes reaches a decide node as `undefined`, and the model is simply
 * not told. Neither raises an error at run time; both are bugs you find weeks
 * later in an output that was merely plausible.
 *
 * So validation is not a lint pass, it is the reason the closed answer space
 * was worth having: because Jev's options are declared, "did you handle every
 * case?" is a question that can actually be answered, statically and for free.
 *
 * Problems are returned as strings, never thrown. `validate` is a report;
 * `execute` is what refuses to run.
 */
import {
  branchHolds,
  externalKeys,
  imageKeys,
  isAgent,
  isCode,
  isDecide,
  isHuman,
  isMcp,
  isModel,
  isWork,
  lanesOf,
  parseBranch,
  probeReads,
  producers,
  readsOf,
  writesOf,
  type Branch,
  type Edge,
  type RunnerSpec,
} from "./spec.ts";
import { optionsOf } from "./questions.ts";
import { literalSecrets, safeUrl, authList } from "./mcp-auth.ts";
import type { McpServerSpec, RemoteServerSpec } from "./mcp.ts";
import { ACP_TOOL_KINDS, AGENT_PROTOCOLS, type AgentSpec } from "./agent.ts";
import { forwardServer } from "./acp.ts";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const list = (xs: string[]): string => xs.map((x) => `"${x}"`).join(", ");

export function validate(spec: RunnerSpec): string[] {
  const problems: string[] = [];
  const nodes = Object.entries(spec.nodes ?? {});
  const pictures = imageKeys(spec);
  const names = new Set(nodes.map(([name]) => name));
  const edges = spec.edges ?? [];

  if (nodes.length === 0) return ["a runner needs at least one node"];
  if (!spec.entry) problems.push(`no entry — name the node the run starts at`);
  else if (!names.has(spec.entry)) {
    problems.push(`entry "${spec.entry}" is not a node. Nodes: ${list([...names])}`);
  }

  /* ── nodes ── */
  for (const [name, node] of nodes) {
    const kinds = [
      isDecide(node) && "decide",
      isWork(node) && "work",
      isCode(node) && "code",
      isModel(node) && "model",
      isMcp(node) && "mcp",
      isAgent(node) && "agent",
    ].filter(Boolean);
    if (kinds.length !== 1) {
      problems.push(
        kinds.length === 0
          ? `node "${name}" is none of decide / work / code / model / mcp / agent — a node must be exactly one`
          : `node "${name}" is both ${kinds.join(" and ")} — a node must be exactly one`,
      );
      continue;
    }

    if (isDecide(node)) {
      const keys = Object.keys(node.decide);
      if (keys.length === 0) problems.push(`node "${name}" has an empty decide block — ask at least one question`);
      for (const key of keys) {
        if (!IDENT.test(key)) {
          problems.push(
            `node "${name}" asks "${key}", which is not a valid identifier — question keys become ` +
              `state keys and branch labels, so they must read as names`,
          );
        }
      }
      if (!Array.isArray(node.reads) || node.reads.length === 0) {
        problems.push(
          `node "${name}" declares no reads — a decide node must name the state it sends. ` +
            `Accuracy falls as irrelevant detail grows, so the filter is the feature: reads: ["goal"]`,
        );
      }
      const looking = node.reads?.filter((key) => pictures.has(key)) ?? [];
      if (looking.length) {
        problems.push(
          `node "${name}" sends ${list(looking)} to the decider, but ${looking.length === 1 ? "that key holds" : "those keys hold"} ` +
            `image data and Jev takes text only. Have a model node look at ${looking.length === 1 ? "it" : "them"} ` +
            `and write down what it saw, then decide on that.`,
        );
      }
      if (node.gate) {
        const question = node.decide[node.gate.on];
        if (!question) {
          problems.push(
            `node "${name}" gates on "${node.gate.on}", which it does not ask. Asked here: ${list(keys)}`,
          );
        } else if (question.type === "noul") {
          problems.push(
            `node "${name}" gates on "${node.gate.on}", a noul — a noul reports no confidence, ` +
              `its value IS its certainty. Gate on a choice or a score, or branch with when:`,
          );
        }
        if (!names.has(node.gate.to)) {
          problems.push(`node "${name}" gates to "${node.gate.to}", which is not a node`);
        }
        if (!(node.gate.min >= 0 && node.gate.min <= 1)) {
          problems.push(`node "${name}" has gate.min ${node.gate.min} — confidence is between 0 and 1`);
        }
      }
      if (node.by !== undefined && node.by !== "human") {
        problems.push(`node "${name}" has by: ${JSON.stringify(node.by)} — omit it for the decider, or write by: "human" to ask a person`);
      }
      if (node.by === "human" && node.gate) {
        problems.push(
          `node "${name}" is answered by a person and has a gate — a person's answer carries no confidence to gate on. ` +
            `Remove the gate and route on the answer with on: edges`,
        );
      }
      if (node.comment !== undefined) {
        if (node.by !== "human") {
          problems.push(`node "${name}" declares comment but is not by: "human" — only a person leaves a note`);
        } else if (!IDENT.test(node.comment)) {
          problems.push(`node "${name}" has comment "${node.comment}", which is not a valid identifier — it becomes a state key`);
        } else if (keys.includes(node.comment)) {
          problems.push(`node "${name}" writes its comment to "${node.comment}", which is also a question key — give the note its own key`);
        }
      }
      if (node.fallback !== undefined && !names.has(node.fallback)) {
        problems.push(`node "${name}" falls back to "${node.fallback}", which is not a node`);
      }
    }

    if (isWork(node) && !spec.work?.[node.work]) {
      const known = Object.keys(spec.work ?? {});
      problems.push(
        `node "${name}" runs work "${node.work}", which is not in the work map. ` +
          (known.length ? `Registered: ${list(known)}` : `No handlers are registered.`),
      );
    }

    if (isCode(node) && typeof node.code !== "function") {
      problems.push(`node "${name}" declares code that is not a function`);
    }

    if (isModel(node)) {
      if (typeof node.model === "string" ? !node.model : !node.model?.from) {
        problems.push(`node "${name}" names no model — give it an id, or { from: "<state key>" }`);
      }
      if (!node.prompt) problems.push(`node "${name}" has no prompt — the instruction IS the node`);
      const writes = node.writes ?? [];
      if (writes.length > 2) {
        problems.push(
          `node "${name}" declares writes ${list(writes)} — a model node writes at most two keys, ` +
            `positionally: [text] or [text, images]`,
        );
      }
      if (node.sees?.length && writes.length > 1 && node.sees.includes(writes[1]!)) {
        problems.push(`node "${name}" both looks at and overwrites "${writes[1]}" in one step`);
      }
      if (Array.isArray(node.skills)) {
        const registry = spec.skills ?? [];
        for (const wanted of node.skills) {
          if (wanted === "none" || registry.some((skill) => skill.name === wanted)) continue;
          problems.push(
            registry.length
              ? `node "${name}" names skill "${wanted}", which is not in the runner's registry. ` +
                `Loaded: ${list(registry.map((s) => s.name).slice(0, 12))}${registry.length > 12 ? ", …" : ""}`
              : `node "${name}" names skill "${wanted}" but the runner loaded no skills — ` +
                `pass skills: loadSkills() to the runner`,
          );
        }
      }
    }

    if (isMcp(node)) {
      const servers = spec.mcpServers ?? {};
      if (!node.mcp?.server) problems.push(`node "${name}" names no MCP server`);
      else if (!servers[node.mcp.server]) {
        const known = Object.keys(servers);
        problems.push(
          `node "${name}" uses MCP server "${node.mcp.server}", which the runner does not declare. ` +
            (known.length ? `Declared: ${list(known)}` : `No mcpServers are declared.`),
        );
      }
      if (typeof node.mcp?.tool === "string" ? !node.mcp.tool : !node.mcp?.tool?.from) {
        problems.push(`node "${name}" names no tool — give it a name, or { from: "<state key>" }`);
      }
      if ((node.writes ?? []).length > 2) {
        problems.push(
          `node "${name}" declares writes ${list(node.writes!)} — an mcp node writes at most two keys, ` +
            `positionally: [text] or [text, data]`,
        );
      }
    }

    if (isAgent(node)) {
      const agents = spec.agents ?? {};
      if (!node.agent || typeof node.agent !== "string") {
        problems.push(`node "${name}" names no agent — give it a key of the runner's agents: { … }`);
      } else if (!agents[node.agent]) {
        const known = Object.keys(agents);
        problems.push(
          `node "${name}" delegates to agent "${node.agent}", which the runner does not declare. ` +
            (known.length
              ? `Declared: ${list(known)}`
              : `Declare it: agents: { ${IDENT.test(node.agent) ? node.agent : JSON.stringify(node.agent)}: { protocol: "a2a", url: "https://…" } }`),
        );
      }
      if (node.prompt !== undefined && typeof node.prompt !== "string" && typeof node.prompt !== "function") {
        problems.push(`node "${name}" has a prompt that is neither text nor a function — or leave it out to send the node's reads`);
      }
      if (node.prompt === "") {
        problems.push(`node "${name}" has an empty prompt — write the request, or leave prompt out to send the node's reads`);
      }
      if ((node.writes ?? []).length > 2) {
        problems.push(
          `node "${name}" declares writes ${list(node.writes!)} — an agent node writes at most two keys, ` +
            `positionally: [text] or [text, detail]`,
        );
      }
    }
  }

  /* ── edges ── */
  const branches = new Map<Edge, Branch>();
  for (const [index, edge] of edges.entries()) {
    const where = `edge ${index} (${edge.from}→${edge.to})`;
    if (!names.has(edge.from)) problems.push(`${where}: "${edge.from}" is not a node`);
    if (!names.has(edge.to)) problems.push(`${where}: "${edge.to}" is not a node`);
    if (edge.on && edge.when) {
      problems.push(`${where}: has both on and when — a branch is on meaning or on arithmetic, not both`);
    }
    // An edge that can never be taken is an edge that does not exist, and it
    // fails the way everything here fails: quietly, as a path nobody walks.
    if (edge.maxLoops !== undefined && !(Number.isInteger(edge.maxLoops) && edge.maxLoops >= 1)) {
      problems.push(
        `${where}: maxLoops is ${JSON.stringify(edge.maxLoops)} — it is how many times the edge may be ` +
          `taken, so it must be a whole number of 1 or more. Drop it for no limit`,
      );
    }
    if (!edge.on) continue;

    let branch: Branch;
    try {
      branch = parseBranch(edge.on);
    } catch (error) {
      problems.push(`${where}: ${(error as Error).message}`);
      continue;
    }
    branches.set(edge, branch);

    const from = spec.nodes[edge.from];
    if (!from) continue;
    if (!isDecide(from)) {
      problems.push(
        `${where}: on: "${edge.on}" leaves "${edge.from}", which is not a decide node. ` +
          `An on: branch must leave the node that answered it — to branch on a key written earlier, use when:`,
      );
      continue;
    }
    const question = from.decide[branch.key];
    if (!question) {
      problems.push(
        `${where}: on: "${edge.on}" reads "${branch.key}", which "${edge.from}" does not ask. ` +
          `Asked there: ${list(Object.keys(from.decide))}`,
      );
      continue;
    }
    if (branch.kind === "option") {
      if (question.type !== "choice") {
        problems.push(`${where}: on: "${edge.on}" uses "=", which only a choice answers (${branch.key} is a ${question.type})`);
      } else if (!optionsOf(question).includes(branch.option)) {
        problems.push(
          `${where}: "${branch.key}" has no option "${branch.option}". Declared: ${list(optionsOf(question))}`,
        );
      }
    } else if (question.type !== "noul") {
      problems.push(
        question.type === "score"
          ? `${where}: on: "${edge.on}" thresholds "${branch.key}", a score. A score is a number — ` +
            `branch on it with when: (s) => s.${branch.key} >= ${branch.value}`
          : `${where}: on: "${edge.on}" thresholds "${branch.key}", a choice. Use "${branch.key}=<option>"`,
      );
    }
  }

  /**
   * Does a set of threshold branches cover the whole 0–1 range a noul can
   * answer? Returns the first value that nothing handles, or undefined.
   *
   * Worth proving because the gap is invisible otherwise: `on: "sure>=0.7"` as
   * the only edge routes a confident yes and drops everything below it at the
   * exit, and `"sure>=0.7"` next to `"!sure"` leaves the 0.5–0.7 band nobody
   * looks at. Both read as complete and neither is.
   */
  const uncovered = (thresholds: Branch[]): { at: number; inclusive: boolean } | undefined => {
    type Span = { lo: number; loOpen: boolean; hi: number; hiOpen: boolean };
    const spans = thresholds.flatMap((branch): Span[] => {
      if (branch.kind !== "threshold") return [];
      const { op, value } = branch;
      return op === ">=" ? [{ lo: value, loOpen: false, hi: 1, hiOpen: false }]
        : op === ">" ? [{ lo: value, loOpen: true, hi: 1, hiOpen: false }]
        : op === "<=" ? [{ lo: 0, loOpen: false, hi: value, hiOpen: false }]
        : [{ lo: 0, loOpen: false, hi: value, hiOpen: true }];
    });
    spans.sort((a, b) => a.lo - b.lo || Number(a.loOpen) - Number(b.loOpen));
    // The smallest point not yet known to be covered: `at` itself when
    // `inclusive`, otherwise everything just above `at`.
    let at = 0;
    let inclusive = true;
    for (const span of spans) {
      if (span.lo > at) break;
      if (span.lo === at && inclusive && span.loOpen) break;
      const reaches = { at: span.hi, inclusive: span.hiOpen };
      if (reaches.at > at || (reaches.at === at && !reaches.inclusive && inclusive)) {
        at = reaches.at;
        inclusive = reaches.inclusive;
      }
    }
    // `inclusive` distinguishes "nothing handles 0.3" from "nothing handles
    // anything above 0.3", which are different mistakes and different fixes.
    return at > 1 || (at === 1 && !inclusive) ? undefined : { at, inclusive };
  };

  /* ── exhaustiveness: every declared option goes somewhere ── */
  for (const [name, node] of nodes) {
    if (!isDecide(node)) continue;
    const outgoing = edges.filter((edge) => edge.from === name);
    if (outgoing.some((edge) => !edge.on && !edge.when)) continue; // a bare edge is the default

    const branchedOn = new Set(
      outgoing
        .map((edge) => branches.get(edge))
        .filter((branch): branch is Branch => branch?.kind === "option")
        .map((branch) => branch.key),
    );
    for (const key of branchedOn) {
      const question = node.decide[key];
      if (!question || question.type !== "choice") continue;
      const covered = new Set(
        outgoing
          .map((edge) => branches.get(edge))
          .filter((branch): branch is Extract<Branch, { kind: "option" }> => branch?.kind === "option" && branch.key === key)
          .map((branch) => branch.option),
      );
      const missing = optionsOf(question).filter((option) => !covered.has(option));
      if (missing.length) {
        problems.push(
          `node "${name}" asks "${key}" but nothing handles ${list(missing)} — the run would fall ` +
            `through to the exit on ${missing.length === 1 ? "that answer" : "those answers"}. ` +
            `Wire ${missing.length === 1 ? "it" : "them"}, or add a default edge from "${name}" with no on/when.`,
        );
      }
    }

    /*
     * The same proof for a noul, whose answer space is the 0–1 range rather than
     * a list of options.
     *
     * Held to a higher bar than the choice check above, because a decide node
     * asks SEVERAL questions and one exhaustive key is enough to keep the run on
     * the graph. A threshold edge is very often a priority override — "a hazard
     * outranks whatever the classifier picked" — sitting in front of edges that
     * are already exhaustive, and flagging that would be crying wolf. So this
     * only speaks when a fall-through is provable: no forks (they all fire
     * anyway), no `when:` edge (opaque code that may well catch everything), and
     * no choice at this node already covered end to end.
     */
    if (outgoing.some((edge) => edge.fork || edge.when)) continue;
    const settled = [...branchedOn].some((key) => {
      const question = node.decide[key];
      if (question?.type !== "choice") return false;
      const covered = new Set(
        outgoing
          .map((edge) => branches.get(edge))
          .filter((branch): branch is Extract<Branch, { kind: "option" }> => branch?.kind === "option" && branch.key === key)
          .map((branch) => branch.option),
      );
      return optionsOf(question).every((option) => covered.has(option));
    });
    if (settled) continue;
    const thresholded = new Set(
      outgoing
        .map((edge) => branches.get(edge))
        .filter((branch): branch is Branch => branch?.kind === "threshold")
        .map((branch) => branch.key),
    );
    for (const key of thresholded) {
      if (node.decide[key]?.type !== "noul") continue;
      const mine = outgoing
        .map((edge) => branches.get(edge))
        .filter((branch): branch is Extract<Branch, { kind: "threshold" }> => branch?.kind === "threshold" && branch.key === key);
      const gap = uncovered(mine);
      if (gap === undefined) continue;
      // Name the edge that closes it: everything from the gap up to the lowest
      // band already handled above it, or up to 1 when nothing is.
      const above = mine
        .filter((branch) => (branch.op === ">=" || branch.op === ">") && branch.value > gap.at)
        .map((branch) => branch.value)
        .sort((a, b) => a - b)[0];
      const where = gap.inclusive ? `an answer of ${gap.at}` : `an answer just above ${gap.at}`;
      const fix = above === undefined
        ? `${key}${gap.inclusive ? ">=" : ">"}${gap.at}`
        : `${key}<${above}`;
      problems.push(
        `node "${name}" asks "${key}", a noul, but nothing handles ${where}` +
          `${above === undefined ? "" : ` up to ${above}`} — a noul answers anywhere from 0 to 1, ` +
          `and the run would fall through to the exit there. Cover it with on: "${fix}", ` +
          `or add a default edge from "${name}" with no on/when.`,
      );
    }
  }

  /* ── parallelism: forks fan out, joins fan in, lanes never collide ── */
  for (const name of names) {
    const outgoing = edges.filter((edge) => edge.from === name);
    const forks = outgoing.filter((edge) => edge.fork);
    if (forks.length && forks.length !== outgoing.length) {
      problems.push(
        `node "${name}" has ${forks.length} forking edge${forks.length === 1 ? "" : "s"} and ` +
          `${outgoing.length - forks.length} ordinary — a node's edges are all forks (they fire together) ` +
          `or none (first match wins). Mark them all fork: true, or move the ordinary ones to another node`,
      );
    }
    const node = spec.nodes[name]!;
    if (node.join) {
      const incoming = edges.filter((edge) => edge.to === name);
      if (name === spec.entry) problems.push(`entry "${name}" is a join — nothing can arrive before the run starts`);
      else if (incoming.length < 2) {
        problems.push(
          `node "${name}" is join: "all" but ${incoming.length === 1 ? "only one edge leads" : "no edge leads"} there — ` +
            `a join waits for several lanes. Point every lane's last edge at it, or drop the join`,
        );
      }
    }
  }
  for (const name of names) {
    const forks = edges.filter((edge) => edge.from === name && edge.fork);
    if (forks.length < 2) continue;
    const lanes = lanesOf(spec, name);
    const touched = (lane: (typeof lanes)[number]): { writes: Set<string>; reads: Set<string> } => {
      const writes = new Set<string>();
      const reads = new Set<string>();
      for (const at of lane.nodes) {
        const node = spec.nodes[at]!;
        for (const key of writesOf(node)) writes.add(key);
        for (const key of readsOf(node)) reads.add(key);
        for (const edge of edges) {
          if (edge.from !== at) continue;
          for (const key of edge.when ? probeReads(edge.when) : []) reads.add(key);
        }
      }
      return { writes, reads };
    };
    for (const lane of lanes) {
      const asks = [...lane.nodes].filter((at) => isHuman(spec.nodes[at]!));
      if (asks.length) {
        problems.push(
          `node "${name}" forks to "${lane.to}", and that lane asks a person at ${list(asks)} — a run can pause on ` +
            `only one lane. Move the question after the join`,
        );
      }
    }
    for (let i = 0; i < lanes.length; i++) {
      for (let j = i + 1; j < lanes.length; j++) {
        const a = lanes[i]!, b = lanes[j]!;
        const shared = [...a.nodes].filter((at) => b.nodes.has(at));
        if (shared.length) {
          problems.push(
            `node "${name}" forks to "${a.to}" and "${b.to}", but both lanes reach ${list(shared)} — ` +
              `a node cannot run in two lanes at once. Mark it join: "all" if the lanes should meet there, ` +
              `or give each lane its own copy`,
          );
          continue;
        }
        const ta = touched(a), tb = touched(b);
        const collide = [...ta.writes].filter((key) => tb.writes.has(key) || tb.reads.has(key))
          .concat([...tb.writes].filter((key) => ta.reads.has(key)));
        if (collide.length) {
          problems.push(
            `node "${name}" forks to "${a.to}" and "${b.to}", but the lanes both touch ${list([...new Set(collide)])} — ` +
              `concurrent lanes must write and read disjoint keys, or the result depends on timing. ` +
              `Write to separate keys and combine them after the join`,
          );
        }
      }
    }
  }

  /* ── memory: declared, so it must be written, and it is not also an input ── */
  const wroteEarly = producers(spec);
  for (const key of spec.memory ?? []) {
    if (!IDENT.test(key)) problems.push(`memory key "${key}" is not a valid identifier`);
    if (spec.inputs?.includes(key)) {
      problems.push(`"${key}" is both an input and memory — an input arrives each run, memory carries over. Pick one`);
    }
    if (!wroteEarly[key]) {
      problems.push(
        `memory key "${key}" is never written — it would never change between ticks. ` +
          `Add it to a node's writes, or declare it in inputs instead`,
      );
    }
  }

  /* ── the data graph: every key read has an origin ── */
  const wrote = producers(spec);
  const external = externalKeys(spec);
  const hasOrigin = (key: string): boolean => external.includes(key) || Boolean(wrote[key]);
  const known = (): string => {
    const produced = Object.keys(wrote).sort();
    return (
      (produced.length
        ? `Written in this runner: ${produced.map((k) => `"${k}" (by ${wrote[k]!.join(", ")})`).join(", ")}.`
        : `No node here writes anything.`) +
      ` If it comes from outside the run, declare it: inputs: ["…"] on the runner.`
    );
  };

  for (const [name, node] of nodes) {
    for (const key of readsOf(node)) {
      if (hasOrigin(key)) continue;
      problems.push(
        `node "${name}" reads "${key}" but nothing writes it — the node would run with that ` +
          `context silently missing. ${known()}`,
      );
    }
  }
  for (const [index, edge] of edges.entries()) {
    const keys = edge.when ? probeReads(edge.when) : [];
    for (const key of keys) {
      if (hasOrigin(key)) continue;
      problems.push(
        `edge ${index} (${edge.from}→${edge.to}) reads "${key}" in its when() but nothing writes it — ` +
          `the condition would only ever see undefined. ${known()}`,
      );
    }
  }
  if (spec.result && !hasOrigin(spec.result)) {
    problems.push(`result: "${spec.result}" is never written. ${known()}`);
  }

  /* ── mcp servers: a command or a url, and auth that can work ── */
  for (const [server, raw] of Object.entries(spec.mcpServers ?? {})) problems.push(...serverProblems(server, raw));

  /* ── agents: one of three protocols, each with what it needs to be reached ── */
  for (const [agent, raw] of Object.entries(spec.agents ?? {})) problems.push(...agentProblems(agent, raw, spec));

  /* ── reachability ── */
  if (spec.entry && names.has(spec.entry)) {
    const reached = new Set([spec.entry]);
    const queue = [spec.entry];
    while (queue.length) {
      const at = queue.shift()!;
      const node = spec.nodes[at];
      const next = edges.filter((edge) => edge.from === at).map((edge) => edge.to);
      if (node && isDecide(node) && node.gate) next.push(node.gate.to);
      if (node && isDecide(node) && node.fallback) next.push(node.fallback);
      for (const to of next) {
        if (names.has(to) && !reached.has(to)) {
          reached.add(to);
          queue.push(to);
        }
      }
    }
    const orphans = [...names].filter((name) => !reached.has(name));
    if (orphans.length) {
      problems.push(`unreachable from "${spec.entry}": ${list(orphans)} — no edge leads there`);
    }
  }

  return problems;
}

/** Sanity check used by the tests: does this branch string hold against this state? */
export const holds = (on: string, state: Record<string, unknown>): boolean =>
  branchHolds(parseBranch(on), state);

const TRANSPORTS = ["auto", "streamable-http", "sse", "websocket"];
const GRANTS = ["authorization_code", "device_code", "client_credentials", "refresh_token"];
const CLIENT_AUTH = ["none", "client_secret_basic", "client_secret_post", "private_key_jwt"];

/** One declared agent: a known protocol, and the fields that protocol cannot work without. */
function agentProblems(agent: string, raw: AgentSpec, spec: RunnerSpec): string[] {
  const at = `agent "${agent}"`;
  const fields = (raw ?? {}) as unknown as Record<string, unknown>;
  const protocol = fields["protocol"];
  if (typeof protocol !== "string" || !(AGENT_PROTOCOLS as readonly string[]).includes(protocol)) {
    const guess = typeof fields["url"] === "string" ? "a2a" : typeof fields["command"] === "string" ? "acp" : typeof fields["server"] === "string" ? "mcp" : undefined;
    return [
      `${at} has protocol ${JSON.stringify(protocol)} — say how it is reached: protocol: "a2a" (a hosted agent, by url), ` +
        `"acp" (a local agent, launched as a command) or "mcp" (an agent offered as a tool)` +
        (guess ? `. This one looks like protocol: "${guess}"` : ""),
    ];
  }
  const problems: string[] = [];
  if (raw.protocol === "a2a") {
    if (typeof raw.url !== "string" || !raw.url) return [`${at} needs url — where the agent lives, e.g. https://agent.example.com`];
    let url: URL | undefined;
    try {
      url = new URL(raw.url);
    } catch {
      problems.push(`${at} has url "${raw.url}", which is not a url — e.g. https://agent.example.com`);
    }
    if (url && !["http:", "https:"].includes(url.protocol)) problems.push(`${at} uses ${url.protocol}// — an A2A agent is reached over http(s)://`);
    for (const field of ["card", "endpoint"] as const) {
      const value = raw[field];
      if (value === undefined) continue;
      try {
        new URL(value, url);
      } catch {
        problems.push(`${at} has ${field} "${value}", which is not a url`);
      }
    }
    if (raw.binding !== undefined && !["JSONRPC", "HTTP+JSON"].includes(raw.binding)) {
      problems.push(`${at} has binding "${raw.binding}" — use "JSONRPC" or "HTTP+JSON", or leave it out (gRPC is not spoken)`);
    }
    if (raw.version !== undefined && !["1.0", "0.3"].includes(raw.version)) {
      problems.push(`${at} has version "${raw.version}" — use "1.0" or "0.3", or leave it out to read it from the card`);
    }
    problems.push(...authProblems(at, { url: raw.url, ...(raw.auth !== undefined ? { auth: raw.auth } : {}) }, url));
  } else if (raw.protocol === "acp") {
    if (typeof raw.command !== "string" || !raw.command) {
      return [`${at} needs command — the program that speaks ACP on stdio, e.g. command: "opencode", args: ["acp"]`];
    }
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string"))) {
      problems.push(`${at} has args that are not a list of strings`);
    }
    const policy = raw.permissions;
    if (policy !== undefined && policy !== "reject" && policy !== "allow") {
      const kinds = (policy as { allow?: unknown })?.allow;
      if (!Array.isArray(kinds)) {
        problems.push(`${at} has permissions ${JSON.stringify(policy)} — use "reject" (the default), "allow", or { allow: ["read", "search"] }`);
      } else {
        const unknown = kinds.filter((kind) => !ACP_TOOL_KINDS.includes(String(kind)));
        if (unknown.length) problems.push(`${at} allows ${list(unknown.map(String))}, which ${unknown.length === 1 ? "is not an ACP tool kind" : "are not ACP tool kinds"}. Kinds: ${ACP_TOOL_KINDS.join(", ")}`);
      }
    }
    if (raw.mcpServers !== undefined) {
      if (!Array.isArray(raw.mcpServers)) problems.push(`${at} has mcpServers that is not a list — name the runner's servers to hand over: mcpServers: ["fs"]`);
      else {
        const servers = spec.mcpServers ?? {};
        for (const key of raw.mcpServers) {
          const server = servers[key];
          if (!server) {
            const known = Object.keys(servers);
            problems.push(`${at} is handed MCP server "${key}", which the runner does not declare. ` + (known.length ? `Declared: ${list(known)}` : `No mcpServers are declared.`));
            continue;
          }
          if (typeof (server as { command?: unknown }).command === "string") continue;
          // Whether the agent takes url servers is only known at the handshake; auth that cannot travel is known now.
          const { why } = forwardServer(key, server, { http: true, sse: true });
          if (why) problems.push(`${at} cannot be handed MCP server "${key}": ${why}`);
        }
      }
    }
    if ("terminal" in fields) {
      problems.push(`${at} asks for a terminal — this client never offers one. The agent runs commands with its own tools, gated by permissions`);
    }
  } else {
    const servers = spec.mcpServers ?? {};
    if (typeof raw.server !== "string" || !raw.server) problems.push(`${at} needs server — a key of the runner's mcpServers`);
    else if (!servers[raw.server]) {
      const known = Object.keys(servers);
      problems.push(
        `${at} uses MCP server "${raw.server}", which the runner does not declare. ` +
          (known.length ? `Declared: ${list(known)}` : `No mcpServers are declared.`),
      );
    }
    if (typeof raw.tool !== "string" || !raw.tool) problems.push(`${at} needs tool — the name of the tool that IS the agent`);
  }
  return problems;
}

/** One declared server: is it something the client can reach, with auth it can use? */
function serverProblems(server: string, raw: McpServerSpec): string[] {
  const at = `MCP server "${server}"`;
  const hasCommand = typeof (raw as { command?: unknown }).command === "string";
  const hasUrl = typeof (raw as { url?: unknown }).url === "string";
  if (hasCommand && hasUrl) return [`${at} has both a command and a url — a local server is { command }, a hosted one { url }`];
  if (!hasCommand && !hasUrl) return [`${at} needs a command (a local process) or a url (a hosted server)`];
  if (hasCommand) return [];

  const spec = raw as RemoteServerSpec;
  const problems: string[] = [];
  let url: URL | undefined;
  try {
    url = new URL(spec.url);
  } catch {
    problems.push(`${at} has url "${spec.url}", which is not a url — e.g. https://mcp.example.com/mcp`);
  }
  if (url && !["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    problems.push(`${at} uses ${url.protocol}// — a remote server is http(s):// or ws(s)://`);
  }
  if (spec.transport !== undefined && !TRANSPORTS.includes(spec.transport)) {
    problems.push(`${at} has transport "${spec.transport}" — use one of ${list(TRANSPORTS)}, or leave it out for auto`);
  }
  const ws = url && /^wss?:$/.test(url.protocol);
  if (ws && spec.transport && spec.transport !== "websocket" && spec.transport !== "auto") {
    problems.push(`${at} is a ${url!.protocol}// url but says transport "${spec.transport}" — use transport: "websocket"`);
  }

  problems.push(...authProblems(at, spec, url));
  return problems;
}

/** Auth that can work — shared by remote MCP servers and A2A agents, which are asked who they are the same ways. */
function authProblems(at: string, spec: Pick<RemoteServerSpec, "url" | "auth">, url: URL | undefined): string[] {
  const problems: string[] = [];
  const auths = authList(spec as RemoteServerSpec);
  if (auths.filter((auth) => auth?.type === "oauth").length > 1) problems.push(`${at} lists oauth twice — combine it into one`);
  for (const auth of auths) {
    const mode = `${at} auth (${auth?.type})`;
    switch (auth?.type) {
      case "none":
      case "headers":
        break;
      case "bearer":
        if (!auth.token) problems.push(`${mode} needs token: "\${NAME}"`);
        break;
      case "api_key":
        if (auth.in !== "header" && auth.in !== "query") problems.push(`${mode} needs in: "header" or in: "query"`);
        if (!auth.name) problems.push(`${mode} needs name — the header or query parameter the key goes in`);
        if (!auth.value) problems.push(`${mode} needs value: "\${NAME}"`);
        break;
      case "basic":
        if (!auth.username || !auth.password) problems.push(`${mode} needs username and password: "\${NAME}"`);
        break;
      case "mtls":
        if (!auth.cert || !auth.key) problems.push(`${mode} needs cert and key — a PEM or a path to one`);
        if (url && !["https:", "wss:"].includes(url.protocol)) problems.push(`${mode} needs an https:// or wss:// url — a client certificate only rides on TLS`);
        break;
      case "custom":
        if (typeof auth.provider !== "function") problems.push(`${mode} needs provider: async ({ url, server, challenge, signal }) => headers`);
        break;
      case "oauth": {
        const grant = auth.grant ?? "authorization_code";
        if (!GRANTS.includes(grant)) problems.push(`${mode} has grant "${grant}" — use one of ${list(GRANTS)}`);
        if (auth.tokenEndpointAuth && !CLIENT_AUTH.includes(auth.tokenEndpointAuth)) {
          problems.push(`${mode} has tokenEndpointAuth "${auth.tokenEndpointAuth}" — use one of ${list(CLIENT_AUTH)}`);
        }
        if (auth.tokenEndpointAuth === "private_key_jwt" && !auth.privateKey) problems.push(`${mode} uses private_key_jwt, so it needs privateKey — a PEM or a path`);
        if ((auth.tokenEndpointAuth === "client_secret_basic" || auth.tokenEndpointAuth === "client_secret_post") && !auth.clientSecret) {
          problems.push(`${mode} uses ${auth.tokenEndpointAuth}, so it needs clientSecret: "\${NAME}"`);
        }
        if (grant === "client_credentials" && auth.clientId && !auth.clientSecret && !auth.privateKey) {
          problems.push(`${mode} uses client_credentials, so it needs clientSecret: "\${NAME}" or privateKey`);
        }
        if (grant === "refresh_token" && !auth.refreshToken) problems.push(`${mode} uses grant refresh_token, so it needs refreshToken: "\${NAME}"`);
        if (auth.scopes !== undefined && (!Array.isArray(auth.scopes) || auth.scopes.some((scope) => typeof scope !== "string"))) {
          problems.push(`${mode} has scopes that are not a list of strings`);
        }
        break;
      }
      default:
        problems.push(
          `${at} has auth type "${(auth as { type?: unknown })?.type}" — use none, headers, bearer, api_key, basic, oauth, mtls or custom`,
        );
    }
  }
  return problems;
}

/**
 * Things that work but should not be committed. Not problems — a runner with
 * a warning still runs — but each names its fix.
 */
export function warnings(spec: RunnerSpec): string[] {
  const found: string[] = [];
  for (const [server, raw] of Object.entries(spec.mcpServers ?? {})) {
    if (typeof (raw as { url?: unknown }).url !== "string") continue;
    const remote = raw as RemoteServerSpec;
    found.push(...literalSecrets(server, remote));
    let url: URL | undefined;
    try {
      url = new URL(remote.url);
    } catch {
      continue;
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const credentials = authList(remote).some((auth) => !["none", "headers"].includes(auth.type)) || Object.keys(remote.headers ?? {}).length > 0;
    if (!local && credentials && (url.protocol === "http:" || url.protocol === "ws:")) {
      found.push(`MCP server "${server}" sends credentials to ${safeUrl(url)} without TLS — use https:// or wss://`);
    }
  }
  for (const [agent, raw] of Object.entries(spec.agents ?? {})) {
    if (raw?.protocol === "acp") {
      // A key handed to a local agent belongs in the environment, by name.
      for (const [key, value] of Object.entries(raw.env ?? {})) {
        if (/token|secret|key|password/i.test(key) && typeof value === "string" && value && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)) {
          found.push(`agent "${agent}" has a literal secret in env["${key}"] — write it as "\${NAME}" and set NAME in the environment`);
        }
      }
      continue;
    }
    if (raw?.protocol !== "a2a" || typeof raw.url !== "string") continue;
    const remote: RemoteServerSpec = { url: raw.url, ...(raw.headers ? { headers: raw.headers } : {}), ...(raw.auth !== undefined ? { auth: raw.auth } : {}) };
    found.push(...literalSecrets(agent, remote, "agent"));
    let url: URL | undefined;
    try {
      url = new URL(remote.url);
    } catch {
      continue;
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const credentials = authList(remote).some((auth) => !["none", "headers"].includes(auth.type)) || Object.keys(remote.headers ?? {}).length > 0;
    if (!local && credentials && url.protocol === "http:") {
      found.push(`agent "${agent}" sends credentials to ${safeUrl(url)} without TLS — use https://`);
    }
  }
  return found;
}
