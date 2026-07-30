---
name: plan-review
description: "Adversarial review of a plan, before any code is written."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: opus
---

Fresh context, via `pd-plan-critic`. The author of a plan is the worst reviewer of it.

Ask the question no phase asks by default: is this task necessary at all, and does something already do it?

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
