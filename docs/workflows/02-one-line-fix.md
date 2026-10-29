# 2. A one-line fix

[Workflows](README.md) › Part I — Choosing and starting work · [Sessions and models](#sessions-and-models)

```
/pd:triage 12908      → route: quickfix
/pd:quickfix 12908
/pd:preflight 12908
/pd:pr 12908                                                     [you confirm push]
```

Planning is skipped on purpose. If the diff fits in one sentence, a plan is
overhead — and the threshold in config is a defence against ceremony, not an
optimization.

If the fix outgrows the thresholds, `pdkit issue escalate 12908` sends it back to
triage. That ordering is not bureaucracy: requirements derived from a diff you
have already written describe what you built rather than what was needed.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
/model opus                         ← triage is opus
/effort high
/pd:triage 12908                    route: quickfix

/clear
/model sonnet                       ← sonnet from here to the PR
/effort medium
/pd:quickfix 12908

/clear
/pd:preflight 12908

/clear
/pd:pr 12908
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `/pd:triage 12908` | **new** · main checkout | opus | `pd-scout` · sonnet |
| `/pd:quickfix 12908` | **new** · the checkout that will carry the branch: `pdkit branch create` checks it out there | sonnet | — |
| `/pd:preflight 12908` | **new** · the same checkout | sonnet | — |
| `/pd:pr 12908` | **new** · the same checkout | sonnet | — |
| `pdkit issue escalate 12908`, if it outgrows the thresholds | **terminal** | — | — |

---

**The design** — [`/pd:triage`](../specification/04-contracts/triage.md)

← [1 · A bug fix](01-bug-fix.md) · [Contents](README.md) · [3 · A feature, cut into several pull requests](03-feature-in-several-prs.md) →
