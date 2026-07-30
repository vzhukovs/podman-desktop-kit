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
| R1   | {{requirement}} | [issue] |

## Open questions
{{questions}}

## Verdict
{{verdict}}
