# 1. A bug fix

[Workflows](README.md) › Part I — Choosing and starting work · [Sessions and models](#sessions-and-models)

```
/pd:triage 12345      → route, drafted requirements
/pd:plan 12345        → reconnaissance, open questions, plan     [you approve]
/pd:plan-review 12345 → adversarial review of the plan
/pd:exec 12345        → implementation, one task per worker, receipts
/pd:validate 12345    → evidence from the running application
/pd:audit 12345       → diff against plan, fresh context
/pd:slice 12345       → usually one slice                        [you approve]
/pd:preflight 12345   → deterministic gates
/pd:pr 12345          → branch, PR body, PR                      [you confirm push]
```

**Each line is its own session.** Close the session when a phase ends and open a
new one for the next; `pdkit next 12345` prints what to run. This is not a
preference about tidiness — see [one session per phase](reference/sessions.md)
for what carrying one session through the whole list costs.

**The code is written in the issue's own tree.** `/pd:exec` starts by creating
`DESKTOP-12345` with `pdkit worktree create --issue 12345 --slug <slug>` and
moving the session there. The main checkout stays on the base branch as the
template trees are made from, and `pdkit task start` refuses to run a task in
it.

**Starting with what you already know.** The first line is the command;
everything after it in the same message is kept verbatim as prior context:

```
/pd:triage 12345
Fourth pass of the pattern from #18831 — containers (#18889) and networks
(#19048) are in. Repeat the #19048 approach: convert in the store fetcher,
not in the consumers. Trap: EventStore.performUpdate has no catch, so a
throwing converter drops the whole update rather than one screen.
```

That reaches `## Prior context` in `issue.md` and stays there. Said in a chat
message instead, it would be gone by the time `/pd:plan` runs in a new session
— and a requirement drawn from it is tagged `[operator]`, so later readers can
tell what the issue asked for from what you brought to it.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
cd <fork> && claude                 the fork, on main — starts on sonnet

/model opus                         ← switch 1: planning is opus
/effort high
/pd:triage 12345

/clear
/effort high
/pd:plan 12345                      still opus

/clear
/effort high
/pd:plan-review 12345               still opus
pdkit ids freeze 12345              your approval
pdkit state 12345 --to plan-approved

/clear
/model sonnet                       ← switch 2: sonnet from here to the PR
/effort medium
/pd:exec 12345                      moves the session into DESKTOP-12345

/clear
/pd:validate 12345                  still sonnet

/clear
/effort high
/pd:audit 12345                     still sonnet — pd-auditor is opus on its own

/clear
/effort medium
/pd:slice 12345
pdkit state 12345 --to slices-approved   your approval

/clear
/pd:preflight 12345

/clear
/pd:pr 12345                        one session per slice
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `/pd:triage 12345` | **new** · main checkout | opus | `pd-scout` · sonnet |
| `/pd:plan 12345` | **new** · main checkout | opus | `pd-scout` · sonnet |
| `/pd:plan-review 12345` | **new** · main checkout | opus | `pd-plan-critic` · opus |
| approve: `pdkit ids freeze`, `pdkit state --to plan-approved` | the plan-review session, or **terminal** | — | — |
| `/pd:exec 12345` | **new** · main checkout, then the skill moves it into `DESKTOP-12345` | sonnet | `pd-implementer` · sonnet, one per task |
| `/pd:validate 12345` | **new** · issue tree | sonnet | `pd-validator` · sonnet |
| `/pd:audit 12345` | **new** · issue tree | sonnet | `pd-auditor` · opus |
| `/pd:slice 12345` | **new** · issue tree | sonnet | `pd-slicer` · sonnet |
| approve: `pdkit state --to slices-approved` | the slice session, or **terminal** | — | — |
| `/pd:preflight 12345` | **new** · issue tree | sonnet | — |
| `/pd:pr 12345` | **new** · issue tree, one per slice | sonnet | — |

Two switches on this path: to opus for planning, back to sonnet at `/pd:exec`.
`/clear` keeps the model of the session before it, so the first `/pd:exec`
after `/pd:plan-review` is where a forgotten `/model sonnet` runs a whole
implementation on opus.

---

**The design** — [`/pd:plan`](../specification/04-contracts/plan.md), [`/pd:plan-review`](../specification/04-contracts/plan-review.md)

← [0 · Picking what to work on](00-picking-what-to-work-on.md) · [Contents](README.md) · [2 · A one-line fix](02-one-line-fix.md) →
