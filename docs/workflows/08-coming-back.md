# 8. Coming back after a break

[Workflows](README.md) › Part III — Living with an open pull request · [Sessions and models](#sessions-and-models)

```
/pd:sync
/pd:resume 12345      → main updated, upstream drift, rebase, conflicts
/pd:pr-sync <pr#>     → what accumulated in review, and the push
/pd:preflight 12345
/pd:pr 12345
```

`/pd:resume` pushes nothing. The rebased branch reaches its pull request in
`/pd:pr-sync`, after `pdkit pr diff` has shown what the push changes.

`pdkit drift 12345` measures each slice from **its own** branch point, and says
separately which upstream commits touched lines the plan cites. A commit in the
file is a candidate for a mechanical conflict; a commit in those lines is a
candidate for a semantic one, and semantic means stop.

A previous green preflight means nothing after a rebase.

A mechanical conflict is resolved to what both sides need and nothing more. A
reordered import or a reformatted block made while resolving reaches the pull
request as a change its title does not explain.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
/clear
/model sonnet
/effort medium
/pd:sync

/clear
/pd:resume 12345                    still sonnet — pd-conflict-analyst is opus on its own

/clear
/model opus                         ← switch: the review round is opus
/effort high
/pd:pr-sync <pr#>

/clear
/model sonnet                       ← and back
/effort medium
/pd:preflight 12345

/clear
/pd:pr 12345
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `/pd:sync` | **new** · main checkout | sonnet | — |
| `/pd:resume 12345` | **new** · issue tree | sonnet | `pd-conflict-analyst` · opus |
| `/pd:pr-sync <pr#>` | **new** · issue tree | opus | `pd-thread-resolver` · sonnet |
| `/pd:preflight 12345` | **new** · issue tree | sonnet | — |
| `/pd:pr 12345` | **new** · issue tree | sonnet | — |

---

**The design** — [`/pd:resume`](../specification/04-contracts/resume.md)

← [7a · Feedback that arrives after the merge](07a-feedback-after-merge.md) · [Contents](README.md) · [9 · The reviewer rejected the approach, not the diff](09-approach-rejected.md) →
