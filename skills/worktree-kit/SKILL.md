---
name: worktree-kit
description: "Create, list, switch, and clean up git worktrees for parallel issue work, including .env copying and a shared pnpm store."
when_to_use: "Triggers when working on several issues at once, or when asked about worktrees, parallel branches, or a separate checkout."
---

One worktree per issue. State lives in `$PDKIT_HOME`, so every worktree sees the same state rather than its own copy — that is what makes parallel work safe here.

On cleanup, verify the branch is merged or abandoned before removing anything.

> Stub. Content is filled in from `knowledge/` as that base is written.
