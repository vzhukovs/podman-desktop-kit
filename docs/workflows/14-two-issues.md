# 14. Two issues at once

[Workflows](README.md) › Part III — Living with an open pull request · [Sessions and models](#sessions-and-models)

```
pdkit worktree create --issue 12345
pdkit worktree create --issue 12908
```

One tree per issue, beside the fork rather than inside it. State lives in
`$PDKIT_HOME` keyed by issue, so both trees see the same plan, receipts and slice
graph — while the *active task* pointer is per tree, which is what lets two trees
run two tasks of the same issue without either ownership hook guarding the wrong
files.

`pdkit worktree remove --issue 12345` refuses while the tree holds a branch that has
not landed: removing it takes the commits with it and says nothing.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type:

```
terminal 1: cd <fork> && claude     every phase of 12345, as in scenario 1
terminal 2: cd <fork> && claude     every phase of 12908, as in scenario 2
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `pdkit worktree create …` | **terminal** | — | — |
| every phase of either issue | **new** · that issue's tree | as in [scenario 1](01-bug-fix.md#sessions-and-models) | — |

Two issues are two sets of sessions. One session moving between trees carries
the first issue into every turn of the second.

---

**The design** — [2.2 · State, outside the repository](../specification/02-plugin-structure.md#22-state-outside-the-repository)

← [13 · Reviewing someone else's pull request](13-reviewing-others-pr.md) · [Contents](README.md) · [15 · A task that has failed three times](15-task-failed-three-times.md) →
