---
name: triage
description: "Triage an upstream podman-desktop issue: dedup, classify, draft requirements, and pick a route."
argument-hint: "<issue-number|url>"
disable-model-invocation: true
model: opus
---

Decide whether planning is needed at all. Half the value of this plugin is here.

Dedup first: an open PR or a revert changes the route before any analysis. Then classify nature and size, and draft requirements with a source tag on each — `[issue]`, `[paraphrase]`, `[inferred]`. Read the `[inferred]` list back before writing anything to disk; that is the cheap defence against requirements the plugin invented.

End with an explicit route: quickfix, standard, multi-slice, redo, or invalid.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
