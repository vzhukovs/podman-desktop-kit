---
name: pr
description: "Create branches and pull requests. The only command that writes to GitHub."
argument-hint: "<issue-number> [slice]"
disable-model-invocation: true
model: opus
---

Order matters and is not negotiable:

1. Verify every slice standalone. Red stops everything.
2. Per slice: branch, squash with `git reset --soft <base> && git commit` — never `rebase -i`, which Husky breaks — then preflight, then render the PR body.
3. Show the user the branches, the exact push commands, and the full PR bodies.
4. Wait for explicit confirmation in the same turn. Confirmation for slice #1 is not confirmation for slice #2.
5. Only then open the gate, push, and create the PR.

Step 4 is not automatable and does not carry across turns.

> Stub. The full procedure lands with its stage — see section 12 of
> `specs/podman-desktop-kit-architecture.md`.
