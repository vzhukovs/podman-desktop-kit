# ISSUE {{issue}}: {{title}}

- Route: {{route}}            <!-- quickfix | standard | multi-slice | redo | invalid -->
- Nature: {{nature}}          <!-- bug | feature | enhancement | tech-debt | dep-bump | docs -->
- Size: {{size}}              <!-- trivial | standard | multi-slice -->
- Triaged: {{triagedAt}}

## Summary
{{summary}}

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

     A rework brings a fourth source: a requirement stated by a reviewer rather
     than by the issue. `[review]` is its tag, and it belongs in the table for
     the same reason the other three do — where a requirement came from decides
     how much argument it takes to change it. -->
<!-- [issue] stated in the issue · [paraphrase] reworded · [inferred] concluded
     by the plugin, read back before this file was written · [review] stated by
     a reviewer on a pull request -->


## Open questions
{{questions}}

## Verdict
{{verdict}}
