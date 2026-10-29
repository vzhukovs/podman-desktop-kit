# 16. Starting one issue over

[Workflows](README.md) › Part III — Living with an open pull request · [Sessions and models](#sessions-and-models)

Sometimes the answer to a failing task is not a fourth attempt. The triage read
the issue as something it is not, or the scouts mapped the wrong package, and
everything since has inherited that — because every step reads what the steps
before it wrote. Continuing costs more than restarting.

```
pdkit reset 12345             # what would go, and what would stay. Writes nothing
pdkit reset 12345 --confirm   # do it
/pd:triage 12345              # from nothing
```

The record is **removed rather than moved**, so the machine reads the issue as
`new` — its own word for nothing has happened here — and `triaged` is the only
exit. There is no transition back to `new` and there deliberately is not one: it
would put a trip in the history that the work never took, and the distinction
between "these artefacts were never produced" and "these artefacts were lost" is
what every later check rests on.

It touches **one** issue. Its neighbours keep their records, their tokens and
their worktrees, and the match is exact rather than by prefix — `DESKTOP-1854`
does not select the tree of `DESKTOP-18548`.

Read the dry run's second half before agreeing to it. Three things stay, and one
of them surprises people:

- **an open pull request stays open.** This forgets it; it does not close it. If
  starting over means the published attempt should not stand, closing it is a
  human action on GitHub. Nothing is lost by forgetting it — dedup is the first
  step of triage, so the next cycle finds it again from GitHub.
- **the journal keeps every entry** and gains one saying what was reset and where
  its artefacts went. It is append-only by construction, which is what keeps the
  earlier attempt legible six months later.
- **deferrals survive**, for the same reason they survive a merge: a promise made
  to a reviewer is not undone by us starting again locally.

Artefacts are archived rather than deleted — `$PDKIT_HOME/archive/<issue>/<time>/`,
which nothing reads and one `mv` restores. `--purge` deletes instead.

Worktrees are not removed unless you ask:

```
pdkit reset 12345 --confirm --worktrees
```

and removal still refuses a tree holding a branch that has not landed. A branch
with unpushed commits is work, not a record of work, and a command called "start
over" must not be the thing that drops it.

## Three things this is not

| Situation | What it actually is |
|---|---|
| a reviewer refused the **approach** | `pdkit issue rework` ([scenario 9](09-approach-rejected.md)). Their objection is the most valuable thing the review produced; a reset throws it away |
| the work was tried before and **reverted** | the `redo` route ([scenario 5](05-tried-and-reverted.md)). The reason it was backed out was written down at the time, and rediscovering it by re-implementing is what that route exists to prevent |
| the issue is **not worth doing** | `pdkit state <n> --to abandoned --reason "…"`. A reset says nothing about whether the work should happen |

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
pdkit reset 12345                   what would go; writes nothing
pdkit reset 12345 --confirm

/clear
/model opus                         ← from nothing: triage is opus
/effort high
/pd:triage 12345
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `pdkit reset 12345`, then `--confirm` | **terminal**, or **new** · main checkout running `/pd:reset 12345` on sonnet | — | — |
| `/pd:triage 12345` | **new** · main checkout | opus | `pd-scout` · sonnet |

Not from inside the issue's tree when `--worktrees` is passed: the tree is what
it removes.

---

**The design** — [`/pd:reset`](../specification/04-contracts/reset.md), [architecture · The lifecycle](../architecture/03-lifecycle.md)

← [15 · A task that has failed three times](15-task-failed-three-times.md) · [Contents](README.md) · [Reference](reference/README.md) →
