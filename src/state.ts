/**
 * The shared blackboard passed between nodes, plus the extraction layer that
 * turns free-form model output into typed state.
 *
 * Why parsing and not structured output: a text contract is the portable floor.
 * OpenRouter does support `response_format`, but not every model behind it does,
 * and an agent-backend node is a CLI subprocess whose output we do not control
 * at all — so the one thing that works everywhere is asking for a trailing
 * ```json fence, parsing it, and reprompting once with the parser error if it
 * does not arrive. (The original reason was narrower: the SDK we used to drive
 * had no `format` field. That SDK is gone; the conclusion outlived it, and
 * renting agents again makes the portable floor matter more, not less.)
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
export function extractOutputs(
  text: string,
  outputs: string[],
  schema?: Record<string, unknown>,
): Extraction {
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

  // Shape enforcement — shared with fn nodes, so computed values face exactly
  // the same contract as model output.
  const shaped = applySchemas(values, outputs, schema);
  if (!shaped.ok) {
    return {
      ok: false,
      values,
      problem: `${shaped.problem}. Re-emit the json block with the shapes as specified.`,
    };
  }
  return { ok: true, values };
}

/**
 * Validates (and, via zod parsing, coerces) values in place against the scene's
 * state schemas. A key with no schema passes through untouched, so schemas stay
 * additive. Shared by text extraction and fn-node computation: where a value
 * came from must not change what shapes are acceptable.
 */
export function applySchemas(
  values: State,
  outputs: string[],
  schema?: Record<string, unknown>,
): { ok: true } | { ok: false; problem: string } {
  if (!schema) return { ok: true };
  const problems: string[] = [];
  for (const key of outputs) {
    const keySchema = schema[key] as { safeParse?: (v: unknown) => unknown } | undefined;
    if (typeof keySchema?.safeParse !== "function") continue;

    const result = keySchema.safeParse(values[key]) as {
      success: boolean;
      data?: unknown;
      error?: { issues?: Array<{ path: Array<string | number>; message: string }> };
    };
    if (result.success) {
      values[key] = result.data;
      continue;
    }
    // Name the exact path so the failure is actionable, not "invalid input".
    for (const issue of result.error?.issues ?? []) {
      const where = [key, ...(issue.path ?? [])].join(".");
      problems.push(`${where}: ${issue.message}`);
    }
  }
  return problems.length > 0
    ? { ok: false, problem: `these values do not match the required shape — ${problems.join("; ")}` }
    : { ok: true };
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
/**
 * A compact, human-readable shape for a zod schema — what the model is shown.
 *
 * Deliberately prose-ish rather than JSON Schema: it goes into a prompt, where
 * `array of { file: string, severity: "low" | "high" }` earns its tokens far
 * better than a nested JSON Schema object. Walks zod's `_def`, and falls back to
 * a bare "value" for anything exotic rather than throwing — a describable
 * schema is a nicety, validation is the real contract.
 */
export function describeSchema(schema: unknown, depth = 0): string {
  const def = (schema as { _def?: Record<string, unknown> })?._def;
  if (!def || depth > 4) return "value";
  const described = (schema as { description?: string }).description;

  const shape = ((): string => {
    switch (def["typeName"]) {
      case "ZodString":
        return "string";
      case "ZodBoolean":
        return "boolean";
      case "ZodNumber": {
        const checks = (def["checks"] as Array<{ kind: string; value: number }> | undefined) ?? [];
        const min = checks.find((c) => c.kind === "min")?.value;
        const max = checks.find((c) => c.kind === "max")?.value;
        const range = min !== undefined && max !== undefined ? ` (${min}-${max})` : "";
        return `number${range}`;
      }
      case "ZodEnum":
        return ((def["values"] as string[]) ?? []).map((v) => JSON.stringify(v)).join(" | ");
      case "ZodLiteral":
        return JSON.stringify(def["value"]);
      case "ZodArray":
        return `array of ${describeSchema(def["type"], depth + 1)}`;
      case "ZodObject": {
        const shapeFn = def["shape"] as (() => Record<string, unknown>) | undefined;
        const entries = Object.entries(shapeFn?.() ?? {});
        if (entries.length === 0) return "object";
        return `{ ${entries.map(([k, v]) => `${k}: ${describeSchema(v, depth + 1)}`).join(", ")} }`;
      }
      case "ZodOptional":
      case "ZodNullable":
        return `${describeSchema(def["innerType"], depth + 1)} (optional)`;
      case "ZodUnion":
        return ((def["options"] as unknown[]) ?? []).map((o) => describeSchema(o, depth + 1)).join(" | ");
      case "ZodRecord":
        return `object mapping string to ${describeSchema(def["valueType"], depth + 1)}`;
      case "ZodEffects":
        // .refine()/.transform() wrap the real schema; describe what is inside —
        // the refinement's message still enforces the logic at validation time.
        return describeSchema(def["schema"], depth + 1);
      case "ZodDefault":
        return describeSchema(def["innerType"], depth + 1);
      default:
        return "value";
    }
  })();

  return described ? `${shape} — ${described}` : shape;
}

export function outputContract(outputs: string[], schema?: Record<string, unknown>): string {
  const shapeFor = (key: string): string =>
    schema?.[key] !== undefined ? describeSchema(schema[key]) : "...";

  return [
    "## Required output",
    "",
    "End your reply with a fenced json block — no prose after it — with exactly these keys:",
    "",
    "```json",
    `{${outputs.map((key) => `\n  ${JSON.stringify(key)}: ${shapeFor(key)}`).join(",")}\n}`,
    "```",
    "",
    ...(outputs.some((k) => schema?.[k] !== undefined)
      ? [
          "The shapes above are REQUIRED, not suggestions — a value of the wrong shape is",
          "rejected and you will be asked again. Emit real values, not the type names.",
          "",
        ]
      : []),
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
