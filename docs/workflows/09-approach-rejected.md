# 9. The reviewer rejected the approach, not the diff

[Workflows](README.md) › Part III — Living with an open pull request · [Sessions and models](#sessions-and-models)

An ordinary outcome of review in somebody else's repository, and for a long time
the machine had no way to say it: the only moves from an open pull request were to
push again — which assumes the design survived — and to abandon an issue still
worth doing.

```
pdkit issue rework 12345 --reason "maintainer wants this in the provider, not the UI"
```

The pull request stays open and the branch is untouched. The issue returns to
`triaged`, **not** to `planned`: the route is picked again and planning starts from
the issue rather than from the diff that was refused. The requirement set thaws,
because an objection to an approach is usually a requirement nobody wrote down; the
identifiers keep their numbers, because an R-ID means one thing forever.

Not to be confused with [starting over](16-starting-over.md). A rework
keeps everything and adds the objection as a requirement; a reset forgets the lot.
When a reviewer has told you what is wrong with the design, that sentence is the
most valuable thing the review produced.

## The reviewer wants something landed first

"This should be its own PR, before this one." If that change touches no file the
slices own, it is a new slice through an amendment. If it does, one issue cannot
hold both: a slice is the diff restricted to its files, so one file has one slice.
It becomes a separate upstream issue, and this one waits:

```
pdkit issue draft-blocker 18833 --what "<what it carries>" --pr 19375 --prior <branch>
  … you open the issue upstream from the draft …
pdkit issue block 18833 --by <new issue> --reason "<what it carries>"
/pd:triage <new issue>          in a new session, prior work named after the number
```

`next`, `state` and `pr list` say what 18833 waits on. The review round carries on
for the rows that do not depend on it. When the blocker has merged,
`pdkit issue unblock 18833 --by <new issue>` and `/pd:resume 18833`.

There is no stacking in this. Two pull requests changing one file in sequence is
not something the slice model can express, and from a fork a pull request cannot
target another one's branch anyway.

## Going back to the start of a phase

`/pd:exec`, `/pd:slice`, `/pd:pr-sync` and `/pd:resume` take a checkpoint as their
first step. If the phase went somewhere it should not, it is undone by command
rather than from memory:

```
pdkit checkpoint list 18833
pdkit rollback 18833                 dry run: what comes back, what stays
pdkit rollback 18833 --confirm
```

- **Comes back:** branch heads, and branches created during the phase are
  deleted, with every present tip kept under `refs/pdkit-backup/`; the issue's
  trees, with one created during the phase removed and one removed during it
  added back; the branch the main checkout stood on; the issue's artefacts, with
  the present ones archived; the state record. A task left running is stopped.
- **Stays:** anything pushed or posted, and the journal, which gains one
  `rolled-back` entry.
- **Refused until it is committed or stashed:** uncommitted work in any tree the
  rollback would move. A tree is the one place work exists outside git.
- **Refused:** a phase that moved the issue to another state. There is no edge
  back in the machine, and writing the old state over the new one would put a trip
  in the history that the work never took. That is `pdkit reset`'s territory.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
pdkit issue rework 12345 --reason "…"     no model: a terminal, or the pr-sync session

/clear
/model opus                         ← planning again, on opus
/effort high
/pd:plan 12345

  the reviewer wants something landed first:

pdkit issue draft-blocker 18833 …
pdkit issue block 18833 --by <new issue> --reason "…"

/clear
/model opus
/effort high
/pd:triage <new issue>

  once the blocker has merged:

pdkit issue unblock 18833 --by <new issue>
/clear
/model sonnet                       ← resume is sonnet
/effort medium
/pd:resume 18833
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `pdkit issue rework …` | **terminal**, or the `/pd:pr-sync` session that read the rejection | — | — |
| next: `/pd:plan 12345` | **new** · main checkout | opus | `pd-scout` · sonnet |
| `pdkit issue draft-blocker`, `pdkit issue block` | **terminal**, or the `/pd:pr-sync` session | — | — |
| `/pd:triage <new issue>` | **new** · main checkout | opus | `pd-scout` · sonnet |
| `pdkit issue unblock`, then `/pd:resume 18833` | **terminal**, then **new** · issue tree | sonnet | `pd-conflict-analyst` · opus |
| `pdkit checkpoint list`, `pdkit rollback` | **terminal**, or the session of the phase being undone | — | — |

---

**The design** — [1 · The `rework` edge](../specification/01-domain-model.md#the-rework-edge), [architecture · The lifecycle](../architecture/03-lifecycle.md)

← [8 · Coming back after a break](08-coming-back.md) · [Contents](README.md) · [10 · A pull request replaced by another](10-pr-replaced.md) →
