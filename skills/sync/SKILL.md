---
name: sync
description: "Report fork status against upstream and the state of every worktree."
disable-model-invocation: true
model: sonnet
---

Read-only. Never rebase, never push, never reset from here — this command
exists so the answer to "where am I" costs nothing and is always safe to ask.

## Steps

1. `pdkit doctor` — if anything required is red, stop and report it. Every
   later step assumes it.
2. `git fetch upstream --prune` and `git fetch origin --prune`.
3. For the base branch: `git rev-list --left-right --count upstream/main...main`.
   Report both numbers. Behind is normal; **ahead of upstream on `main` is not**
   — it means something was committed to the base branch, and it will follow
   every branch cut from it afterwards.
4. `git worktree list`, and for each: its branch, and `git status --porcelain`.
5. For each branch matching `DESKTOP-<n>/…`, run `pdkit state <n>` and report
   the state next to it.

## Report

One line per branch: branch, issue state, ahead/behind against `upstream/main`,
whether its tree is clean.

Call out anything that will bite later rather than only what is broken now:

- a `DESKTOP-…` branch with no state record, or a state record with no branch —
  the two have drifted apart;
- an uncommitted change: preflight refuses to report on a dirty tree, so this
  blocks the flow before it starts;
- a branch far behind `upstream/main` — it will rebase, and the further behind
  it is the more likely that rebase is semantic rather than mechanical.
