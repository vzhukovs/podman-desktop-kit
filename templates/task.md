# {{taskId}}: {{title}}

- Issue: {{issue}}
- Satisfies: {{satisfies}}
- Status: {{status}}
- Attempts: {{attempts}}
  <!-- The live count is not this line: `pdkit task attempts --issue <n>` reads
       it from the journal, where every failed capture of `Done when` is
       recorded. At exec.max_attempts the task is blocked — the completion hook
       and `pdkit task start` both refuse it — and the way past is
       `pdkit task unblock --task <T> --reason "<what is different this time>"`,
       which is a sentence a human writes. -->

## Owns
{{ownedFiles}}

## Done when
```bash
{{command}}
```
Expected: {{expected}}

## Context
{{context}}

## Steps
{{steps}}

## Notes
{{notes}}
