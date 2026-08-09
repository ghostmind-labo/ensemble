/**
 * The shared blackboard passed between nodes, plus the extraction layer that
 * turns free-form model output into typed state.
 *
 * Why parsing and not structured output: @opencode-ai/sdk 1.18.15's prompt body
 * has no `format` field (verified in dist/gen/types.gen.d.ts), so JSON-schema
 * enforcement is unavailable. We ask for a trailing ```json fence, parse it, and
 * reprompt once with the parser error if it does not arrive.
 */

export type State = Record<string, unknown>;

export interface Extraction {
  ok: boolean;
  values: State;
  /** Human-readable reason, fed back to the model on the retry attempt. */
  problem?: string;
}

/**
 * Pulls the LAST fenced json block. Last, not first, because models often
 * illustrate the shape mid-answer before emitting the real payload.
 */
export function extractJsonBlock(text: string): { raw: string; parsed: unknown } | undefined {
  const fences = [...text.matchAll(/```(?:json|jsonc)?\s*\n([\s\S]*?)```/g)];

  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i]?.[1];
    if (!body) continue;
    try {
      return { raw: body, parsed: JSON.parse(body) as unknown };
    } catch {
      continue; // Try the next-most-recent fence.
    }
  }

  // No usable fence: accept a bare object if the whole reply is one.
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      return { raw: trimmed, parsed: JSON.parse(trimmed) as unknown };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Harvests the keys a node declared in `outputs`.
 *
 * A node with no declared outputs is a side-effect node (it did work, wrote
 * files, whatever) — its prose is still recorded, but nothing is required.
 */
export function extractOutputs(text: string, outputs: string[]): Extraction {
  if (outputs.length === 0) return { ok: true, values: {} };

  const block = extractJsonBlock(text);
  if (!block) {
    return {
      ok: false,
      values: {},
      problem:
        `no JSON block found. End your reply with a fenced json block containing ` +
        `exactly these keys: ${outputs.join(", ")}.`,
    };
  }

  if (typeof block.parsed !== "object" || block.parsed === null || Array.isArray(block.parsed)) {
    return {
      ok: false,
      values: {},
      problem: `the JSON block must be an object with keys: ${outputs.join(", ")}.`,
    };
  }

  const parsed = block.parsed as State;
  const values: State = {};
  const missing: string[] = [];

  for (const key of outputs) {
    if (key in parsed) values[key] = parsed[key];
    else missing.push(key);
  }

  if (missing.length > 0) {
    return {
      ok: false,
      values,
      problem: `the JSON block is missing required key(s): ${missing.join(", ")}.`,
    };
  }

  return { ok: true, values };
}

/**
 * Renders the slice of state a node asked for as context.
 * Strings pass through verbatim so prose stays readable; everything else is JSON.
 */
export function renderInputs(state: State, inputs: string[]): string {
  if (inputs.length === 0) return "";

  const sections: string[] = [];
  for (const key of inputs) {
    const value = state[key];
    if (value === undefined) continue;
    const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    sections.push(`### ${key}\n${body}`);
  }

  if (sections.length === 0) return "";
  return `## Context from earlier nodes\n\n${sections.join("\n\n")}`;
}

/**
 * The instruction block appended to any node that declares outputs.
 *
 * The emphasis on self-contained values is not decoration. Downstream nodes see
 * ONLY the JSON — never the prose above it. Models naturally write their real
 * answer as prose and then put a *summary* in the JSON, at which point the good
 * content is silently discarded. Observed in the wild: a node argued its case over
 * several paragraphs and emitted `{"answer": "Yes"}`.
 */
export function outputContract(outputs: string[]): string {
  return [
    "## Required output",
    "",
    "End your reply with a fenced json block — no prose after it — with exactly these keys:",
    "",
    "```json",
    `{${outputs.map((key) => `\n  ${JSON.stringify(key)}: ...`).join(",")}\n}`,
    "```",
    "",
    "**Each value must be complete and self-contained.** Later steps read only this",
    "json block — any prose you write above it is discarded and will never be seen.",
    "Put the full content in the value, not a summary or a one-word verdict. If your",
    "answer is three paragraphs, the value is those three paragraphs.",
  ].join("\n");
}

/**
 * Detects a node that wrote its real answer as prose and put a summary in the JSON.
 *
 * A node that argues for 2000 characters and returns `{"answer": "Yes"}` has
 * satisfied the contract while losing everything that mattered — the run succeeds
 * and the next node quietly receives less than it should.
 *
 * Measured on the TOTAL of all extracted values, never per key. Judging keys
 * individually produces false positives on two perfectly correct shapes: enum
 * fields (`"strongest": "google"` is meant to be one word) and multi-output nodes
 * (four keys each legitimately hold a quarter of the reply).
 */
export function detectLossyExtraction(
  text: string,
  values: State,
  outputs: string[],
): { extractedLength: number; replyLength: number } | undefined {
  const reply = text.trim();
  // Below this, a short answer is plausibly just a short answer.
  if (reply.length < 400) return undefined;

  let extracted = 0;
  for (const key of outputs) {
    const value = values[key];
    extracted += typeof value === "string" ? value.length : JSON.stringify(value ?? "").length;
  }

  if (extracted >= reply.length * 0.25) return undefined;
  return { extractedLength: extracted, replyLength: reply.length };
}
