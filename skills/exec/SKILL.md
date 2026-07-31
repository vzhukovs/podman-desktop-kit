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

## Per task

1. Give the worker the task, its `Owns` list, its `Done when` command, and the
   frozen interfaces. Nothing else — not the whole plan, not the issue thread.
2. The worker touches **only** the files in `Owns`. Anything else is a
   planning error to report, not a boundary to cross.
3. It finishes by running the `Done when` command and capturing the real
   output.
4. Commit: conventional subject, one `Signed-off-by`. Squash with
   `git reset --soft <base> && git commit`, never `rebase -i`.

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

**As of stage 1 this is discipline, not enforcement.** The TaskCompleted hook
that refuses a completion without a receipt lands in stage 2. Until then, a
task marked done without captured output is exactly the claim receipts exist
to replace, and nothing will stop you.

## Then

`pdkit state <n> --to implemented`.
