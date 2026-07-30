---
name: slice
description: "Turn one change set into a verified graph of atomic pull requests."
argument-hint: "<issue-number> [--from-pr <n>]"
disable-model-invocation: true
model: opus
---

Via `pd-slicer`, in fresh context, working from the finished diff.

Two graphs, and conflating them is the classic error: file independence is mechanical, symbol dependence is not. `pdkit slice verify --standalone` settles it — green means the slice branches from main, red means it needs a stack. Prefer independent.

Every slice must justify itself without the next one. Upstream does not accept dead code staged for a future PR.

With `--from-pr`, the input is a published diff instead of local HEAD: upstream sometimes asks for an open PR to be split.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
