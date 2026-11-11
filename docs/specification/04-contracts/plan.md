# `/pd:plan <issue>` — the plan as the only handoff artefact

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:plan`

**Phase 0, a revision.** When `plan-review.md` holds `## Operator decisions
(round N)` that `pdkit plan revised` has not marked applied, `pdkit next` names
`/pd:plan <n>`, and the skill starts here instead of at phase 1: it applies the
accepted items to `plan.md` and the task files, scouts only for a fact a
decision needs, re-probes the commands it changed, and ends with
`pdkit plan revised <n>`. Nothing is pasted after the command.

**Phase 1, reconnaissance.** At least three `pd-scout` runs **in parallel**, on
different questions: where the logic is, which reusable patterns exist, how the
area's tests are built. The scout's response format is strict — ≤ 40 lines, every
claim carrying `file:line`. The host does not read files broadly itself.

**Phase 2, forks in the road.** Anything the scouts flagged as a choice goes to
the human. A question not asked becomes `[NEEDS DECISION]` in the plan, and that
blocks approval.

**Phase 3, the plan** by `templates/plan.md`. Nine requirements; a breach means
a rewrite:

1. Each task owns its files **exclusively**. Overlap is a planning error. A task
   that writes nothing — a whole-suite gate, a measurement — declares
   `Owns: (none — verification only, writes no files)`, which is read as no files
   at all; it is legitimate exactly while its `Done when` runs, the hook refuses
   every write it attempts, and every slice inherits what it satisfies.
2. `Done when` is an executable command with expected output. Prose is forbidden.
3. Interfaces between tasks are hoisted into `Frozen interfaces` as real signatures.
4. A task is 1–3 files.
5. Every context item cites `file:line` from the reconnaissance. An item saying
   something is absent from the codebase or an API has no line to cite, and
   cites the search instead: `searched: <query> in <where> -> 0`.
6. Every task declares `satisfies: [R1, R3]`. A requirement with no task and a
   task with no requirement are both errors.
7. `Upstream compliance` is filled in from `knowledge/upstream-rules.md`.
8. The order is written down: `- After: T4` on a task that cannot start
   before another is done, and the blocks in the order they should run.
   `pdkit task start` enforces `After`; `pdkit task list` shows the queue.
9. `Slice hypothesis` — a preliminary guess at the cut.

Then `pdkit plan probe <n>` runs every `Done when` on the base branch and
records what each printed, so the review sees which commands fail for want of
code and which can never pass.

Item 9 is the non-obvious one and it is critical. Plan without slicing in mind
and the diff comes out interleaved, and cutting it into atomic pull requests
afterwards is impossible without rewriting the work.

---

**In practice** — [`workflows/`](../../workflows/README.md):

- [§1 — A bug fix](../../workflows/01-bug-fix.md)

← [`/pd:triage`](triage.md) · [Contents](../README.md) · [`/pd:plan-review`](plan-review.md) →
