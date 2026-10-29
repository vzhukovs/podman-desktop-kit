# 0. Picking what to work on

[Workflows](README.md) › Part I — Choosing and starting work · [Sessions and models](#sessions-and-models)

```
/pd:triage             → shortlist; nothing is written and nothing moves
pdkit issue list --label "area/terminal" --limit 20
```

`/pd:triage` without a number answers a different question from the rest of this
file: not "how do I do this issue" but "which issue". One GraphQL request brings
back the open backlog with the facts that say whether an issue can be started at
all — pull requests referencing it **in this repository**, who it is assigned to,
whether a maintainer has answered, whether a bug report carries a reproduction,
and how long since a human last touched it.

Two of those are worth spelling out, because both looked fine while being wrong:

- **Idle time is measured from human activity, not `updatedAt`.** The stale bot
  posting a notice moves the timestamp. Sorted on `updatedAt`, an issue whose
  last human comment was five months ago sits at the top of the list.
- **A cross-reference from another repository is not a linked pull request.**
  Somebody's prototype repo can reference an upstream issue, and a merged PR over
  there says nothing about whether the work exists here.

What the listing does not do is pick. The order is over facts; whether a
requirement is clear enough to plan against is not a fact, and that is the part
that decides. Read the top few, then triage one.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
/model opus                         ← triage runs on opus
/effort high
/pd:triage                          no number: the shortlist
pdkit issue list --label "area/terminal" --limit 20

/clear
/effort high
/pd:triage <n>                      the one picked — still opus
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `/pd:triage`, no number | **new** · main checkout | opus | — |
| `pdkit issue list …` | **terminal** | — | — |
| `/pd:triage <n>` for the one picked | **new** · main checkout | opus | `pd-scout` · sonnet |

The shortlist has nothing the triage of one issue needs: it is re-read from
GitHub there. Pick in one session, triage in the next.

---

**The design** — [`/pd:triage`](../specification/04-contracts/triage.md)

[Contents](README.md) · [1 · A bug fix](01-bug-fix.md) →
