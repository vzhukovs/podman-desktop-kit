# Review: PR #{{pr}} — {{title}}

Verdict: {{verdict}}       <!-- APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES | NEEDS_DISCUSSION -->
Confidence: {{confidence}} <!-- high | medium | low — and why -->

## Requirement fit

<!-- One row per requirement, pipes and all: an array of
     `| requirement | covered | where |` strings, or one string with newlines
     between the rows. Not three placeholders — an issue with eight
     requirements is the normal case, not the awkward one. The comment sits
     above the table rather than inside it: a comment between the delimiter row
     and the body ends the table in most renderers. -->
| Issue requirement | Covered | Where |
|-------------------|---------|-------|
{{requirementFit}}

## Blocking (correctness, compatibility, data loss)
{{blocking}}

## Should fix before merge
{{shouldFix}}

## Nits (author's discretion)
{{nits}}

## Questions for the author
{{questions}}

## What I could not verify
<!-- Mandatory, and never empty by default. What cannot be established by
     reading, which steps need a human, which platform was not exercised.
     A review that reads as complete when it is not is worse than one that
     admits its edges. -->
{{couldNotVerify}}
