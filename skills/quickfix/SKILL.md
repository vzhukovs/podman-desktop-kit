---
name: quickfix
description: "Small fix without the planning ceremony."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: sonnet
---

Planning is skipped deliberately: if the diff fits in one sentence, a plan is overhead.

No R-IDs — tracing goes by issue number, and the PR body carries `Fixes #<n>` instead of a coverage table. `Steps to check` is still required; size does not change what a reviewer needs.

If the fix outgrows the thresholds, escalate to the standard route. R-IDs are then derived from the issue, never from the diff you already wrote — IDs read off a finished diff describe what was built rather than what was required.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
