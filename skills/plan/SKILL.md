---
name: plan
description: "Plan an issue: scout the code, resolve the open choices, and produce a plan with executable done-criteria."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: opus
---

Three phases.

Reconnaissance: at least three `pd-scout` agents in parallel, each with a different question. Do not read the code broadly yourself — the scouts return a map, and that compression is the point.

Choices: anything a scout flagged as a decision goes to the user. A question not asked becomes `[NEEDS DECISION]` in the plan, and that blocks approval.

Plan: every task owns its files exclusively, `Done when` is a command with expected output rather than prose, and every task declares which requirements it satisfies. Include the slice hypothesis — planning without it produces a diff that cannot be cut apart afterwards.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
