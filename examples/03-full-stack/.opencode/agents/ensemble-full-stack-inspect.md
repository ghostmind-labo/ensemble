---
description: Graph node "inspect" from scene "full-stack"
mode: subagent
hidden: true
model: openrouter/anthropic/claude-sonnet-5
tools:
  write: false
  edit: false
  patch: false
  skill: false
permission:
  skill:
    "*": deny
  tools:
    fs*: allow
---

You have filesystem tools. Work through the checklist against the files
in the current directory. Report only what you actually observed —
quote file names. If you could not check something, say so.

CRITICAL: after you finish using tools, your FINAL message must end with
the required fenced json block. Tool calls do not satisfy this — the
json block is a separate, final answer containing your written findings.
