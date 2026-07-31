---
name: slice
description: "Turn one change set into a verified graph of atomic pull requests."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: opus
---

Via `pd-slicer`, in fresh context, working from the finished diff.

A slice is a **base plus a set of files**, not a set of commits. Verification
runs before any branch exists, so the only thing there is to build with is the
diff restricted to those files — and the same diff is what materializing a
slice applies back.

## Preconditions

`pdkit state <issue>` says `audited`. Slicing a diff nobody has audited means
cutting up work that may not match its plan.

## 1. The facts

```
pdkit slice suggest --issue <n> --json
```

Every changed file already mapped to its package, its layer, the task that owns
it and the R-IDs that task satisfies, plus a draft grouped by layer. The draft
is arithmetic and says so: grouping by layer is mechanical, and whether a slice
justifies itself alone is not.

Do not re-derive that mapping by reading the diff. That is the set arithmetic
this command exists to do.

## 2. The cut

Write a proposal — one JSON file, one entry per slice:

```json
{ "strategy": "prefer-independent",
  "slices": [
    { "slug": "extension-api-run-options", "title": "add RunOptions",
      "files": ["packages/extension-api/src/extension-api.d.ts"],
      "baseSlice": null,
      "whySeparate": "public API contract; different reviewers",
      "selfJustifying": "yes — an optional field, no dead code" }
  ] }
```

`baseSlice: null` means it branches from `main`. Prefer that. A stack is
fragile — after #1 merges, #2 needs its base switched and its review threads
point at moved lines — so every stacked slice has to say why independence was
impossible.

```
pdkit slice set --issue <n> --from <file.json>
```

This refuses, by name, anything that cannot work: two slices sharing a file, a
changed file in no slice, a base that is not a slice or forms a cycle, a public
API change mixed into another layer or merging after it, an R-ID that reaches
no slice. Warnings — spanning layers, going over the size threshold — are
conversations, not refusals.

Nothing is stored unless the whole graph holds.

## 3. The criterion

```
pdkit slice verify --issue <n> --all
```

File independence is mechanical and not sufficient. **Symbol** dependence —
slice B using something slice A introduced — is invisible in a file list, and
this is the only thing that finds it: each slice is built alone on `main`, in a
worktree, with typecheck, lint and the scoped tests.

**Green standalone → the slice branches from `main`. Red → it needs a stack,
and the red run is the evidence for the stack, not something to hide.** Move it
onto the slice that introduces what it uses and verify again.

The result is written by `pdkit`, with the run attached under `verify/S<i>.md`.
There is no way to hand it a verdict, which is the only reason the ✅ in
`slices.md` means anything.

## 4. The document

```
pdkit slice render --issue <n> --values <rationale.json>
```

The table comes from the graph; your values fill the prose. Per slice: who
reviews it and why they are not the reviewer of the next one, and whether it
stands up alone. If it does not — either re-cut, or write "groundwork for #N"
in the PR body and admit it here. Upstream does not accept dead code staged for
a future PR, and hiding it does not make it land faster.

`Reverts cleanly` is a textual check: the patch comes off. It is not a claim
that the build survives the revert, and the template says so.

## Then

`pdkit state <n> --to sliced`, show the graph, and stop. `slices-approved` is a
human's to give, and branches are cut from it — `pdkit slice materialize`
refuses before it.

## Splitting a pull request that is already open

Scenario 13: upstream asks for a published pull request to be split. Same
slicer, different source —

```
pdkit slice suggest --issue <n> --from-pr <k>
```

fetches `refs/pull/<k>/head` and takes the base from where that pull request
branched, not from where upstream is now. It works on a pull request that is
not ours, which is the point.

Once the new graph is set, `pdkit pr threads <k>` names the slice each existing
review thread belongs to — that is the migration plan, and it is the same
mapping the sync uses. Say in each new pull request body where the discussion
came from, and reply in the original thread pointing at the new PR before the
old one is closed. A reviewer who has to find their own comments again is a
reviewer who reviews it as new work.

## When the answer is "this cannot be cut"

Say that. A diff whose parts cannot be separated without rewriting the work is
a finding about the plan — section 11 of the spec expects it, and "slicing
requires redoing tasks T2–T4" is a real answer, not a failure to slice.
