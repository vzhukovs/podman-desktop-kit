---
name: quickfix
description: "Small fix without the planning ceremony."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: sonnet
effort: medium
---

Planning is skipped deliberately: if the diff fits in one sentence, a plan is
overhead. Everything else about the discipline is unchanged.

## Preconditions

`pdkit state <issue>` says `triaged` and the route is `quickfix`. If triage
did not say that, this is the wrong command — go back to `/pd:triage`.

## Steps

1. `pdkit branch create --issue <n> --slug <short-description>`, then
   `pdkit state <n> --to quickfix`.

   The state move is not bookkeeping. `preflight-green` is reachable from
   `quickfix` and not from `triaged`, and the push gate is issued from
   `preflight-green` only — so an issue left in `triaged` reaches a green
   preflight and then cannot open the gate at all. Found on the first live run,
   after both passes were green.
2. **Read `${CLAUDE_PLUGIN_ROOT}/knowledge/maintainer-rules.md` first, all of
   it**: the calibration and sections 1 to 12. Upstream's review agent applies
   every one of them to a three-line fix exactly as it would to a
   three-hundred-line feature. No `pd-implementer` runs on this route, so the
   discipline written in `${CLAUDE_PLUGIN_ROOT}/agents/pd-implementer.md` under
   "Write it the way the maintainer reviews it" is this session's to follow.
   Read that section too. If the rules file cannot be read, stop: a fix
   written without it is the fix the review sends back.
3. Make the fix. Add or extend a test for it; "too small to test" is how a
   reviewer's first comment gets written for them.
4. `pdkit preflight <n> --only maintainer-rules`. A fail is a rule with no
   exception: change the code. A warning is a rule with its own condition:
   say in one sentence why the condition holds, or change the code. The
   self-review in `/pd:pr` reads the sentence.
5. Commit with a conventional subject and one `Signed-off-by`. Squash with
   `git reset --soft <base> && git commit` — never `rebase -i`, which the
   husky hook rejects for the duplicate sign-off it just created.
6. `pdkit preflight <n>` → hand over to `/pd:pr`.

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
- Every preflight check, `maintainer-rules` and `self-review` included. None of
  them is waived by the route being small.
- The PR body carries `Fixes #<n>`, and tracing goes by issue number.
- No e2e test. It inflates both review and CI time, which contradicts the one
  thing a small PR is for.

## Next

`/pd:pr <issue>` — the same gate, the same body, the same preflight. What was
skipped is planning, not publishing.

**In a new session**, small as this was. The session that made the fix has read
the code around it and the test output, and `/pd:pr` needs neither: the branch,
the commit and `preflight.json` are on disk. Publishing is where a person reads
the push command, and that is better done at the start of a short session than
at the end of a longer one. `pdkit next <issue>` prints the line.
