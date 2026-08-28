// THE ARTEFACT UNDER STUDY — the only file the agent may edit.
//
// Return true if the message is spam. Keep it a pure function: no I/O, no
// network, no randomness. measure.mjs scores it; results.tsv records every try.
export function isSpam(message) {
  const m = message.toLowerCase();
  return m.includes("free") || m.includes("$$$");
}
