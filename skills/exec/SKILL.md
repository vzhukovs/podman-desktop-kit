---
name: exec
description: "Implement the plan, one task per worker, each producing a receipt."
argument-hint: "<issue-number> [task-id]"
disable-model-invocation: true
model: sonnet
effort: medium
---

One `pd-implementer` per task, fresh context each time. Fresh context is not
tidiness: a worker that has already failed twice carries both failures into the
third attempt, and that is where drift starts.

## Preconditions

`pdkit state <issue>` says `plan-approved`. Implementing an unapproved plan
means the requirements can still move under the code.

The one exception is `implemented`, for the tasks of an amendment approved
after validation found the plan wrong: the state has no way back, and
`pdkit task start` does not read it. Run those tasks only, by ID.

## Once, before the first task

```
pdkit checkpoint <n> --phase exec
pdkit task sync --issue <n>
```

The checkpoint is the way back if the run goes wrong: see the end of this
file.

Reads the `Owns` sets out of the task files into the state record, which is
what the pre-write hook enforces. Skip it and the hook has nothing to enforce:
it allows every write and says so, which is a worse failure than a refusal
because it looks like nothing happened.

## Per task

1. `pdkit task start --issue <n> --task T1` in the working tree the task runs
   in. From here until `task stop`, writes outside `T1`'s files are refused and
   completing the task requires its receipt.
2. Give the worker the task, its `Owns` list, its `Done when` command, and the
   frozen interfaces. Nothing else — not the whole plan, not the issue thread.

   The worker is a `pd-implementer`, not this session working through the same
   list. This is arithmetic, not taste: the subagent's context dies with it, and
   this session's is paid for again on every turn until the cycle ends. Twenty
   subagent runs measured in this plugin's own transcripts returned about 250
   tokens each to their parent. The same task done here leaves every file read,
   every edit and every test run in context — thousands of tokens, re-read on
   each remaining task.
3. The worker touches **only** the files in `Owns`. Anything else is a
   planning error to report, not a boundary to cross.
4. `pdkit receipt write --issue <n> --task T1` runs the `Done when` command and
   records what it printed.
5. Commit: conventional subject, one `Signed-off-by`. Squash with
   `git reset --soft <base> && git commit`, never `rebase -i`.
6. `pdkit task stop`.

Tasks that share no files may run in parallel. Tasks that do share files were
mis-planned — say so instead of serialising around it.

## Follow the plan literally

A worker that improves on the plan is drift, and drift is what this whole
structure exists to prevent. If the plan is wrong, that is a finding: stop,
report it, and amend the plan. Do not fix it in passing.

The distinction that matters: discovering the plan is wrong is valuable and
expected. Silently doing something better is what makes the audit meaningless,
because the diff no longer corresponds to anything that was agreed.

## When the plan is wrong: the amendment

"Amend the plan" is a sequence of commands, and most of it does not happen in
this session. On DESKTOP-18915 the amendment was written here, its two new
tasks were typed into `tasks/` with a heredoc, and the three tasks it replaced
stayed live in the ownership map and in the audit. Every one of those was
mended by hand afterwards.

Two sizes, and they need different things:

- **Small** — `Requirements affected` rows only: a requirement reworded,
  withdrawn, or superseded. Nothing under `Slices affected`. It can be written
  where it was found; it still needs steps 2 and 4, in this session.
- **Large** — the hypothesis the plan stood on is dead, and tasks are added or
  replaced. That is a rewrite of the plan, and it gets every step below.

The rule between them: **if an amendment creates a task, it goes through what
a plan goes through.** A task written into an amendment has otherwise seen
neither the plan checks nor `pd-plan-critic`.

1. **Here: stop and report, do not write.** The finding should be an artefact
   on disk, such as a reproduction, a receipt or a captured run, not a
   paragraph in chat. Then `pdkit task stop` and end the session. Capture
   nothing for that task after the stop: `pdkit receipt write` does not check
   that the task is still running. Do not draft the amendment from the context
   that produced the finding: the finding fits on a screen, and that context is
   tens of thousands of tokens nobody needs to state a requirement.
2. **New session, on opus: write it.** `pdkit amendment new --issue <n>
   --values <f>`, written from the artefact and `plan.md`. Requirement changes
   go in `rows`. A task the amendment adds goes under `Slices affected` in
   exactly a plan's shape, and its heading names what it replaces:

   ```
   ### T5 (replaces T2 and T3): <title>
   - Satisfies: R1, R7
   - Owns: packages/main/src/index.ts
   - Done when: `npx vitest run packages/main/src/index.spec.ts` -> exit 0
   - Steps:
     1. <step>
   ```

   New tasks take the next free T-ID. Existing IDs are never reused or
   renumbered.
3. **If it adds or replaces tasks, review it as a plan.** `/pd:plan-review
   <n>` in a new session, and hand the critic `amendments/A<k>.md` beside
   `plan.md`: the review reads `plan.md`, and until approval the new tasks are
   only in the amendment. `pdkit plan check <n>` cannot see them yet either.
4. **A human approves it, by command.** `pdkit amendment approve A<k> --issue
   <n> --by <who>`. "Approved" in chat changes nothing. Approval runs the
   mechanical checks on the new tasks — an executable `Done when`, a live
   R-ID, no `Owns` shared with a task that stays, no reused ID — and refuses
   on any of them, leaving the amendment `proposed` with the line to fix.
   It also refuses an amendment that leaves an R-ID with no live task.
   **A refusal is an answer.** Fix the line it names. If the fix would mean
   two tasks owning one file, the work does not belong to this issue: bring
   that to the person as `pdkit issue draft-blocker` and `pdkit issue block`.
   Never delete task headings, or rewrite tasks as prose, to get the check
   out of the way. On DESKTOP-18833 that bought an approval, and the gap came
   back as a refused `slice set` after the work was done.
   Then it applies the requirement table and materialises the tasks: it
   renders `tasks/T<k>.md`, adds the blocks to `plan.md`, marks the replaced
   tasks `withdrawn by A<k>` and re-runs `task sync`. `pdkit plan check <n>`
   now reads the plan with them in it. If an amendment was approved but did
   not fully apply, `pdkit amendment sync A<k> --issue <n>` finishes it.
5. **New session, on sonnet: back to `/pd:exec <n>`.** The issue's state never
   moved; the plan did.

Never write a task file by hand to get past a missing one. A task the plan
names with no file in `tasks/`, or one `pdkit task start` reports with no
recorded Owns set, means the amendment is not approved or not applied: go to
step 4. A withdrawn task is refused by `task start`, by
`receipt write` and by the pre-write hook, and each refusal names the task
that replaced it. Start that task instead.

## Receipts

A task is done when the output of its `Done when` command is captured
verbatim — not summarised, not trimmed to the interesting part.

`pdkit receipt write` runs the command itself. There is no parameter for
output text, so there is nothing to compose: the choice between "the tests
passed" and the test runner's own words is not offered.

Two refusals to expect from the SubagentStop hook, and they mean different
things:

- **no receipt, or one that no longer matches its digest** — run the command
  above. A receipt edited after capture is refused by arithmetic, not by
  suspicion.
- **a valid receipt for a command that exited non-zero** — the work is not
  finished. Fix it and capture again. If the command itself is wrong, that is
  a finding about the plan; report it rather than editing `Done when` into
  something that passes.

## The third failure is not a fourth try

Every failed capture is counted, from the capture itself — `pdkit task
attempts --issue <n>` reads it back. At `exec.max_attempts` (three by default)
the task is **blocked**: the completion hook refuses it and `pdkit task start`
will not pick it up again.

That refusal is the point of the mechanism, so do not route around it. The
question it forces is a real one: what changed between the second attempt and
the third? If the honest answer is "nothing, I tried harder", the plan is
wrong rather than the code — and a wrong plan is amended, not retried.

The way past is a sentence a human writes:

```
pdkit task unblock --issue <n> --task T1 --reason "<what is different this time>"
```

Report the block and what you learned from the three failures. Do not compose
the reason yourself — the count restarts there, and in six weeks that line is
the only record of why anyone expected a fourth attempt to differ.

## Then

`pdkit state <n> --to implemented`.

## When the phase runs long

`budget.turns.exec_per_task` is per task, because the length of this phase is
the length of the plan. Treat it as a rough mark — the count you would keep of
your own turns is not a precise one. The place to stop is between tasks: after
`task stop`, the next task needs only its task file, and the last one left its
receipt and its commit. Past the mark, take the task in hand to its receipt,
stop it, and ask for a restart; `/pd:exec <issue> T<k>` in the new session
continues from the next task.

## Next

`/pd:validate <issue>` — evidence for what was built, before anything judges it
against the plan.

**In a new session.** Validation looks at the running application and reports
what it saw; the reasoning that produced the code is the one thing it should
not inherit, and running here it would — re-read in full on each turn. The
receipts and the commits are what it needs. `pdkit next <issue>` prints the
line, and so does the summary the session opens with.

## When the phase went somewhere it should not

If this phase built on an option pdkit does not carry, or a refusal was routed
around before anyone noticed, go back to its start rather than patch forward:

```
pdkit rollback <n>              what would come back, and what stays
pdkit rollback <n> --confirm    after the person has read that
```

Branches return to their heads at the checkpoint, with the present tips kept
under `refs/pdkit-backup/`. Artefacts return from the copy, with the present
ones archived. The state record comes back too. It is refused if the phase
moved the issue to another state, because a transition is not undone by
rewriting the record. What was published stays published, and the journal
keeps everything. Show the dry run in full and ask before `--confirm`. Then
run the phase again, in a new session.
