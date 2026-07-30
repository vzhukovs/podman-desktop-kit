---
name: resume
description: "Come back to an issue after a break: drift analysis, rebase, plan amendment."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: opus
---

Sync, then find which upstream commits since the branch point touched your files.

Classify conflicts: mechanical ones are resolved and journalled; semantic ones — upstream rewrote what the plan stood on — stop the flow and produce an amendment for approval.

After rebasing, re-run preflight and standalone verification. A previous green means nothing now.

This is the only place `--force-with-lease` is allowed, on your own branch, under a gate.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
