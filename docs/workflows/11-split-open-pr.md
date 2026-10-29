# 11. Upstream asks you to split an open pull request

[Workflows](README.md) › Part III — Living with an open pull request · [Sessions and models](#sessions-and-models)

```
pdkit slice suggest --issue 17221 --from-pr 17577
pdkit pr threads 17577               which new slice each existing thread moves to
```

The same slicer, with a published diff substituted for the local one. The
substitution holds through the whole chain — `suggest`, `set`, `verify` — because a
flag that redirects the source in one command of a chain is not half a feature; it
is a feature that does not work.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
/clear
/model sonnet                       ← slicing is sonnet, even after an opus review round
/effort medium
/pd:slice 17221                     the slicer, on the published diff

/clear
/pd:pr 17221                        one session per new slice
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| the split: `slice suggest --from-pr`, `set`, `verify` | **new** · issue tree running `/pd:slice 17221`, or **terminal** | sonnet | `pd-slicer` · sonnet |
| `pdkit pr threads 17577` | **terminal** | — | — |
| the new pull requests: `/pd:pr 17221` | **new** · issue tree, one per slice | sonnet | — |

---

**The design** — [`/pd:slice`](../specification/04-contracts/slice.md)

← [10 · A pull request replaced by another](10-pr-replaced.md) · [Contents](README.md) · [11a · Upstream asks you to join open pull requests](11a-join-open-prs.md) →
