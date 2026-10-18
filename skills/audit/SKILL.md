---
name: audit
description: "Audit the diff against the plan in fresh context."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: sonnet
effort: high
---

Via `pd-auditor`, which sees the diff and the plan and nothing else — not the
implementer's reasoning, which is exactly what would make it agree.

## Preconditions

`pdkit state <issue>` says `validated`. Auditing before validation means
auditing a diff nobody has run.

## 1. The facts

```
pdkit audit <n> --base main
```

State and route, the frozen requirement set, every task with its `Owns` and
`satisfies`, the state of every receipt, the changed files, and three findings
that need no judgement at all:

- **files changed outside every task's ownership** — the pre-write hook is
  silent when no task was ever started, so this is the only place such a change
  is certain to be seen;
- requirements with no task;
- tasks with no requirement;
- tasks no `pd-implementer` ran for, from the `agent-done` entries the journal
  tied to each task. A task started before the journal recorded any subagent
  is `not recorded`, which is not the same as none.

This command reports and never decides. It exits zero whatever it finds.

`pd-auditor` runs it, not this session. On a large issue the report lists
every task and every changed file, and that belongs in the context that reads
the diff.

## 2. The three questions

Dispatch `pd-auditor` with the issue number and the base, and nothing else.
It runs `pdkit audit` and reads `git diff main...HEAD` and the plan in its own
context. Do not read the diff here, not even to hand it over: the auditor's
context ends when it returns, and this session's is paid for again on every
turn until it ends. What comes back is the short form at the end of
`agents/pd-auditor.md`, and that is all this session needs.

It does not get the implementer's account of the work — a summary of why the
code is right is the most persuasive thing in the room and the least
evidential.

1. Which requirements have no code? (The map says which have no *task*. Whether
   the code under a task actually implements the requirement is the question.)
2. Which code answers no requirement?
3. What changed inside `Owns` that the task never asked for?

## 3. The verdict

`audit.md` under the issue is the auditor's answer as it came back: findings
first, each with a file and a line, then what it could not judge by reading.
Write it as returned. Opening the files to check a finding is reading the diff
here after all; a finding you doubt goes back to `pd-auditor` as a question.

Two disciplines, both from the same failure mode. An auditor told to find
problems will find them in correct code, so: an empty findings section is a
valid result, and style is not a finding. And where you are uncertain, say
uncertain — fresh context catches drift from the plan, not blind spots shared
with the model that wrote the code.

## Then

`pdkit state <n> --to audited` when the findings are addressed or accepted.
Unaddressed findings are not a reason to skip the transition quietly — they go
in `audit.md` and the state stays where it is.

## When the phase runs long

`budget.turns.audit` is low on purpose. The facts come from `pdkit audit`, the
reading from `pd-auditor`, and an audit that runs long is usually this session
reading the diff itself — the auditor's job, in its own context. The number is
a guide rather than a count anyone keeps. Past it, write what has been found to
`audit.md` and ask for a restart.

## Next

`/pd:slice <issue>` — the change set becomes a verified graph of atomic pull
requests, even when the graph turns out to have one node.

**In a new session.** Slicing works from the finished diff and from
`slice suggest`, and what it needs of the audit is in `audit.md`. The
conversation that produced the findings has no further vote, and carrying it
forward means paying for it on every turn of the slicing. `pdkit next <issue>`
prints the line.
