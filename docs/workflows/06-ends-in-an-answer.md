# 6. An issue that ends in an answer

[Workflows](README.md) › Part II — Proving it works · [Sessions and models](#sessions-and-models)

The bug is real and reproduces, and the cause is not in this repository — a
version skew between a client and the machine it drives, a host setting, a
dependency. There is nothing to change here, and there is still work: a
reproduction, a command that separates this problem from its look-alikes, and a
workaround.

```
/pd:validate 12345    → attach the reproduction as evidence
pdkit findings new --issue 12345
pdkit state 12345 --to answered
```

**Entry is guarded by a capture.** `answered` is refused while nothing is
attached, and for a specific reason: a workaround nobody ran is a suggestion, and
a suggestion posted in the voice of a finding costs the reporter their evening.

`findings.md` asks for two things that are easy to skip — a detector command, and
what would have kept this from reaching a user. An environmental cause is a reason
not to change this repository; it is not a reason for the repository to say
nothing.

**Publishing is a human action.** `gh issue comment` is denied by the hook from
every state, with no way to open a gate for it.

**`answered` is not the end.** At the moment the findings are posted you are
waiting on the reporter, and three things happen: they confirm, and the issue goes
to `resolved`; the answer turns out to imply product work, and it goes back to
`planned`; nobody replies, and it goes to `abandoned`.

```
pdkit close --issue 12345 --finish --confirmed "@reporter, 2026-08-09"
```

`--confirmed` is required and takes a fact about them, not a verdict about us:
deciding on our own that somebody else's problem went away is not ours to decide.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
/clear
/model sonnet                       ← validation is sonnet
/effort medium
/pd:validate 12345                  the reproduction, attached as evidence
pdkit findings new --issue 12345
pdkit state 12345 --to answered

… the reporter answers …

pdkit close --issue 12345 --finish --confirmed "@reporter, 2026-08-09"
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `/pd:validate 12345` | **new** · the checkout the reproduction is built in | sonnet | `pd-validator` · sonnet |
| `pdkit findings new`, `pdkit state --to answered` | **terminal**, or the validate session | — | — |
| `pdkit close … --confirmed`, when the reporter answers | **terminal** | — | — |

---

**The design** — [1 · The `answered` branch](../specification/01-domain-model.md#the-answered-branch--an-issue-whose-deliverable-is-not-a-diff), [architecture · The lifecycle](../architecture/03-lifecycle.md)

← [5 · Work that was already tried and reverted](05-tried-and-reverted.md) · [Contents](README.md) · [7 · A pull request that has gone stale](07-stale-pr.md) →
