---
name: ensemble-questions
description: Write and tune the questions that Jev, TypeSafe's System One classifier, answers inside an ensemble runner. Covers when to use choice, score or noul, how to write options with what and not_for, how to split a fuzzy judgement into narrow questions, what to put in reads, where confidence gates and thresholds go, and how to avoid Jev's documented weak spots (arithmetic, dates, literal reading, noisy state). Use this whenever you write or edit a choice(), score() or noul() call or a decide node, when a runner routes wrongly or is unsure too often, when setting a gate min or an on threshold, or when someone asks to classify, triage, grade, screen or detect something with Jev, TypeSafe or System One.
---

# Designing questions for Jev

A decide node is only as good as its questions. Jev is a classifier, not a
chatbot. It reads the state you send, reads your criteria **literally**, and
returns a calibrated distribution over the answers you declared. Most routing
bugs are question bugs: two options with no clear boundary, one question secretly
asking two things, or state full of noise.

Before relying on anything here, check whether TypeSafe has published a newer
jaggedness page than 1.13: https://docs.typesafe.ai/llms.txt lists every page,
and the current weaknesses are at `/model-jaggedness/jev-<version>`. This skill
reflects jev-1.13.

## Pick the shape

| You want | Use | Lands on state as | Branch with |
|---|---|---|---|
| One of a fixed set of routes, labels or categories | `choice` (2–255 options) | option name | `on: "k=opt"`, plus a `gate` on confidence |
| Is X true? | `noul` | P(yes), 0–1 | `on: "k"`, `"!k"`, `"k>=0.8"` |
| How much, how good, how severe, on a rubric | `score` (2–10 levels) | fractional level, 0-based | `when: (s) => Number(s.k) >= 1.5` |

Rules of thumb:

- A yes/no question disguised as a two-option choice (`{ yes, no }`) should be a
  `noul`. The probability is more useful than a label, and you can threshold it.
- An ordered scale disguised as a choice (`{ low, medium, high }`) should be a
  `score`. You get a continuous value and can set the cut-off in code.
- A `choice` must be closed and known when the code is written. Never enumerate
  something that changes at run time, like a model catalogue, a user list or
  search results. Ask a stable question and resolve the volatile part in code.

## Write one property per question

Jev loses accuracy on multi-hop questions. If a question contains "and", "or",
"if…then", or needs two facts combined, split it. Questions in one node are sent
together and answered **independently**, so five narrow ones cost one round trip.
Combine them afterwards with ordered edges or a `code` node.

```ts
// ✗ one fuzzy judgement
bad: noul("Is this email a phishing attempt?")

// ✓ atomic properties; code combines them
asks_credentials: noul("Does the message ask the reader to enter or reveal a password, code, or card number?"),
sender_mismatch:  noul("Does the display name claim an organisation that the sending address does not belong to?"),
urgency_pressure: noul("Does the message threaten a consequence unless the reader acts quickly?"),
```

Speculative extra questions are almost free. When a later branch *might* need a
fact, ask for it now and let code decide whether it mattered.

## Write the options: `what` and `not_for`

Jev reads criteria literally and compares options side by side. State the
boundary; don't leave it implied.

```ts
team: choice("Which team should handle this request?", {
  billing: { what: "Charges, invoices, refunds, payment methods",
             not_for: "Where a parcel is or when it arrives (orders)" },
  orders:  { what: "Delivery status, cancellation, returns of goods",
             not_for: "Money owed or refunded (billing)" },
  account: { what: "Login, password, profile, deleting the account",
             not_for: "Anything about a specific order (orders)" },
}),
```

- `not_for` names what belongs in the **neighbouring** option, and which one. It
  is the field that earns its keep.
- `examples: [...]` help at a fuzzy boundary. Pick examples that sit near the
  line, not obvious ones.
- Keep option names identifier-like (`needs_human`, not `"Needs a human"`). They
  become branch labels in `graph.json`.
- Add an escape option (`none`, `other`, `unclear`) whenever reality can fall
  outside the list. A choice with no way out has to pick something, and it will
  pick wrong with confidence. Wire that option to a safe exit.

For a **score**, write each level as an observable description, ordered low to
high, and keep adjacent levels mutually exclusive:

```ts
severity: score("How badly is the customer affected?", [
  { what: "Cosmetic or curious; nothing is blocked" },
  { what: "Something is degraded but there is a workaround" },
  { what: "Blocked with no workaround, one person" },
  { what: "Blocked with no workaround, many people or money is being lost" },
]),
```

For a **noul**, add `{ true, false }` criteria when "yes" has a specific meaning
that a literal reader could miss.

## Instructions: the structured form

A string works. The object form separates guidance that would otherwise run
together:

```ts
choice({
  question: "Which team should handle this request?",
  focus: "Route on what the customer needs done, not on the product they mention.",
  inspect: "`goal`",
}, { … })
```

`inspect` and `compare` point at state keys with backticks. Point Jev at the
exact key, because indirection costs accuracy.

## `reads`: send less

`reads` on a decide node is a **hard filter**. Only those keys go to Jev, and
accuracy falls as irrelevant detail grows.

- Send the key the question is about, and nothing that merely might be relevant.
- Never send image keys (validation refuses them). Send the sentence a model
  node wrote about the image instead.
- If a key is large (a whole document), add a `code` or `model` node first that
  extracts the part the question needs, and read that instead.
- **When the text comes from a model's description of an image**, the
  describer's limits become Jev's. Vision models may refuse, or tone down, a
  description of nudity, gore or weapons. So for moderation, tell the describer
  to report those plainly and factually, ask it for an explicit
  "nothing of that kind visible" line, and treat a refusal or an empty
  description as a reason for review, never as a pass. Instructions written
  *inside* an image reach Jev through the description too, so tell the describer
  to quote on-image text rather than act on it, and ask a noul about whether the
  image contains text addressed to a reviewer or system.
- Unvetted user text can contain instructions aimed at the classifier. Jev does
  not treat state as hostile. Put a screening noul before any routing that
  matters, and write criteria that describe content, not obedience.

## Keep numbers, dates and counts out of questions

Jev is documented as unreliable at arithmetic, counting and date ordering. Any
question with a number in its answer ("is the total over $500?", "is this the
third attempt?", "was it before the deadline?") belongs in code:

- Extract the number or date: from structured input, or with a `model` node
  that writes it.
- Compare in a `code` node or a `when:` edge.

Likewise, don't ask one fact two ways and derive one threshold from the other.
`P(x)` and `1 − P(not x)` need not agree. Ask each decision once.

## Gates and thresholds

- **`gate: { on, min, to }`** applies to a `choice` or a `score`. Below `min`
  confidence the run diverts to `to`, which should be the safe path: a person, a
  hold, a more careful handler. Start around `0.7` for routes with real
  consequences, `0.45–0.6` for big choices where "roughly right" is fine (skill
  selection), and higher (`0.8+`) where acting wrongly is expensive.
- **noul thresholds** go in the edge (`"hazard>=0.3"`). Set them from the cost
  of each kind of error, not at 0.5 by reflex. A missed hazard costs more than a
  false alarm, so its threshold goes low.
- **score cut-offs** go in `when:`. A score is an expected value, so `1.4` on a
  0–2 rubric means "leaning good". Compare scores from rubrics of different
  lengths only after dividing by `levels − 1`.
- Starting values are guesses. Calibrate them on real runs: plot confidence
  against being right, then move each cut-off to where errors become
  unacceptable. The `ensemble-runs` skill covers reading answers out of
  `run.json`.

## Check your questions before you ship

For each question, answer these:

1. Does it ask exactly one property?
2. Could a literal reader put a borderline input in two options? If so, sharpen
   `not_for` or add a boundary example.
3. Is there an honest way out (`none`, `other`, or a gate)?
4. Is anything numeric, date-based or counted? Move it to code.
5. Does `reads` hold only what this question needs?
6. Would the answer mean the same thing a year from now? If not, the options are
   too volatile for a choice.

Then prove the wiring for $0 with the dry-run described in the `ensemble-build`
skill (`--explore` exercises every declared answer).
