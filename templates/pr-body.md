## What
{{what}}

{{closesOrPartOf}}
<!-- "Closes #N" only in the last slice of a stack. "Part of #N" in the rest. -->

## Requirement coverage
<!-- Replaced by a single "Fixes #N" line on the quickfix route, where no
     R-IDs exist. -->

| R-ID | Requirement | Where | Test |
|------|-------------|-------|------|
| R1 | {{requirement}} | `{{location}}` | `{{test}}` |

## Steps to check
> Each step is an action and an expected result. A reviewer should not have to
> guess what they are looking for. Required regardless of diff size — a small
> change does not make a reviewer better at guessing.

{{steps}}

## Where to look
<!-- Point at the part that carries the logic, and say what the rest is.
     "40 lines of logic, the rest is mechanical renames" saves a reviewer more
     time than any amount of inline commentary. -->
{{whereToLook}}

## Not in this PR
{{notInThisPr}}

## Notes for reviewers
<!-- Mandatory when preflight flagged something CI cannot verify: build,
     packaging, or platform-specific behaviour. Say which platform you checked
     manually. CI passing on something it never exercised reads as proof, which
     is worse than CI failing. -->
{{notes}}
