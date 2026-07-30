# SLICES: DESKTOP-{{issue}}

- Strategy: {{strategy}}
- Verified: {{verifiedAt}} by `pdkit slice verify --all`

| # | Branch | Layer | Base | Files | R-IDs | Standalone | Reverts cleanly |
|---|--------|-------|------|-------|-------|------------|-----------------|
| 1 | {{branch}} | {{layer}} | main | {{fileCount}} | {{requirements}} | {{standalone}} | {{reverts}} |

## Merge order
{{mergeOrder}}

## Rationale per slice

### #1 {{title}}
- Why separate: {{whySeparate}}
- Self-justifying without the next slice: {{selfJustifying}}
  <!-- If no: either re-cut, or state "groundwork for #N" in the PR body and
       admit it here. Upstream does not accept dead code staged for a future
       PR, and hiding it does not make it land faster. -->
- Steps to check: {{stepsToCheck}}
