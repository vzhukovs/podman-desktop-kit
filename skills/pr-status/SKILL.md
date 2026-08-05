---
name: pr-status
description: "Dashboard across all open pull requests: CI, review threads, staleness."
disable-model-invocation: true
model: sonnet
---

Read-only. Nothing here moves state, opens a token, or writes to GitHub.

## Steps

1. `pdkit pr list --json` — every registered pull request, with its CI verdict,
   review decision, open threads and how long it has been idle. This is local:
   it reports what was last read, not what GitHub says now, and every row ends
   with `read:<age>` saying which. A row marked `←` was read more than six hours
   ago; treat its verdict as a question, not an answer.

2. `pdkit pr refresh <k>` for each one worth looking at. That is what goes to
   GitHub, and it costs four requests per pull request — three when nothing is
   red. Measured: three seconds for a green one, seven for a red one, and a
   sweep of ten is 32 GraphQL points against an hourly budget of 5000. The
   budget is not what limits you; the thirty-seven seconds are.

   **Refresh by what you are about to act on, not by what looks recently
   touched.** A pull request's `updatedAt` does not move when CI finishes —
   measured across ten open PRs upstream, every one of the eight with recent
   runs had CI complete two to thirty-seven minutes *after* its `updatedAt`. So
   "nothing changed since yesterday" is not a reason to skip the refresh on the
   one whose CI you care about.

3. For anything with a red job: `pdkit pr ci <k>`. It prints the verdict and,
   for the jobs the measurement calls **yours**, the log around the failure —
   the window is anchored on `##[error]`, so what precedes it is the output
   that led there. Read it before saying anything about the cause. `--no-logs`
   is for the sweep across many pull requests, not for the one you are
   diagnosing.

## Reading the CI verdict, which is the only part that needs care

The verdict is measured, not guessed, and the distinction it draws decides
whether there is any work to do:

- **fail** — red here, green on other people's open pull requests. Yours.
- **inconclusive** — the same job is red on other PRs too. Not yours. Say so
  and name the neighbours; do not open an issue, do not "fix" it, and do not
  quietly treat it as a pass either.
- **flake** — the same job, the same commit, two different answers. Link the
  existing flake issue if there is one. **"Let us re-run it" is not a finding**:
  a re-run that goes green destroys the only evidence that it flaked.
- **pending** — still running. Check the age. podman-desktop has checks that sit
  IN_PROGRESS for months, and a job pending since June is a finding about the
  pull request, not about CI.

What is left for you: whether a red job is a platform difference or a real
regression, when the measurement does not settle it. Multi-platform CI makes a
Windows-only failure ordinary — so name the platform, and name what in the diff
could plausibly be platform-specific. If nothing in it could be, say that too.

Answer that from the log, not from the job's name. A job called "podman
desktop" was red on #18590 because `apt-get` had no candidate for
`qemu-user-static` — an infrastructure failure that no reading of the diff
would have found, and that the job name reads nothing like. When the log says
`(no ##[error] in this log — this is the end of it, not necessarily the
failure)`, treat what you have as the end of the file and say so; that is the
one case where opening the job in a browser is worth the interruption.

## Report

One line per pull request: number, issue, slice, state, CI verdict, review
decision, unresolved threads, days idle. Then, only for the ones that need
something:

- what is blocking it, in one sentence;
- whose turn it is — `CHANGES_REQUESTED` with no reply is the author's, a PR
  with everything answered is the reviewer's;
- the next command: `/pd:pr-sync <k>`, `/pd:resume <n>`.

Do not summarise the healthy ones beyond their line. A dashboard that says
something about everything is a dashboard nobody reads to the end.
