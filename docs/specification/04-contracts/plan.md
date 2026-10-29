# `/pd:plan <issue>` — the plan as the only handoff artefact

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:plan`

**Phase 1, reconnaissance.** At least three `pd-scout` runs **in parallel**, on
different questions: where the logic is, which reusable patterns exist, how the
area's tests are built. The scout's response format is strict — ≤ 40 lines, every
claim carrying `file:line`. The host does not read files broadly itself.

**Phase 2, forks in the road.** Anything the scouts flagged as a choice goes to
the human. A question not asked becomes `[NEEDS DECISION]` in the plan, and that
blocks approval.

**Phase 3, the plan** by `templates/plan.md`. Eight requirements; a breach means
a rewrite:

1. Each task owns its files **exclusively**. Overlap is a planning error. A task
   that writes nothing — a whole-suite gate, a measurement — declares
   `Owns: (none — verification only, writes no files)`, which is read as no files
   at all; it is legitimate exactly while its `Done when` runs, the hook refuses
   every write it attempts, and every slice inherits what it satisfies.
2. `Done when` is an executable command with expected output. Prose is forbidden.
3. Interfaces between tasks are hoisted into `Frozen interfaces` as real signatures.
4. A task is 1–3 files.
5. Every context item cites `file:line` from the reconnaissance.
6. Every task declares `satisfies: [R1, R3]`. A requirement with no task and a
   task with no requirement are both errors.
7. `Upstream compliance` is filled in from `knowledge/upstream-rules.md`.
8. `Slice hypothesis` — a preliminary guess at the cut.

Item 8 is the non-obvious one and it is critical. Plan without slicing in mind
and the diff comes out interleaved, and cutting it into atomic pull requests
afterwards is impossible without rewriting the work.

---

**In practice** — [`workflows/`](../../workflows/README.md):

- [§1 — A bug fix](../../workflows/01-bug-fix.md)

← [`/pd:triage`](triage.md) · [Contents](../README.md) · [`/pd:plan-review`](plan-review.md) →
