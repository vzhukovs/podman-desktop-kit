---
name: audit
description: "Audit the diff against the plan in fresh context."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: opus
---

Via `pd-auditor`, which sees the diff and the plan and nothing else — not the implementer’s reasoning, which is exactly what would make it agree.

Looking for: requirements with no code, code with no requirement, and changes outside the declared ownership.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
