---
name: audit
description: "Audit the diff against the plan in fresh context."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: opus
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
- tasks with no requirement.

This command reports and never decides. It exits zero whatever it finds.

## 2. The three questions

`pd-auditor` gets the report, the plan and `git diff main...HEAD`. It does not
get the implementer's account of the work — a summary of why the code is right
is the most persuasive thing in the room and the least evidential.

1. Which requirements have no code? (The map says which have no *task*. Whether
   the code under a task actually implements the requirement is the question.)
2. Which code answers no requirement?
3. What changed inside `Owns` that the task never asked for?

## 3. The verdict

`audit.md` under the issue: findings first, each with a file and a line, then
what the auditor could not judge by reading.

Two disciplines, both from the same failure mode. An auditor told to find
problems will find them in correct code, so: an empty findings section is a
valid result, and style is not a finding. And where you are uncertain, say
uncertain — fresh context catches drift from the plan, not blind spots shared
with the model that wrote the code.

## Then

`pdkit state <n> --to audited` when the findings are addressed or accepted.
Unaddressed findings are not a reason to skip the transition quietly — they go
in `audit.md` and the state stays where it is.

## Next

`/pd:slice <issue>` — the change set becomes a verified graph of atomic pull
requests, even when the graph turns out to have one node.
