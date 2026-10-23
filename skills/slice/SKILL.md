---
name: slice
description: "Turn one change set into a verified graph of atomic pull requests."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: sonnet
effort: medium
---

Via `pd-slicer`, in fresh context, working from the finished diff.

A slice is a **base plus a set of files**, not a set of commits. Verification
runs before any branch exists, so the only thing there is to build with is the
diff restricted to those files — and the same diff is what materializing a
slice applies back.

## Preconditions

`pdkit state <issue>` says `audited`. Slicing a diff nobody has audited means
cutting up work that may not match its plan.

Then, before the slicer is dispatched: `pdkit checkpoint <n> --phase slice`.
Slicing creates branches and a stored graph, and the checkpoint is what takes
them back if the cut turns out wrong.

## Who does what

Dispatch `pd-slicer` with the issue number (and `--from-pr <k>` when splitting
an open pull request). Steps 1–4 below are its work, in its own context: the
file map from `slice suggest`, the diff, the verify runs. None of it is read
here, not even to check the cut. The slicer's context ends when it returns;
this session's is paid for again on every turn until it ends, and on a large
issue the file map alone is thousands of tokens.

What comes back is the short form at the end of `${CLAUDE_PLUGIN_ROOT}/agents/pd-slicer.md`: one
line per slice with its verify result, then what was refused or warned about.
If it is not enough to decide on, ask the slicer again — `pdkit slice show
--issue <n>` prints the stored graph without the diff.

This session does **Then**.

## 1. The facts

```
pdkit slice suggest --issue <n> --json
```

Every changed file already mapped to its package, its layer, the task that owns
it, the R-IDs that task satisfies and the IPC channels its changed lines touch,
plus a draft grouped by layer. The draft is arithmetic and says so: grouping by
layer is mechanical, and whether a slice justifies itself alone is not.

`hypothesis` is the plan's cut: the slice count from its header and the
reasoning under `## Slice hypothesis`. **It is the starting proposal.** The
draft by layer is not: starting from it has produced three pull requests
where the plan had said one, and upstream rejected them for the plan's reason.

Do not re-derive that mapping by reading the diff. That is the set arithmetic
this command exists to do.

The diff is HEAD of the tree you are in, and a tree that is not the issue's is
refused with the command to run instead. `--ref <branch>` reads a branch without
checking it out; `--worktree DESKTOP-<n>` reads the issue's worktree from
anywhere. Whichever you use, `branch` in the JSON names what was read — and
`slice set` needs the same `--ref`/`--worktree`/`--from-pr` as `suggest`.

## 2. The cut

Write a proposal — one JSON file, one entry per slice:

```json
{ "strategy": "prefer-independent",
  "whyDeviates": null,
  "slices": [
    { "slug": "extension-api-run-options", "title": "add RunOptions",
      "files": ["packages/extension-api/src/extension-api.d.ts"],
      "baseSlice": null,
      "whySeparate": "public API contract; different reviewers",
      "selfJustifying": "yes — an optional field, no dead code" }
  ] }
```

**Every slice leaves main working on its own** — building, and with no feature
or built-in extension broken. That is the criterion everything below serves.

A change that is one concern across layers — an IPC signature through main,
preload and renderer — is **one slice with a commit per layer**:

```json
{ "slug": "image-by-engine-id", "title": "resolve images by engine and id",
  "files": ["packages/main/…", "packages/preload/…", "packages/renderer/…"],
  "baseSlice": null,
  "commits": [
    { "subject": "refactor(main): resolve images by engine and id", "files": ["packages/main/…"] },
    { "subject": "refactor(preload): pass engine and image ids", "files": ["packages/preload/…"] },
    { "subject": "refactor(renderer): call checker and files by id", "files": ["packages/renderer/…"] }
  ] }
```

The commits partition the slice's files, in order, lower layers first; each
subject is a conventional commit. The pull request's title carries every scope
(`refactor(main,preload,renderer): …`). commitlint accepts a comma-separated
scope, and upstream history uses it (`chore(ci,test): …`).

`whyDeviates` is required when the proposal has more slices than the plan's
hypothesis. It names what the diff shows that the plan could not see; "the
layers have different reviewers" is not that, because the plan knew the layers.

`baseSlice` is the **index** of another slice — `1`, not its slug. `null` means
it branches from `main`. Prefer `null`. A stack is fragile — after #1 merges,
#2 needs its base switched and its review threads point at moved lines — so
every stacked slice has to say why independence was impossible.

**And from a fork it cannot be published as a stack at all.** The base of a
pull request is a branch of the repository it opens against; a slice branch is
in your fork. So a stacked slice ships against `main` carrying the diff of the
slice below it until that one merges, and its body has to say so. `slice set`
warns when it sees this. It is a warning rather than a refusal because the
graph is still the right merge order — but it is the moment to ask again
whether the slice can stand alone, because it is the last cheap one.

```
pdkit slice set --issue <n> --from <file.json>
```

This refuses, by name, anything that cannot work: two slices sharing a file, a
changed file in no slice, a base that is not a slice or forms a cycle, a public
API change mixed into another layer or merging after it, an R-ID that reaches
no slice, an existing IPC channel whose two ends are in different slices
(`ipc-contract`), more slices than the plan said without `whyDeviates`
(`hypothesis`), and `commits` that do not partition their slice. Warnings —
spanning layers, going over the size threshold, a deviation from the plan with
its reason — are conversations, not refusals.

A refusal says where to go, and the proposal is not edited until it passes.
**Two slices sharing a file** is not something re-cutting fixes when the work
really has to change that file in two pull requests, one after the other. A
slice is the diff restricted to its files, so this model has no way to hold an
intermediate version of a file. Such work belongs in a separate issue that
must merge first (`pdkit issue draft-blocker`, then `pdkit issue block`).
**An R-ID that reaches no slice** means the task map lacks a task, which is an
amendment. Never drop a file from a slice, or a requirement from the plan, to
make the refusal go away.

Nothing is stored unless the whole graph holds.

## 3. The criterion

```
pdkit slice verify --issue <n> --all
```

File independence is mechanical and not sufficient. **Symbol** dependence —
slice B using something slice A introduced, or changing something A's consumers
use — is invisible in a file list, and this is the only thing that finds it:
each slice is built alone on `main`, in a worktree, with the repository's whole
typecheck, lint and the scoped tests. The whole typecheck rather than the
touched packages' own, because a type error lands in the consumer: a
preload-only slice can pass `typecheck:preload` and still break the renderer's
typecheck on upstream CI (`preflight.typecheck_scope`).

**Contract** dependence is invisible to the build as well, and `slice set` has
already refused the kind it can see (IPC channels). A slice that only works once
another merges is not independent because its build is green.

A slice with `commits` can also have each intermediate commit built:

```
pdkit slice verify --issue <n> --slice <i> --commits
```

That is information for the person, recorded as `commitChecks` and shown in
`slice show`; it gates nothing. Whether upstream wants every commit of a pull
request to build is an open question upstream, and the slice as a
whole is what preflight holds to green.

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

`Patch comes off` is a textual check, and the column is named for it: the diff
applies in reverse. It is not a claim that the build survives a revert, and it
is not going to become one — proving that costs a second full verify per slice,
and it would prove it against the tree of today rather than the one the revert
will meet.

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

## Joining slices that are already out

Review can ask for pull requests that only work together to become one: one
pull request with a commit per layer. The way there keeps the gate:

```
pdkit checkpoint <n> --phase slice
pdkit slice join --issue <n> --slices <i,j[,k…]> [--slug <s>] [--title <t>]
pdkit state <n> --to sliced --reason "<what review asked for>"
pdkit slice verify --issue <n> --all
pdkit slice verify --issue <n> --slice <joined> --commits
pdkit slice render --issue <n> --values <rationale.json>
```

`join` makes one slice whose commits are the joined slices, under the subjects
their branches were published with, and records the pull requests it replaces
(`supersedes`). Slices it renumbers keep their pull request and their branch. It
refuses a slice branch that review moved away from the change set, because
joining from the change set would drop that work, and prints the
`git checkout <branch> -- <file>` that brings it back to the working branch.

Then, as after any cut, the graph goes to a human: `slices-approved` is theirs.
`/pd:pr` publishes the joined slice as a new pull request. Closing the old ones
belongs to `/pd:pr-sync`, after the new one is open. It needs one reply token
per old pull request:

```
pdkit pr supersede <old> --by <new> --body <comment.md>             what would be posted
pdkit gate open --issue <n> --pr <old> --kind reply                 after the person read it
pdkit pr supersede <old> --by <new> --body <comment.md> --confirm
```

## When the answer is "this cannot be cut"

Say that. A diff whose parts cannot be separated without rewriting the work is
a finding about the plan — the design expects it (specification, section 11), and
"slicing requires redoing tasks T2–T4" is a real answer, not a failure to slice.

## When the phase runs long

`budget.turns.slice` is the ceiling, as a guide: you cannot count your own
turns exactly, and nothing else counts them. The graph is stored by `slice set`
and each verification by `slice verify`, so `pdkit slice show --issue <n>` in a
new session says exactly where this one stopped. Past the ceiling, ask for that
session rather than verifying on here.

## Next

Approval is the user's: `pdkit state <n> --to slices-approved`, and branches are
cut from it. Then `/pd:pr <issue>` per slice: it materializes the slice's branch
and runs preflight on it. `/pd:preflight` before that has no slice branch to
look at, and refuses.

**Each in a new session, and one per slice.** The approval can be given between
sessions — the graph waits on disk. Taking slices one session at a time keeps
the third from paying for the first two: context is re-read whole on every
call, so a slice published at the end of a long session costs what the whole
session did. `pdkit next <issue>` prints the line.

## When the phase went somewhere it should not

If this phase built on an option pdkit does not carry, or a refusal was routed
around before anyone noticed, go back to its start rather than patch forward:

```
pdkit rollback <n>              what would come back, and what stays
pdkit rollback <n> --confirm    after the person has read that
```

Branches return to their heads at the checkpoint, and a branch the phase
created is deleted. Either way the present tip is kept under
`refs/pdkit-backup/` first. Trees follow: one the phase created is removed,
one it removed comes back, and the main checkout returns to the branch it
stood on. A task left running is stopped. Uncommitted changes in any of those
trees refuse the whole rollback, by name: commit or stash them first.
Artefacts return from the copy, with the present ones archived. The state record comes back too. It is refused if the phase
moved the issue to another state, because a transition is not undone by
rewriting the record. What was published stays published, and the journal
keeps everything. Show the dry run in full and ask before `--confirm`. Then
run the phase again, in a new session.
