# RECEIPT {{taskId}}

- Issue: {{issue}}
- Completed: {{completedAt}}
- Commit: {{commit}}

## Command
```bash
{{command}}
```

## Output
<!-- Verbatim. Not summarized, not trimmed to the interesting part, not
     reformatted. The auditor's ability to distinguish "the tests passed" from
     "the agent believes the tests passed" depends entirely on this block being
     the real thing. Captured with rtk disabled for the same reason. -->
```
{{output}}
```

- Exit code: {{exitCode}}
- Duration: {{durationMs}}ms

## Files changed
{{files}}
