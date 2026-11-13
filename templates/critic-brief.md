# PLAN CRITIC BRIEF: DESKTOP-{{issue}} — round {{round}}
<!-- Rendered by `pdkit plan brief <n>` and handed to pd-plan-critic as it is.
     The orchestrator may append one section, `## Orchestrator facts`: facts it
     verified, each with `file:line`. Never where to look, and never how much
     to find.

     Why a template and not a prompt: written by hand each round, a prompt
     varies in what it happens to mention, and the critic's findings follow
     it — a hint toward one area finds things there, a request to converge
     finds nothing. What the critic checks is its own checklist, in
     agents/pd-plan-critic.md; what this brief carries is the same facts
     every round.

     Rendered with comments stripped: everything in a comment is for whoever
     maintains this file, not for the critic. -->

## Mode

{{mode}}

## Scope

<!-- The tasks this critic reviews. Today always the whole plan; a scope
     narrower than that fills in its name and its task list here. -->
{{scope}}

## Where things are

- Plan: {{planPath}}
- Tasks: {{tasksPath}}
- Research: {{researchPath}}
- Issue: {{issuePath}}
- Worktree: {{worktree}}
- Base commit: {{base}}

## `pdkit plan check`

The mechanical half of the review, already run. Each red probe is a question
for you: red because the code is not written yet, or red regardless.

```text
{{check}}
```

## Earlier rounds

### Accepted in the last round — check that each one is in the plan

{{accepted}}

### Rejected — not to be raised again

A finding about a change made since it was rejected is a new item, not one of these.

{{rejected}}

## Changes since the last round

<!-- A delta round reviews what changed: the diff of plan.md and tasks/ since
     the last round goes here. Until one is recorded, the change is the last
     round's accepted decisions. A full round has nothing here. -->
{{changes}}

## The report

Language: (the orchestrator writes the language the person reads on this line)

Title it `# PLAN REVIEW: DESKTOP-{{issue}} — round {{round}}`, then these
sections, in this order. Each item is a `### A1. <the finding in one line>`
heading, and every claim in it carries a `file:line`.

- `## A — must change before approval`: A1, A2…
- `## B — worth discussing`: B1…
- `## C — cannot be judged from the plan alone`: C1…, each with what would decide it.
- `## Decisions of the last round`: one line per item under "Accepted in the
  last round" above: in the plan, or not, with `file:line`. Left out when that
  list is empty.
- `## Probes`: one line per red probe in the check report — red because the
  code is not written yet, or red regardless, and why.
- `## Checked, no findings`: what you checked that held, each with `file:line`,
  so the next round does not read it again.
