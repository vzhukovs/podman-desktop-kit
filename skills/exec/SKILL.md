---
name: exec
description: "Implement the plan, one task per worker, each producing a receipt."
argument-hint: "<issue-number> [task-id]"
disable-model-invocation: true
model: sonnet
---

One `pd-implementer` per task, fresh context each time. Fresh context is not
tidiness: a worker that has already failed twice carries both failures into the
third attempt, and that is where drift starts.

## Preconditions

`pdkit state <issue>` says `plan-approved`. Implementing an unapproved plan
means the requirements can still move under the code.

## Once, before the first task

```
pdkit task sync --issue <n>
```

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

## Receipts

A task is done when the output of its `Done when` command is captured
verbatim — not summarised, not trimmed to the interesting part.

`pdkit receipt write` runs the command itself. There is no parameter for
output text, so there is nothing to compose: the choice between "the tests
passed" and the test runner's own words is not offered.

Two refusals to expect from the TaskCompleted hook, and they mean different
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

## Next

`/pd:validate <issue>` — evidence for what was built, before anything judges it
against the plan.
