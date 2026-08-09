---
name: release-notes
description: House style for writing release notes. Use when summarising changes for users — covers ordering, tone, and what to leave out.
---

# Release notes house style

Order sections by what the reader acts on:

1. **Breaking** — anything requiring the reader to change their code. Lead with it.
2. **Added** — new capability, phrased as what the user can now do.
3. **Fixed** — only user-visible fixes. Internal refactors do not appear.

Rules:

- One line per item. No paragraphs.
- Write the effect, not the implementation: "scenes load 3× faster", not
  "replaced the parser".
- Never write "various improvements and bug fixes". If it can't be named, cut it.
- Version numbers as `v1.2.3`, always with the leading `v`.
