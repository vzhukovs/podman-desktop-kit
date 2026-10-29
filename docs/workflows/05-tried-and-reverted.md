# 5. Work that was already tried and reverted

[Workflows](README.md) › Part II — Proving it works · [Sessions and models](#sessions-and-models)

```
/pd:triage 12775       → route: redo
pdkit issue history 12775
```

Triage takes this route when it finds a merged pull request and a revert. The
archaeology comes first, and `pdkit` holds that ordering rather than asking for
it: on the redo route the issue **cannot leave `triaged`** until
`archaeology.json` exists, and that file is written only when GitHub has actually
been asked. A summary cannot produce it, for the same reason a convincing account
of a test run cannot produce a receipt.

One call brings back the attempt, what reverted it, how long it lived in the base
branch, what reviewers said at the time, what merged in those files afterwards,
and what could not be established. `pd-archaeologist` then answers what the facts
cannot: why it was reverted, and whether that reason still applies.

Two things are easy to get wrong here, and both were found on a live issue:

- **A revert references the pull request it reverts, not the issue.** Asking the
  issue's timeline alone reports a merged attempt and no revert — which reads as
  "this landed and is still there".
- **The attempt and its revert have to be paired, not picked by date.** The newest
  merge on an issue can easily post-date the revert; pairing them by recency
  produces an attempt its own revert predates, with review comments from the wrong
  pull request.

Carry the regression into the requirements alongside the original ask. A redo that
satisfies only the original one lands and is reverted for the same reason.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
/model opus                         ← triage is opus
/effort high
/pd:triage 12775                    route: redo
pdkit issue history 12775

/clear
/effort high
/pd:plan 12775                      still opus
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `/pd:triage 12775` | **new** · main checkout | opus | `pd-archaeologist` · sonnet, `pd-scout` · sonnet |
| `pdkit issue history 12775` | **terminal**, or the triage session | — | — |
| next: `/pd:plan 12775` | **new** · main checkout | opus | `pd-scout` · sonnet |

---

**The design** — [`/pd:triage`](../specification/04-contracts/triage.md)

← [4 · Validating against the running application](04-validating.md) · [Contents](README.md) · [6 · An issue that ends in an answer](06-ends-in-an-answer.md) →
