/**
 * THE ARTEFACT UNDER STUDY — the one file the loop may change.
 *
 * Parse one line of CSV into an array of fields.
 *
 * This starting point is deliberately terrible. It handles exactly one case:
 * fields with no quotes, no commas inside them, no escapes, no whitespace
 * rules. It is here to be replaced.
 */
export function parseLine(line) {
  return line.split(",");
}
