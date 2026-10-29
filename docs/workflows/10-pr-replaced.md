# 10. A pull request replaced by another

[Workflows](README.md) › Part III — Living with an open pull request · [Sessions and models](#sessions-and-models)

A rework produces a second pull request, and the first one gets closed. Closed is
not the same as rejected, and the difference decides whether the issue is finished:

```
pdkit pr closed 17577 --superseded-by 18562
```

Without this, the rollup treats every closed pull request as unfinished work —
right when a maintainer rejected it, wrong when a rework replaced it. With it, the
issue settles once the replacement merges. What that rests on is the successor's
own state, not the sentence in the reason field.

`pr closed` records a close that already happened. To close it from here, with
the comment that points at the replacement, use `pdkit pr supersede <old> --by
<new> --body <f>`: it prints what it would post, and with `--confirm` and a
reply token for `<old>` it closes the pull request upstream and records the same
thing `pr closed --superseded-by` does.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type:

```
pdkit pr closed 17577 --superseded-by 18562      no model: a terminal
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `pdkit pr closed …` | **terminal** | — | — |
| `pdkit pr supersede … --confirm` | **terminal**, after a reply token for the old pull request | — | — |

---

**The design** — [`/pd:pr-status`](../specification/04-contracts/pr-status.md)

← [9 · The reviewer rejected the approach, not the diff](09-approach-rejected.md) · [Contents](README.md) · [11 · Upstream asks you to split an open pull request](11-split-open-pr.md) →
