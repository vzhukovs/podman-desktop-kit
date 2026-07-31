# PR #{{number}}: DESKTOP-{{issue}}

- Branch: `{{branch}}` → `{{base}}`
- Slice: {{slice}}
- State: {{state}}
- Review: {{reviewDecision}}, {{threadsOpen}} open thread(s) of {{threadsTotal}}
- Last activity: {{lastActivity}}
- Refreshed: {{refreshedAt}}

## CI

<!-- Rendered from prs.json by `pdkit pr render`. The verdict column is not
     yours to type, and that is the only reason it means anything.

     fail          — red here and green on other open PRs: this change did it
     inconclusive  — the same job is red on other people's PRs too. A warning,
                     not a block: refusing to proceed over something the change
                     did not do is how a gate teaches people to route around it
     flake         — the same job, the same commit, two different answers
     pending       — still running -->

Verdict: {{ciVerdict}}

| Job | Workflow | Conclusion | Verdict | Also red on |
|-----|----------|------------|---------|-------------|
{{jobs}}

## Threads

<!-- Bots are collapsed to one line, never dropped: a matched escalation word
     expands a thread back, and nothing a human wrote is ever collapsed.

     A thread that maps to no slice is listed under "unmapped" — either the
     reviewer found a requirement the plan missed, or the PR failed to explain
     itself, and both are worth knowing. -->

{{threads}}

## Reviews and comments

<!-- The blocking feedback is often not in a thread at all. -->

{{discussion}}

## What was done about it

<!-- One line per thread that was acted on: what changed, or why it was
     declined. Written when the replies are drafted, so the record of a
     conversation with a reviewer outlives the conversation. -->

{{resolutions}}
