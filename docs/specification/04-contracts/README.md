# 4. Contracts of the key commands

[Specification](../README.md) › Section 4

One file per command, in the order this section has always listed them. The
table in [section 3](../03-commands.md) lists every command; this section holds
the contracts of the key ones.

| Command | Contract |
|---|---|
| [`/pd:triage`](triage.md) | the entry point that cannot be skipped; the `redo` route; batch mode with no number |
| [`/pd:plan`](plan.md) | the plan as the only handoff artefact |
| [`/pd:plan-review`](plan-review.md) | reviewing the plan before any code |
| [`/pd:validate`](validate.md) | evidence instead of claims |
| [`/pd:audit`](audit.md) | the diff against the plan |
| [`/pd:slice`](slice.md) | the part no reference has |
| [`/pd:pr`](pr.md) | the only place that writes to GitHub |
| [`/pd:pr-status`](pr-status.md) | the dashboard, and how a red CI is measured here |
| [`/pd:pr-sync`](pr-sync.md) | feedback from review |
| [`/pd:resume`](resume.md) | coming back after a break |
| [`/pd:close`](close.md) | the end of the cycle |
| [`/pd:reset`](reset.md) | starting one issue over |
| [`/pd:review-pr`](review-pr.md) | reviewing somebody else's pull request |
| [`/pd:knowledge`](knowledge.md) | revising what everything else leans on |

---

← [3 · Commands](../03-commands.md) · [Contents](../README.md) · [`/pd:triage`](triage.md) →
