# Architecture

Short version. The full design, with the reasoning and the rejected
alternatives, is in
[`specs/podman-desktop-kit-architecture.md`](../specs/podman-desktop-kit-architecture.md).

## The constraint everything follows from

We work in a fork of a repository we do not own. That forbids three things other
workflow tools take for granted:

1. **State cannot live in the tree.** It would show up in a diff and then in a
   pull request. State lives in `$PDKIT_HOME`, keyed by issue number — which
   also means several worktrees share one state rather than each keeping a copy.
2. **We cannot open scratch issues.** Tools that store epics as GitHub issues
   assume they own the repository. Our source of truth is local files.
3. **A careless push is public.** Hence the gate.

## The pieces

| Piece | Role |
|---|---|
| `bin/pdkit` + `lib/` | everything deterministic: state machine, IDs, slicing, gates, preflight |
| `skills/` | the workflow surface — what you invoke |
| `agents/` | bounded workers with their own context |
| `hooks/` | the rules that a prompt cannot guarantee |
| `knowledge/` | upstream constitution, shipped with the plugin |
| `templates/` | the shape of every artefact |

The split is not stylistic. Anything that must be **true** is in `lib/` and
`hooks/`, where it can be tested. Anything that requires **judgement** is in
`skills/` and `agents/`. A rule stated only in a prompt is a rule that holds
most of the time.

## What the slicer is, in one paragraph

A slice is a base plus a set of files. It is verified before any branch exists,
by applying the diff restricted to those files to a scratch worktree from
`main` and running the repository's own typecheck, lint and tests there. Green
means it branches from `main`; red means it needs a stack, and the red run is
the evidence for that stack. The result is produced by `pdkit` and stored with
the digest of the diff it describes, so preflight can ask later whether it is
still about this diff — which is also how a materialized branch is checked
against what was verified. Nothing in that sentence has a parameter an agent
could supply.

## Why hooks rather than instructions

Three things are enforced rather than requested, and each closes a failure that
was actually observed:

- **The push gate.** `git push` and `gh pr create` are denied without a
  short-lived token for that exact branch.
- **File ownership.** A worker writing outside its task's `Owns` set fails.
  This turns the ownership map from a request into an invariant and removes a
  class of merge conflicts rather than resolving them.
- **Receipts.** A task cannot be marked complete without captured command
  output.

## Known weaknesses

Stated rather than discovered later:

- A fresh-context auditor of the same model catches drift from the plan, not
  blind spots shared with the model that wrote the code.
- Slicing a finished diff is expensive. That is why the plan carries a slice
  hypothesis.
- `Reverts cleanly` is a textual check: the patch comes off. Whether the build
  survives a revert costs another full run per slice, and is not claimed.
- Stacked PRs are fragile, which is why independent slices are the default.
- Consent fatigue is real. The gate prints the PR body and branch list rather
  than a yes/no prompt, because that is the thing worth reading.
