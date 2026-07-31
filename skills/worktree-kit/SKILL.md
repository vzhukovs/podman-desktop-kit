---
name: worktree-kit
description: "Create, list, switch, and clean up git worktrees for parallel issue work, including .env copying and a shared pnpm store."
when_to_use: "Triggers when working on several issues at once, or when asked about worktrees, parallel branches, or a separate checkout."
---

One worktree per issue. State lives in `$PDKIT_HOME`, keyed by issue, so every
tree sees the same state rather than its own copy — that is what makes parallel
work safe here rather than merely possible.

```
pdkit worktree create --issue <n> [--branch <b>] [--ref <r>]
pdkit worktree list
pdkit worktree remove --issue <n> [--force]
```

Trees go beside the fork (`worktrees.root`, default `../pd-worktrees`), never
inside it: a checkout under the repository shows up in `git status` and,
eventually, in a pull request.

`.env` and anything else in `worktrees.copy_files` is copied in on creation.
The pnpm store is global, so a fresh tree installs by hardlinking rather than
downloading — but `node_modules` is still per tree and still costs minutes on
this workspace. That is why the verification tree (`verify-DESKTOP-<n>`) is
reused between runs instead of recreated.

## What is per tree and what is not

- **Per tree**: the checkout, `node_modules`, and the *active task* — the
  pointer `pdkit task start` writes is keyed by working tree, so two trees can
  run two tasks of the same issue without either hook guarding the wrong files.
- **Shared**: everything under `$PDKIT_HOME` — state, plan, receipts, the slice
  graph, the journal, and consent tokens.

## Removal

`pdkit worktree remove` refuses while the tree holds a branch that has not
landed in `main`. Removing it takes the commits with it and leaves nothing that
says it happened, so `--force` is the way to say you meant to abandon them.

A tree git lists that is not on disk is a leftover, not a problem: `git worktree
prune`. `/pd:doctor` reports both.
