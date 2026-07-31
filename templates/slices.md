# SLICES: DESKTOP-{{issue}}

- Strategy: {{strategy}}
- Source: {{source}}
- Verified: {{verifiedAt}}
  <!-- This table is rendered from slices.json by `pdkit slice render`. The
       Standalone and Reverts columns come from runs pdkit performed itself;
       there is no way to type them in, which is the only reason they mean
       anything. Reverts cleanly is a TEXTUAL check — the patch comes off. It
       does not claim the build survives the revert. -->

| # | Branch | Layer | Base | Files | R-IDs | Standalone | Reverts cleanly |
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
