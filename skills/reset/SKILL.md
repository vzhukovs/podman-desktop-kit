---
name: reset
description: "Start one issue over: forget its plan, research and artefacts so the next cycle runs from nothing. Touches no other issue, and nothing upstream."
argument-hint: "<issue-number> [--purge] [--worktrees]"
disable-model-invocation: true
model: sonnet
---

For a run that went wrong early. The triage read the issue as something it is
not, the scouts mapped the wrong package, a plan was approved that should not
have been — and continuing means every later step inherits the mistake, because
every later step reads what the earlier ones wrote.

This forgets one issue so the next full cycle starts from nothing.

## Steps

1. **`pdkit reset <issue>`** — the dry run. Nothing is written. It prints what
   would go, and, below it, what would stay.

2. **Read the "stays" half out loud to the user.** It is the half people skip
   and the only one that can surprise them:

   - **an open pull request stays open.** This forgets it; it does not close
     it. If starting over means the published attempt should not stand, that is
     a separate, human action on GitHub — and the plugin cannot do it anyway.
   - **the journal keeps every entry.** It is append-only by construction, so
     the earlier attempt stays legible to whoever asks in six months. Without
     that, an issue back at `new` would be indistinguishable from one nobody
     ever touched.
   - **deferrals survive**, for the same reason: a promise made to a reviewer
     is not undone by us deciding to start again locally.

3. **`pdkit reset <issue> --confirm`.** The artefacts are archived rather than
   deleted, under `$PDKIT_HOME/archive/<issue>/<timestamp>/`; nothing reads
   them, and `mv` puts them back. `--purge` deletes instead, for the case where
   the point is that the plan must not be recoverable.

4. **Triage, from nothing.** The record is gone, so the machine reads the issue
   as `new` again, whose only exit is `triaged` — the next cycle cannot start
   anywhere but the beginning, which is the whole point.

   ```
   /pd:triage <issue>
   ```

   Step 1 of triage is dedup, so an open pull request this reset forgot is
   rediscovered there from GitHub rather than from our record.

## Worktrees

Not removed unless asked. A branch with commits nobody pushed is *work*, not a
record of work, and a command called "start over" must not be the thing that
drops it.

```
pdkit reset <issue> --confirm --worktrees
```

Removal still refuses a tree holding a branch that has not landed in the base
branch. `--force` only once you mean to abandon those commits — and prefer
pushing them to your fork first, since the refusal is not recoverable
afterwards.

## What this is not

**It is not a state transition, and there is no route back to `new`.** The
record is removed, so the machine reads `blank()` — its own word for "nothing
has happened here". Inventing an edge into `new` would put a trip in the
history that the work never took, and `adopted` exists precisely so that
"these artefacts were never produced" reads differently from "these artefacts
were lost".

**It is not for a reviewer rejecting the approach.** That is
`pdkit issue rework <n> --reason "<what was refused>"`: the diff and the pull
request stay, requirements thaw, and planning runs again from the issue. The
objection is a requirement — resetting would throw away the most valuable
thing the review produced.

**It is not for a fix that was tried before and reverted.** That is the `redo`
route, and `pdkit issue history <n>` is the point of it: the reason it was
backed out was written down at the time, and rediscovering it by
re-implementing is exactly what that route exists to prevent.

**It is not for abandoning an issue.** `pdkit state <n> --to abandoned` with a
reason says the work was dropped and keeps the account of why. A reset says
nothing about whether the issue is worth doing.
