---
name: plan
description: "Plan an issue: scout the code, resolve the open choices, and produce a plan with executable done-criteria."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: opus
---

The plan is the only artefact that carries intent to the implementer. Three
phases, in order.

## Phase 1 — reconnaissance

At least three `pd-scout` agents **in parallel**, each with a different
question: where the logic lives, which existing pattern the fix should follow,
how this area is tested.

Their format is fixed: ≤ 40 lines, every claim with `file:line`, no
recommendations. A scout that proposes a solution has exceeded its brief, and
its proposal has not been checked against the other two.

Do not read the code broadly yourself. Scouts exist so you read 40 lines
instead of 4000; reading both is the failure mode this structure was built
against.

Write the compressed map to `research.md`.

## Phase 2 — the choices

Anything a scout flagged as a decision goes to the user through
AskUserQuestion, with the options and what each costs.

A question you do not ask becomes `[NEEDS DECISION]` in the plan, and that
blocks approval. This is deliberate: an unasked question does not disappear,
it becomes an assumption nobody agreed to and nobody can find later.

## Phase 3 — the plan

Fill `templates/plan.md`. Every one of these is a requirement, and a plan that
misses one gets redone rather than patched:

1. **Every task owns its files exclusively.** Two tasks sharing a file is a
   planning error, not a coordination problem.
2. **`Done when` is a command and its expected output.** Prose is refused:
   "works correctly" cannot be checked by anyone except its author.
3. **Interfaces between tasks are frozen, with real signatures**, so two tasks
   cannot each invent their own version of the same boundary.
4. **One to three files per task.**
5. **Every context line cites `file:line`** from phase 1. A context line
   without a location was not verified.
6. **Every task declares `satisfies: [R…]`.** A requirement with no task and a
   task with no requirement are both errors.
7. **`Upstream compliance` is filled in** from `knowledge/upstream-rules.md`:
   SPDX on new files, schemas touched, `extension-api.d.ts` touched, commit
   scope.
8. **`e2e coverage:` is decided here** — `required`, `optional` or `no` with a
   reason. Deciding afterwards produces a test for what was built rather than
   for what was required.
9. **`Slice hypothesis` is written.** Not the final graph, but tasks are
   ordered so cutting is possible later. Planning without it produces an
   interleaved diff that cannot be split without redoing the work.

## Then

`pdkit render plan --issue <n> --values <f> --path plan.md`, one
`pdkit render task --issue <n> --values <f> --path tasks/T<k>.md` per task, then
`pdkit task sync --issue <n>` so the ownership map the pre-write hook enforces
comes from the task files rather than from anyone's memory of them.

`pdkit plan check <n>` before showing the plan to anybody: everything it finds
is something `/pd:plan-review` would find anyway, and finding it here costs one
command instead of a review round.

Then `pdkit state <n> --to planned`.

Approval is a human action. On approval — and only then — `pdkit ids freeze
<n>` and `pdkit state <n> --to plan-approved`. The freeze is what makes R-IDs
a trace rather than a numbering: after it, they cannot be renumbered under a
PR that already cites them.

## Next

`/pd:plan-review <issue>` — before approval, not after. On approval, and only
then, freeze and move to `plan-approved`; what runs from there is
`/pd:exec <issue>`.
