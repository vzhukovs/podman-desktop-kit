# Review: PR #{{pr}} — {{title}}

Verdict: {{verdict}}       <!-- APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES | NEEDS_DISCUSSION -->
Confidence: {{confidence}} <!-- high | medium | low — and why -->

## Requirement fit

| Issue requirement | Covered | Where |
|-------------------|---------|-------|
| {{requirement}} | {{covered}} | {{where}} |

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
