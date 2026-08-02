# RECEIPT {{taskId}}

- Issue: {{issue}}
- Completed: {{completedAt}}
- Commit: {{commit}}
- Exit code: {{exitCode}}
- Duration: {{durationMs}}ms
- Capture: {{capture}}
- Evidence: {{evidence}}
  <!-- Written by `pdkit receipt write`, which runs the command from `Done when`
       itself. There is no way to hand it output: the digest above is taken over
       the block below, so a receipt edited by hand stops validating. -->

## Command
```bash
{{command}}
```

## Output
<!-- Verbatim. Not summarized, not trimmed to the interesting part, not
     reformatted. The auditor's ability to distinguish "the tests passed" from
     "the agent believes the tests passed" depends entirely on this block being
     the real thing. `pdkit` spawns the command itself for the same reason:
     nothing sits between it and this block. -->
{{output}}

## Files changed
{{files}}
