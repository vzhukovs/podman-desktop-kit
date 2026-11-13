---
name: plan
description: "Plan an issue: scout the code, resolve the open choices, and produce a plan with executable done-criteria."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: opus
effort: high
---

The plan is the only artefact that carries intent to the implementer. Three
phases, in order — unless a review is waiting to be applied, which is phase 0
and replaces them.

## Phase 0 — a revision, when the review has been decided

`pdkit next <n>` says it: from `planned`, when `plan-review.md` has a
`## Operator decisions (round N)` section that `pdkit plan revised` has not
marked applied, the next step is this skill again, not another review. The
decisions are read from that file. Nothing has to be pasted after the command,
and anything pasted is read as one more decision, not a substitute for them.

What a revision is:

1. Read `plan-review.md` — the findings, its `## Notes for exec` and the
   latest `## Operator decisions` section — then `plan.md`, `tasks/` and
   `research.md`. Earlier rounds are in `plan-review.r<k>.md`; their decisions
   stand and are not reopened.
2. Apply what was accepted, item by item, and nothing else. A rejected item is
   left alone; an item with no decision is left alone and named at the end. A
   decision that needs a code fact `research.md` does not hold gets one
   `pd-scout` for that fact, not a new reconnaissance.
3. Append each line of `## Notes for exec` to `## Notes` in the task file of
   the task it names, as the critic wrote it. No decision is asked for and
   none is recorded: a note is what the implementer would learn from its own
   files or the first run of its `Done when`, and Notes is not a part
   execution reads, so it does not send the plan to another round. A note
   naming a task the plan no longer has is left out and named at the end.
4. Edit `plan.md` and the task files in place. A task's header and its
   `Intent:` are in `plan.md`; its Context, Steps and Notes are in its task
   file, and a decision about them is applied there. A plan written before
   that split also has Steps, and often Context, in `plan.md`: change both
   copies. Task IDs never change; a task the revision drops is deleted from
   both files before approval, which is the only time that is allowed. Then
   `pdkit task sync --issue <n>` and `pdkit plan check <n>`. The review
   already copied the plan it read into `reviews/r<k>/`, and the next review
   compares with it: leave `reviews/` alone.
5. `pdkit plan probe <n> --task <every task whose Done when changed>`, from
   the main checkout. Before step 6, whatever step 6 then prints.
6. `pdkit plan revised <n>`, which records that the round is in the plan and
   prints the step after it, `next:`, with the reason, `why:`. Follow that
   line, not this one. It is `/pd:plan-review <n>`, in a new session, when an
   A item was accepted or left with no decision, when the revision changed a
   task's Owns, After, Done when, Satisfies or Slice, the set of tasks, Frozen
   interfaces or the slice hypothesis, or when there is no snapshot to compare
   with. Otherwise it is the approval — `pdkit ids freeze <n> && pdkit state
   <n> --to plan-approved` — and that is the person's to run: put the line and
   its `why:` in front of them, and do not run it. They can still ask for a
   round.

Say to the person, at the end, which items were applied, where, and which
were left for lack of a decision; and how many notes went to which tasks.

## Phase 1 — reconnaissance

First, what is already known, so the scouts do not find it again.

**Earlier attempts.** An issue that was reset or rolled back has its earlier
reviews archived, and nothing else reads them:

```
pdkit plan lessons <n>
```

It prints every archived round's A and B items with the decision lines
recorded on them, or that there is no archive. Write what was decided to
`research.md` under `## From earlier attempts`, one line per item: an accepted
item as what it established about the repository, with its `file:line`; a
rejected one with the reason given. An item with no decision line is left out,
and the section says how many were. A review printed as the same text as
another archive's is read there.

**The traps.** `${CLAUDE_PLUGIN_ROOT}/knowledge/pitfalls.md` holds traps this
repository has set before, each with where it lives.

Then at least three `pd-scout` agents **in parallel**, each with a different
question: where the logic lives, which existing pattern the fix should follow,
how this area is tested. Each scout's prompt carries, with its question, the
`pitfalls.md` entries that bear on the region it maps (the whole file, while
it stays near 300 lines and the region is unclear) and the lines of
`## From earlier attempts` that touch it. A scout handed an entry checks it
against the code it reads and cites the current `file:line`; one the code no
longer bears out is a finding, not a premise.

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

Fill `${CLAUDE_PLUGIN_ROOT}/templates/plan.md`, and one `${CLAUDE_PLUGIN_ROOT}/templates/task.md` per task.

**The plan is the index, the contracts and the slices.** In `plan.md` a task
is its header — Satisfies, Owns, Done when, After, Slice — and one `Intent:`
sentence. Its Context, Steps and Notes are written in `tasks/T<k>.md` and
nowhere else: written twice, every revision edits two places and every review
compares them. What `plan.md` holds beyond the headers is what tasks share —
the requirements, the plan's Context, the frozen interfaces, the slice
hypothesis, upstream compliance.

**Do not plan what the implementer will see in its own files.** A step names
the file and the requirement that has to hold in it; the implementer reads
the file. The argument order of a helper the owned file already calls, the
fixture a spec already loads, a flag the first run of `Done when` asks for —
written into the plan, each is a claim about code that every review round
then checks, and when it is wrong it costs exec one attempt. Write a detail
down when the implementer cannot learn it that way: a fact in a file the
task does not own, or one without which `Done when` would pass while the
requirement is unmet.

Every one of these is a requirement, and a plan that misses one gets redone
rather than patched:

1. **Every task owns its files exclusively.** Two tasks sharing a file is a
   planning error, not a coordination problem. A task that writes nothing — a
   whole-suite gate, a measurement — writes `Owns: (none — verification only,
   writes no files)`, which is read as no files: `plan check` accepts it as long
   as its `Done when` runs, the hook refuses every write it attempts, and every
   slice inherits the requirements it satisfies.
2. **`Done when` is a command and its expected output.** Prose is refused:
   "works correctly" cannot be checked by anyone except its author.
3. **Interfaces between tasks are frozen, with real signatures**, so two tasks
   cannot each invent their own version of the same boundary.
4. **One to three files per task.**
5. **Every context line cites `file:line`** from phase 1. A context line
   without a location was not verified. A line saying something is **absent**
   from the codebase or an API has no line to cite, so it cites the search:
   `searched: <query> in <where> -> 0`, run case-insensitive, with no window,
   for the concept as well as the name. "Not found" is not "not there" until
   that search says so. `pdkit plan check` refuses an absence that cites
   neither.
6. **Every task declares `satisfies: [R…]`.** A requirement with no task and a
   task with no requirement are both errors.
7. **`Upstream compliance` is filled in** from `${CLAUDE_PLUGIN_ROOT}/knowledge/upstream-rules.md`:
   SPDX on new files, schemas touched, `extension-api.d.ts` touched, commit
   scope. The plan must also not contradict section 1 of
   `${CLAUDE_PLUGIN_ROOT}/knowledge/maintainer-rules.md`:
   - existing tests are not changed in the same slice as the implementation
     they test;
   - prerequisite refactors are planned as their own task, ahead of the change
     that needs them;
   - no drive-by renames or moves.

   Upstream's review agent rejects all three.
8. **`e2e coverage:` is decided here** — `required`, `optional` or `no` with a
   reason. Deciding afterwards produces a test for what was built rather than
   for what was required.
9. **The order is written down, as `- After:`.** A task that cannot start
   until another is done says so: `- After: T4, T6`. A task written ahead of
   others because it has to run on the untouched tree — a safety-net test of
   current behavior — goes first in `## Tasks`, and every task that changes
   that behavior names it in `After`. Among tasks free to start, exec runs them
   in the order the blocks are written, so write them in the order they should
   run. `pdkit task start` enforces `After`; prose in a step ("run only after
   T20") enforces nothing and is read by nobody who picks a task. A task in a
   slice carries `- Slice: S<k>`, which is what `pdkit task list` shows beside
   it.
10. **`Slice hypothesis` is written.** Not the final graph, but tasks are
   ordered so cutting is possible later. Planning without it produces an
   interleaved diff that cannot be split without redoing the work.

   The slicer is held to it: `pdkit slice set` refuses more slices than the
   header's count unless the slicer says why. So the count in the header is a
   number, and the reasoning under the heading is written for somebody who will
   see only the diff.

   **Every slice leaves main working on its own.** A contract change, such as
   an IPC signature through main, preload and renderer or a type every consumer
   reads, has no subset that does. It is one slice, with a commit per layer if
   the reviewer should read the layers apart. If it should be several pull
   requests, plan expand/contract: add the new path beside the old one, move the
   callers, remove the old one. Each step then leaves main working, and that
   split has to be in the tasks, because no slicer can cut it out of a diff that
   replaced the old path.

## Then

`pdkit render plan --issue <n> --values <f> --path plan.md`, one
`pdkit render task --issue <n> --values <f> --path tasks/T<k>.md` per task —
the task's values carry its Context, Steps and Notes — then
`pdkit task sync --issue <n>` so the ownership map the pre-write hook enforces
comes from the task files rather than from anyone's memory of them.

`pdkit plan check <n>` before showing the plan to anybody: everything it finds
is something `/pd:plan-review` would find anyway, and finding it here costs one
command instead of a review round.

Then **run every `Done when`**, from the main checkout, which is on the base
branch:

```
pdkit plan probe <n>                      every live task
pdkit plan probe <n> --except T10,T12     leave out what takes an hour; say so
```

Read each command before it runs: the probe runs what the plan says. A plan
was approved after four review rounds and then stopped five times in exec on
commands that could never pass: a typecheck that fails on the base branch with
a config error, a lint on lines the task may not touch, a docs build that needs
an artefact nothing builds. Each was one run away. A red run here is often
expected — the spec file is not written yet — and that is fine; a red run for
any other reason is a `Done when` to fix now. `pdkit plan check` then lists
every task whose command was never run or did not exit 0, for the review.

Then `pdkit state <n> --to planned`.

Approval is a human action. On approval — and only then — `pdkit ids freeze
<n>` and `pdkit state <n> --to plan-approved`. The freeze is what makes R-IDs
a trace rather than a numbering: after it, they cannot be renumbered under a
PR that already cites them.

## When the phase runs long

`budget.turns.plan` is the ceiling here — a rough one, since no part of this
can count turns, you included. Well past it, stop at a point the files can
hold: `research.md` once phase 1 is done, open choices as `[NEEDS DECISION]` in
a draft plan. Then ask for a restart. A plan finished in a second session from
`research.md` costs less than one finished at the end of a long first, and
nothing in it depends on having watched the scouts work.

## Next

`/pd:plan-review <issue>` — before approval, not after. On approval, and only
then, freeze and move to `plan-approved`; what runs from there is
`/pd:exec <issue>`.

After the review, when the person has decided its findings: the review
records the decisions in `plan-review.md`, and the next step is this skill
again, in phase 0 — `pdkit next <issue>` says so. No context to pass.

**In a new session**, and the reason is sharper here than anywhere: the review
is meant to be read cold. A session that wrote the plan and then reviews it
carries every justification its author gave itself, and pays to re-read them on
every turn. `plan.md`, `tasks/` and `research.md` are what the review works
from. `pdkit next <issue>` prints the line to run.
