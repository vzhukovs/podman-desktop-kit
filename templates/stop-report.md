# STOP {{id}}: DESKTOP-{{issue}}

- Task: {{taskId}}
- Affects: {{affects}}
- Date: {{date}}
- Command: {{command}}
  <!-- Written by `pdkit task stop --finding <values.json>` when a task stops
       because the plan is wrong, not the code. It is the input to the
       amendment: the session that writes one starts from this file and
       plan.md, never from the context that produced the finding.

       Affects names every other live task the same cause reaches. `task stop`
       searches the plan for tasks whose `Done when` runs the same command or
       whose Owns holds a file named here, and refuses a report that leaves one
       of them out without a sentence under "Not affected". An amendment that
       fixed T11 and left T16 running the same broken command cost a third
       round. -->

## What is wrong
<!-- The defect in the plan, one paragraph, each claim with `file:line`. Not
     what the worker tried. -->
{{wrong}}

## Evidence
<!-- The command that shows it and what it printed, pasted, not summarized.
     If it fails on the base branch too, say so and show that run: it is what
     separates "the plan is wrong" from "the code is wrong". -->
{{evidence}}

## Not affected
<!-- Tasks the search above found that the cause does not reach, one line
     each with the reason. "—" when the search found nothing else. -->
{{unaffected}}

## Decision needed
<!-- What only a person can decide, with the options and what each costs. "—"
     when the fix is mechanical. -->
{{decision}}

## What the amendment should change
<!-- Per task: replace it (same Owns, new Done when or steps), add a task, or
     change a requirement. Concrete enough that `pdkit amendment draft` and the
     session that finishes the amendment have nothing to rediscover. -->
{{proposal}}
