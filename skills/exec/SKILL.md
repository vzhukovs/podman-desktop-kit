---
name: exec
description: "Implement the plan, one task per worker, each producing a receipt."
argument-hint: "<issue-number> [task-id]"
disable-model-invocation: true
model: sonnet
---

One `pd-implementer` per task, fresh context each. A worker touches only the files in its `Owns` set — enforced by hook, not by instruction — and finishes by capturing the real output of the `Done when` command.

Follow the plan literally. A worker that improves on the plan is drift, and drift is what this whole structure exists to prevent.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
