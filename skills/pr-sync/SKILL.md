---
name: pr-sync
description: "Process review feedback: triage threads, fix, reply, resolve."
argument-hint: "<pr-number>"
disable-model-invocation: true
model: opus
---

Collapse bot noise by default; escalate only what the config says to escalate.

Map every thread to a requirement, a slice, and a file. A thread that maps to nothing is a signal: either the reviewer found a requirement the plan missed, or the PR failed to explain itself. Both are worth knowing.

Classify each: accept, discuss, defer, reject. An accept that changes the plan produces an amendment, and the amendment goes to the user for approval before any code moves.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
