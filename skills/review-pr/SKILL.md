---
name: review-pr
description: "Review someone else's pull request along four parallel axes."
argument-hint: "<pr-number>"
disable-model-invocation: true
model: opus
---

Four agents in parallel — architecture, API compatibility, tests, product — then `pd-review-synth` to dedupe and reach a verdict.

Discipline, from experience: a reviewer told to find problems will find them in correct code. Do not report style. Do not ask for defensive code against impossible states. Do not suggest a further abstraction. An empty section is a valid result.

"What I could not verify" is mandatory.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
