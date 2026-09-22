### What does this PR do?

<!-- Two to four sentences: what was wrong, what this changes, and why this way
     rather than the obvious alternative.

     Not the reasoning trail. The analysis that got here is the plan, the plan
     is not published, and a reviewer who wanted it would ask. On #19048 this
     section ran to 4336 characters of numbered argument; the same change is
     explainable in four sentences, and the four are what gets read.

     Budget: 600 characters. -->
{{what}}

**Where to look**
<!-- Point at the part that carries the logic, and say what the rest is.
     "40 lines of logic, the rest is mechanical renames" saves a reviewer more
     time than any amount of inline commentary.

     The value here is what a reviewer may SKIP. That is the opposite of
     listing the changes per file, which the diff already shows and which
     upstream has asked us not to restate.

     Budget: 300 characters. -->
{{whereToLook}}

**Not in this PR**
<!-- One line. On a sliced issue: what went into another slice, and which one —
     this is what stops a reviewer looking for the other half. On a single pull
     request there is no other half, and saying so takes one clause.

     Budget: 120 characters. -->
{{notInThisPr}}

### Screenshot / video of UI

<!-- Required when the PR changes UI. When it does not, say so and why rather
     than leaving the section empty: "n/a — no UI change" is an answer, an
     empty heading is a reviewer wondering whether it was forgotten.

     A description of a behaviour change is not a screenshot. If it is visible,
     show it; if it is not, this is one line.

     Budget: 200 characters. -->
{{uiEvidence}}

### What issues does this PR fix or reference?

{{issueReferences}}
<!-- The closing line, and nothing else.

       Closes #12345      <!-- last slice of a stack; "Part of #12345" in the rest
       Fixes #12345       <!-- quickfix route

     No requirement table. R-IDs are how this plugin tracks its own work — they
     mean nothing to a reviewer, who has the issue and the diff — and a table
     mapping them to files is the "changes per file" upstream asked us to drop.
     The trace lives in the issue record and in `prs/<k>.md`, where the people
     who need it can read it.

     Budget: 200 characters. -->

### How to test this PR?

<!-- Each step is an action and an expected result. A reviewer should not have
     to guess what they are looking for. Required regardless of diff size: a
     small change does not make a reviewer better at guessing.

     THE ONE SECTION WITH NO BUDGET. Everything else here is being cut; this is
     not. Commands to paste, fixtures to create, what should come back, and the
     cleanup afterwards — a reviewer executes this section rather than reading
     it, which is why it is the last place to save room.

     This is a comment rather than a blockquote on purpose. A blockquote
     renders, and a reviewer would be reading instructions addressed to the
     author. -->
{{steps}}

**Notes for reviewers**
<!-- Only what CI could not judge, and the platform you checked it on. That is
     the whole purpose: CI passing on something it never exercised reads as
     proof, which is worse than CI failing.

     Mandatory when preflight flagged build, packaging or platform-specific
     behaviour; one line or omitted otherwise.

     What does NOT go here, and where it goes instead: the review history
     (the pull request conversation has it), residual risks and design
     alternatives (a review comment, or the issue), behaviour nuance a reviewer
     cannot act on (nowhere). On #19048 this section reached 4215 characters
     that way.

     Budget: 400 characters. -->
{{notes}}

- [ ] Tests are covering the bug fix or the new feature

<!-- Filled in for you. The login comes from the `origin` remote of this clone,
     which `pdkit init` already read, so there is nothing to type and nothing to
     keep in step. When no login can be established the clause is left out
     rather than rendered empty: a footer may say less than usual, and must
     never name somebody who did not look.

     It is stated at all because a reviewer is entitled to know how a change
     reached them, and because the second half is the part that matters — a
     named person read this before it was opened. -->
<sub>Prepared with podman-desktop-kit (Claude Code Plugin){{reviewedBy}}</sub>
