# What reviewers actually ask for

Observed expectations of podman-desktop maintainers, and the review discipline
this plugin applies to other people's PRs.

> Stub. Harvested from real review threads as they accumulate.

## What maintainers ask for

- **Steps to check that actually work.** A reviewer who has to guess how to
  verify a change reviews it slowly or not at all.
- **One layer per PR.** Mixing a public API change with UI work means waiting
  for two sets of reviewers.
- **Tests for the behaviour claimed.** Not coverage for its own sake — coverage
  of what the PR says it does.
- **A reason, when the approach is not obvious.** Two sentences in the PR body
  prevent a round trip.

## Review discipline for PRs we review

From experience, stated plainly because it is easy to get wrong in the other
direction: **a reviewer told to find problems will find them in correct code.**

Therefore:

- Do not report style. That is what the linter is for.
- Do not request defensive code for states that cannot occur.
- Do not suggest a further abstraction. "This could be more general" is not a
  finding.
- **An empty section is a valid result.** A review that always finds something
  teaches authors to ignore reviews.
- `What I could not verify` is mandatory and rarely empty.

## Over-engineering checklist

Used by `pd-plan-critic` and `pd-review-architecture` when the ponytail server
is not available. Same questions, shorter form:

1. Is this task necessary at all?
2. Does something in the repository already do it? Check both `packages/main`
   and `packages/renderer` — utilities get duplicated across that boundary.
3. Is the abstraction earning its keep, or is it one caller wearing an
   interface?
4. Is there configuration for something that has never varied?
5. Would deleting this code make anything worse?

The one thing this checklist must not do is argue with upstream ceremony. SPDX
headers, sign-offs, scoped commits and detailed check steps look like bureaucracy
from a minimalist standpoint, and they are not optional.
