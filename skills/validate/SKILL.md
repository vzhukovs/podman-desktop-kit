---
name: validate
description: "Drive the built application, collect evidence, and propose an e2e test."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: sonnet
---

Evidence or nothing. Reading the source and concluding it works is explicitly not validation, and PASS may not be set on that basis.

Without Playwright available, produce a human checklist and say plainly that no PASS was recorded.

Second output: a candidate test for `tests/playwright`. A manual checklist is verified once; a test is verified on every future PR.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
