---
name: preflight
description: "Run the deterministic gates and report pass or fail."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: sonnet
---

Runs `pdkit preflight` and presents the report. The checks decide; this skill
reports and, where a failure is unambiguous, offers to fix it.

## Steps

1. `pdkit preflight <issue>` — the full set. It runs the repository's real
   test, lint and typecheck scripts, so it takes minutes on podman-desktop.
2. Once a PR body exists: `pdkit preflight <issue> --body-only --body <file>`.
   Four checks read the body, and re-running the whole suite to re-read a
   paragraph is minutes of nothing.
3. Present the report as it came. Show the `remedy` line for every failure —
   it is where the check says what to do.

## Discipline

**Do not interpret a failure into a pass.** Not "this looks like a flake", not
"this is pre-existing", not "unrelated to our change". If it is any of those,
that is a finding to report, not a reason to move on.

**Do not re-run a check until it happens to succeed.** A check that passes on
the third run is a flake, and a flake found here is worth more than a green
report — it is the one thing you can still cheaply investigate.

**A skip is not a pass.** Read the reason. `steps-to-check` skipping because
no body exists yet means that check has not run at all, and the second pass is
what makes it real.

**`working-tree` red stops everything.** While the tree is dirty the file
checks read the commit and the command checks read the disk, so nothing else
in the report means what it says.

## What you may fix without asking

Lint failures that `lint:fix` resolves, and a missing SPDX header — the check
prints the exact block. Re-run afterwards.

Everything else goes back to the user with the output attached.
