# PLAN: DESKTOP-{{issue}}

- Requirements: {{requirementIds}} (frozen on approval)
- e2e coverage: {{e2eCoverage}}   <!-- required | optional | no — with justification -->
- Slice hypothesis: {{sliceCount}} slices

## Context
<!-- Every point cites file:line from reconnaissance. A context line without a
     location was not verified. -->
{{context}}

## Frozen interfaces
<!-- Real signatures shared between tasks. Written here once so two tasks
     cannot each invent their own version of the same boundary. -->
```ts
{{interfaces}}
```

## Tasks

### T1: {{taskTitle}}
- Satisfies: {{satisfies}}
- Owns: {{ownedFiles}}
  <!-- Exclusive. Two tasks sharing a file is a planning error, not a
       coordination problem. Enforced by the pre-write hook. -->
- Done when: `{{command}}`
  <!-- An executable command and its expected output. Prose is not accepted:
       "works correctly" cannot be checked by anyone but its author. -->
- Steps:
  1. {{step}}

## Upstream compliance
- SPDX headers needed: {{spdx}}
- Schemas touched: {{schemas}}
- `extension-api.d.ts` touched: {{extensionApi}}
- Commit scope: {{scope}}

## Slice hypothesis
<!-- Not the final graph — /pd:slice produces that from the real diff. But
     tasks are ordered so that cutting is possible later. Planning without
     this produces an interleaved diff that cannot be split without redoing
     the work. -->
{{sliceHypothesis}}

## Open decisions
<!-- [NEEDS DECISION] here blocks approval. An unasked question does not
     disappear; it becomes an assumption nobody agreed to. -->
{{decisions}}
