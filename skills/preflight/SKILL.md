---
name: preflight
description: "Run the deterministic gates and report pass or fail."
argument-hint: "<issue-number|slice>"
disable-model-invocation: true
model: sonnet
---

Runs `pdkit preflight` and presents the report. Do not interpret a failure into a pass, and do not re-run a check until it happens to succeed — a flaky check is a finding, not an obstacle.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
