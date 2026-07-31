### What does this PR do?

{{what}}

**Where to look**
<!-- Point at the part that carries the logic, and say what the rest is.
     "40 lines of logic, the rest is mechanical renames" saves a reviewer more
     time than any amount of inline commentary. -->
{{whereToLook}}

**Not in this PR**
<!-- Explicitly: what went into another slice, and which one. -->
{{notInThisPr}}

### Screenshot / video of UI

<!-- Required when the PR changes UI. When it does not, say so and why rather
     than leaving the section empty: "n/a — no UI change" is an answer, an
     empty heading is a reviewer wondering whether it was forgotten. -->
{{uiEvidence}}

### What issues does this PR fix or reference?

{{issueReferences}}
<!-- One section, two shapes, and never both — writing them separately is how
     "Closes #N" and "Fixes #N" end up in the same body.

     Standard route: the closing line plus the coverage table.

       Closes #12345      <!-- last slice of a stack; "Part of #12345" in the rest
       
       | R-ID | Requirement | Where | Test |
       |------|-------------|-------|------|
       | R1   | …           | `packages/main/src/…:118` | `…spec.ts:44` |

     Quickfix route: one line, `Fixes #12345`. There are no R-IDs and no table
     — tracing goes by issue number. -->

### How to test this PR?

<!-- Each step is an action and an expected result. A reviewer should not have
     to guess what they are looking for. Required regardless of diff size: a
     small change does not make a reviewer better at guessing.

     This is a comment rather than a blockquote on purpose. A blockquote
     renders, and a reviewer would be reading instructions addressed to the
     author. -->
{{steps}}

**Notes for reviewers**
<!-- Mandatory when preflight flagged something CI cannot verify: build,
     packaging, or platform-specific behaviour. Say which platform you checked
     manually. CI passing on something it never exercised reads as proof, which
     is worse than CI failing. -->
{{notes}}

- [ ] Tests are covering the bug fix or the new feature
