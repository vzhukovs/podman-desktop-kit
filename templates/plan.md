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
<!-- One block per task, in exactly this shape — `pdkit plan check` reads them
     back, so it is a contract and not a suggestion:

       ### T1: <title>
       - Satisfies: R1, R3
       - Owns: packages/main/src/plugin/exec.ts
       - Done when: `pnpm test:main -- exec.spec.ts`
       - Steps:
         1. <step>

     Owns is exclusive: two tasks sharing a file is a planning error, not a
     coordination problem, and the pre-write hook enforces it. Done when is an
     executable command, because "works correctly" cannot be checked by anyone
     except its author. One to three files per task.

     A task that writes nothing — a whole-suite gate, a measurement — says so:

       - Owns: (none — verification only, writes no files)

     That is read as no files at all, and it means what it says in both
     directions: the hook refuses every write such a task attempts, and every
     slice carries the requirements it satisfies, because a check over the whole
     tree is a claim every pull request cut from the change has to hold. -->
{{tasks}}

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
