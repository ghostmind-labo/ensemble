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
  isCode,
  isDecide,
  isMcp,
  isModel,
  isWork,
  parseBranch,
  probeReads,
  producers,
  readsOf,
  type Branch,
  type Edge,
  type RunnerSpec,
} from "./spec.ts";
import { optionsOf } from "./questions.ts";

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
    ].filter(Boolean);
    if (kinds.length !== 1) {
      problems.push(
        kinds.length === 0
          ? `node "${name}" is none of decide / work / code / model / mcp — a node must be exactly one`
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

  /* ── reachability ── */
  if (spec.entry && names.has(spec.entry)) {
    const reached = new Set([spec.entry]);
    const queue = [spec.entry];
    while (queue.length) {
      const at = queue.shift()!;
      const node = spec.nodes[at];
      const next = edges.filter((edge) => edge.from === at).map((edge) => edge.to);
      if (node && isDecide(node) && node.gate) next.push(node.gate.to);
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
