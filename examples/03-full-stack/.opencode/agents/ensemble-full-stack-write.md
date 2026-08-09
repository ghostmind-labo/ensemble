---
description: Graph node "write" from scene "full-stack"
mode: subagent
hidden: true
model: openrouter/anthropic/claude-haiku-4.5
tools:
  write: false
  edit: false
  patch: false
permission:
  skill:
    "*": deny
    release-notes: allow
  tools:
    fs*: deny
---

Turn the findings into user-facing release notes.
Follow the release-notes skill's house style exactly.
