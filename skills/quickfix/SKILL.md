---
name: quickfix
description: "Small fix without the planning ceremony."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: sonnet
---

Planning is skipped deliberately: if the diff fits in one sentence, a plan is
overhead. Everything else about the discipline is unchanged.

## Preconditions

`pdkit state <issue>` says `triaged` and the route is `quickfix`. If triage
did not say that, this is the wrong command — go back to `/pd:triage`.

## Steps

1. `pdkit branch create --issue <n> --slug <short-description>`.
2. Make the fix. Add or extend a test for it; "too small to test" is how a
   reviewer's first comment gets written for them.
3. Commit with a conventional subject and one `Signed-off-by`. Squash with
   `git reset --soft <base> && git commit` — never `rebase -i`, which the
   husky hook rejects for the duplicate sign-off it just created.
4. `pdkit preflight <n>` → hand over to `/pd:pr`.

## The thresholds are the point

From `quickfix` in the config: 20 changed lines, 3 files, and nothing under
`packages/extension-api/**` or matching `**/*.schema.*`.

If the fix outgrows them, **stop and escalate** — `pdkit issue escalate <n>`.
That returns the issue to `triaged` and clears the route, so planning runs
properly and R-IDs are allocated from the issue's requirements.

The ordering matters and is not bureaucracy: R-IDs derived from a diff you
have already written describe what you built, not what was required, and the
whole trace becomes self-confirming. Escalating means re-deriving requirements
from the issue, with the code you wrote as evidence rather than as the answer.

## What does not change on this route

- `Steps to check` in the PR body, at least three, each with an expected
  result. Size does not make a reviewer better at guessing.
- Every preflight check except `r-coverage`, which skips because no R-IDs
  exist and tracing goes by issue number.
- The PR body carries `Fixes #<n>` instead of a coverage table.
- No e2e test. It inflates both review and CI time, which contradicts the one
  thing a small PR is for.
