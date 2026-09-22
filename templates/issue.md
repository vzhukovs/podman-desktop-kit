# ISSUE {{issue}}: {{title}}

- Route: {{route}}            <!-- quickfix | standard | multi-slice | redo | invalid -->
- Nature: {{nature}}          <!-- bug | feature | enhancement | tech-debt | dep-bump | docs -->
- Size: {{size}}              <!-- trivial | standard | multi-slice -->
- Triaged: {{triagedAt}}

## Summary
{{summary}}

## Prior context
<!-- What arrived with the command, verbatim: anything typed after the first
     line of `/pd:triage <n>` is recorded here as it was written.

     Verbatim and not summarised. A summary is the plugin's reading of it, and
     a wrong reading does not stay in one place — it reaches the plan, the
     tasks and the audit as a record everything downstream trusts. The same
     reason the [inferred] requirements are read back before this file is
     written.

     What belongs here: work already related to this one, an approach to repeat
     or to avoid, a trap somebody hit last time, pull requests worth reading
     first. What does not: anything the issue itself says — that is Summary.

     `none given` when nothing came with the command. Most triages will say
     that, and it is an answer; an empty section reads as forgotten rather than
     as absent. -->
{{priorContext}}

## Dedup
<!-- Open PRs referencing this issue, closed PRs, reverts. An existing PR or a
     revert changes the route before any analysis happens. -->
{{dedup}}

## Affected packages
{{packages}}

## Requirements
<!-- Source tag on every line. [inferred] items are read back to the user
     before this file is written — that is the defence against requirements
     the plugin invented rather than found.
     On the quickfix route this section is empty: tracing goes by issue
     number and no R-IDs are allocated. -->

| R-ID | Requirement | Source |
|------|-------------|--------|
{{requirements}}
<!-- One row per requirement, tag included: `| R1 | … | [issue] |`. The table
     used to hard-code a single row with the tag baked in, which meant the R-set
     — the thing the whole trace hangs on — could only be written down for an
     issue that had exactly one requirement. Found while planning DESKTOP-17221,
     which has four.

     Two sources beyond the issue itself. A rework brings `[review]` — a
     requirement stated by a reviewer rather than by the issue. Prior context
     brings `[operator]` — one stated by whoever started the triage, in the same
     message as the command. Both belong in the table for the same reason the
     first three do: where a requirement came from decides how much argument it
     takes to change it. Neither may be folded into `[issue]`, which means the
     issue text says it and a maintainer can be pointed at the line. -->
<!-- [issue] stated in the issue · [paraphrase] reworded · [inferred] concluded
     by the plugin, read back before this file was written · [review] stated by
     a reviewer on a pull request · [operator] stated with the command that
     started this triage, and recorded under Prior context -->


## Open questions
{{questions}}

## Verdict
{{verdict}}
