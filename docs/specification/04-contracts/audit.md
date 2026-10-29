# `/pd:audit <issue>` — the diff against the plan

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:audit`

`pd-auditor` sees the diff and the plan and **does not see the implementer's
reasoning** — that is what makes it capable of disagreeing. The machine goes
first here too. `pdkit audit <n> [--base main] [--json]` collects facts and
reaches no verdict:

| Collected | Why |
|---|---|
| state, route, R-set and whether it is frozen | without the freeze, tracing means nothing |
| tasks with their `Owns` and `satisfies` | the map the diff is checked against |
| receipts: absent / invalid / non-zero exit | "done" without proof is visible before reading any code |
| changed files `base...HEAD` | |
| **files outside every `Owns`** | the auditor's third question, answered mechanically |
| R-IDs with no task, tasks with no R-ID | the first and second questions, at the level of the map |

Files outside `Owns` are the insurance against the hole in `pre-write`: the hook
says nothing when there is no active task, so an implementer launched around
`pdkit task start` is unconstrained. The hook catches it in time; the audit
catches it for certain.

What is left to the model: a requirement with code against it that is the wrong
code; code answering no requirement that nevertheless looks reasonable; a change
inside `Owns` that the task did not ask for. None of the three is greppable.

---

← [`/pd:validate`](validate.md) · [Contents](../README.md) · [`/pd:slice`](slice.md) →
