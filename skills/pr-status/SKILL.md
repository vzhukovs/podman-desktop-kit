---
name: pr-status
description: "Dashboard across all open pull requests: CI, review threads, staleness."
disable-model-invocation: true
model: sonnet
---

Read-only. For a red CI, distinguish a platform-specific failure from a flake from a real regression — podman-desktop runs multi-platform CI and Windows-only failures are normal. A flake gets a link to the existing issue, not a re-run.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
