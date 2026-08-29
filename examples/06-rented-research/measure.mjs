/**
 * THE SCORER — code, not a model. Lives outside the artefact on purpose.
 *
 * Runs `parseLine` against RFC-4180 cases the artefact cannot see, and prints
 * the percentage passing. Deterministic: the same artefact always scores the
 * same, which is the property that makes iteration 1 comparable to iteration 20.
 */
import { parseLine } from "./parser.mjs";

// Held out from the artefact. If it could read these, it would memorise them.
const CASES = [
  // the easy ones the naive split already gets
  { in: `a,b,c`,                    out: ["a", "b", "c"] },
  { in: `one`,                      out: ["one"] },
  { in: `1,2,3,4,5`,                out: ["1", "2", "3", "4", "5"] },
  { in: ``,                         out: [""] },

  // quoted fields
  { in: `"a","b"`,                  out: ["a", "b"] },
  { in: `"hello world",x`,          out: ["hello world", "x"] },
  { in: `x,"y"`,                    out: ["x", "y"] },

  // the whole point of quoting: a comma inside a field
  { in: `"Smith, John",42`,         out: ["Smith, John", "42"] },
  { in: `a,"b,c",d`,                out: ["a", "b,c", "d"] },
  { in: `"a,b","c,d"`,              out: ["a,b", "c,d"] },

  // escaped quotes — a doubled "" inside a quoted field is one literal quote
  { in: `"she said ""hi"""`,        out: [`she said "hi"`] },
  { in: `"""quoted"""`,             out: [`"quoted"`] },
  { in: `a,"say ""what""",b`,       out: ["a", `say "what"`, "b"] },

  // empty fields, quoted and bare
  { in: `a,,b`,                     out: ["a", "", "b"] },
  { in: `,`,                        out: ["", ""] },
  { in: `"",""`,                    out: ["", ""] },
  { in: `a,"",b`,                   out: ["a", "", "b"] },

  // trailing and leading separators
  { in: `a,b,`,                     out: ["a", "b", ""] },
  { in: `,a,b`,                     out: ["", "a", "b"] },

  // whitespace is significant outside quotes
  { in: `a , b`,                    out: ["a ", " b"] },
  { in: `" spaced "`,               out: [" spaced "] },
];

let passed = 0;
const failures = [];
for (const { in: input, out: expected } of CASES) {
  let actual;
  try {
    actual = parseLine(input);
  } catch (err) {
    failures.push(`${JSON.stringify(input)} threw ${err.message}`);
    continue;
  }
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else failures.push(`${JSON.stringify(input)} → ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// A few failures, so the proposer learns something from a revert.
for (const f of failures.slice(0, 5)) console.log(`fail: ${f}`);
console.log(`${passed}/${CASES.length} cases pass`);

// The line the loop scrapes. Printed last, on purpose.
console.log(`score: ${((passed / CASES.length) * 100).toFixed(1)}`);
