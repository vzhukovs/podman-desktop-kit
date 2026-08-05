# SLICES: DESKTOP-{{issue}}

- Strategy: {{strategy}}
- Source: {{source}}
- Verified: {{verifiedAt}}
  <!-- This table is rendered from slices.json by `pdkit slice render`. The
       Standalone and Patch-comes-off columns come from runs pdkit performed
       itself; there is no way to type them in, which is the only reason they
       mean anything.

       `Patch comes off` is named for what it measures: the diff applies in
       reverse. It is not a claim that the build survives a revert, and it is
       not going to become one — measured, section 13, item H. -->

| # | Branch | Layer | Base | Files | R-IDs | Standalone | Patch comes off |
|---|--------|-------|------|-------|-------|------------|-----------------|
{{rows}}

## Merge order
{{mergeOrder}}

## Rationale per slice
<!-- Why separate: name the reviewer this slice is for, and why they are not the
     reviewer of the next one.

     Self-justifying without the next slice: yes and why — or no, in which case
     say "groundwork for #N" in the PR body and admit it here. Upstream does not
     accept dead code staged for a future PR, and hiding it does not make it
     land faster. -->
{{rationale}}
