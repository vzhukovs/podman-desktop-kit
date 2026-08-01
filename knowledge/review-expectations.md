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

## How upstream routes a review, and what its red check means

`podman-desktop-triager` labels every pull request by the areas its files
belong to — `domain/<area>/inreview` — assigns the reviewers who own those
areas, and swaps the label to `domain/<area>/reviewed` once they approve.

The `Domain Review Status` check follows those labels: it sits unfinished while
any `inreview` label remains and goes green when the last one flips. Measured
across the open pull requests on 2026-08-01: every one carrying an `inreview`
label had it IN_PROGRESS, the one carrying `reviewed` had it SUCCESS.

Two consequences worth stating, because both are easy to read backwards:

- **It is not a build.** Nothing in a diff makes it go green, and re-running it
  achieves nothing. It is a review state expressed as a check.
- **It will still say the same tomorrow.** Unlike a queued job, it does not
  resolve on its own — which is why `pdkit pr list` reports it as
  `awaiting-review` with the domains named, rather than as `pending`.

Practical: touching fewer areas means fewer domains, and fewer domains means
fewer people who must all say yes. That is the same argument as one layer per
pull request, arriving from the labels rather than from taste.

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

## What to add here

An expectation a maintainer actually stated, on a real pull request, with a
pointer to where they said it. Not what reviewers are generally believed to
want — this file is read as settled, so an inference recorded here becomes a
rule nobody re-examines.

The over-engineering checklist grows the same way: a question that would have
changed a decision, not one that sounds prudent.
