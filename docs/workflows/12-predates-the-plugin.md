# 12. Work that predates the plugin

[Workflows](README.md) › Part III — Living with an open pull request · [Sessions and models](#sessions-and-models)

A branch and a pull request exist, and `state.json` says `new`. Walking it through
the whole chain so the record "agrees" would mean writing a plan nobody planned and
freezing requirements nobody stated.

```
pdkit issue adopt 17577 --pr 17577 --branch DESKTOP-17577/… --reason "open two months, predates the plugin"
```

Adoption records what exists — state, route, PR number — marks the record `adopted`
with the reason, and stops. The artefacts of the states it never passed stay
missing, and `adopted` explains why: an issue with no plan because nobody wrote one
and an issue whose plan was lost are different things. Only from `new`: overwriting
a live record would erase the one history that cannot be rebuilt.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
pdkit issue adopt 17577 --pr 17577 --branch … --reason "…"     no model: a terminal

/clear
/model opus                         ← review rounds are opus
/effort high
/pd:pr-sync 17577                   the first round adds the full self-review
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `pdkit issue adopt …` | **terminal**, or a `/pd:resume` session in the existing tree | — | — |
| next: `/pd:pr-sync 17577` | **new** · the existing tree | opus | first round: the four `pd-review-*` · sonnet, `pd-review-synth` · opus, then `pd-thread-resolver` · sonnet |

---

**The design** — [`/pd:resume`](../specification/04-contracts/resume.md)

← [11a · Upstream asks you to join open pull requests](11a-join-open-prs.md) · [Contents](README.md) · [13 · Reviewing someone else's pull request](13-reviewing-others-pr.md) →
