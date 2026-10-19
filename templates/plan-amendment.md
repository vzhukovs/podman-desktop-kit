# AMENDMENT A{{index}}: DESKTOP-{{issue}}

- Raised by: {{source}}     <!-- review thread, upstream drift, validation finding -->
- Date: {{date}}
- Status: {{status}}        <!-- proposed | approved | rejected -->

## What changed upstream or in review
{{trigger}}

## Requirements affected
<!-- New R-IDs continue the existing numbering. Existing ones are never
     renumbered: every trace from requirement to commit to PR table would
     break at once.

     One row per change, from the `rows` array in the values file:
       {"rid": "R7" | ["R2", "R6"], "change": "<word>", "detail": "<why>"}
     Change is one of: added | withdrawn | unchanged | superseded by R<k> |
     replaced by R<k>. `pdkit amendment approve` applies the table to the
     issue's requirement set and to the plan's Requirements line, and refuses a
     word outside that list rather than guessing what it means. -->

| R-ID | Change | Detail |
|------|--------|--------|
{{rows}}

## Slices affected
{{slices}}

## Why the original plan no longer holds
{{rationale}}

## Approval
<!-- Nothing moves until this is approved. An amendment applied silently makes
     the plan a record of what happened rather than what was intended. -->
{{approval}}
