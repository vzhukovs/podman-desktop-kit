# `/pd:slice <issue>` — the part no reference has

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:slice`

Works from a **finished diff**, in fresh context (`pd-slicer`). Input:
`git diff main...HEAD --stat`, `plan.md`, `package-map.json`.

**The requirement every cut serves: each slice, merged alone, leaves `main`
building and working.** A body that says "merge #A → #B → #C" is not a
substitute, because main is broken between those merges (podman-desktop#19831,
where upstream rejected three pull requests on exactly that).

**The plan's cut comes first.** `slice suggest` carries the plan's slice
hypothesis, count and reasoning, and `slice set` refuses more slices than it
names unless the proposal says why (`whyDeviates`). The reason is rendered into
`slices.md`. On DESKTOP-19818 the plan said one slice, the slicer never read it,
and the draft by layer became three pull requests.

Three different graphs, not to be confused:

- **file independence** — slices do not share files. Checked mechanically.
- **symbol dependence** — slice B references a symbol slice A introduced, or
  changes one A's consumers read. Not visible in the file lists at all.
- **contract dependence** — the two ends of a contract no compiler sees across.
  An IPC channel is a string: the handler in main and the call in preload
  compile whatever the other side does. `lib/contracts.js` reads which channels
  a file's changed lines belong to, and `slice set` refuses an existing channel
  split across slices (`ipc-contract`). A new channel split across a stack is a
  warning; split across independent slices it is refused.

A criterion, not an opinion: `pdkit slice verify` raises a worktree from `main`,
applies **only this slice**, and runs the repository's **whole** typecheck, lint
and scoped tests there. **Green standalone → the slice is independent and
branches from `main`. Red → it needs a stack, and `base` is the preceding
slice.** Independence is preferred; a stack is the exception.

The typecheck is the whole repository's because a type error lands in the
package that consumes a change. Scoped to the touched packages, it cleared a
preload-only slice on DESKTOP-19818 that upstream CI's typecheck then failed in
the renderer, and preflight cleared it the same way. `preflight.typecheck_scope:
packages` narrows both again, and says so in the result.

**There is a third verdict, and leaving it unsaid cost a run.** A red slice has
two possible causes and they are not the same finding: the slice broke something,
or the base does not pass that command either. The second is a false accusation —
the exact mirror of a false green — so it is measured rather than assumed:
`baselineFor` resets the same tree to the base, prepares it the same way, runs the
same command, and caches the answer per base, command **and preparation**. The
verdict is then `inconclusive`, which `independenceProblems` excludes,
`slices.md` renders as `⚠️`, `slice-standalone` downgrades to a warning, and the
journal records as `slice-verify-inconclusive`.

Five places knew that word. `pdkit slice verify` — the one a person runs and
reads at the moment it happens — printed `RED`, and on DESKTOP-18832 that sent a
session into a half-hour investigation of a fact already sitting in
`slices.json`, ending in a judgement call made under uncertainty the machine did
not have. The verdict now has three words everywhere, and the inconclusive one
names where to look.

Where to look is nearly always the same place, which is why it is named rather
than left to be found. **The verification tree is cleaned back to what git holds
on every run**, deliberately — a green standalone built on a leftover file is the
failure the working-tree check exists for. The cost is that anything a command
needs and does not itself build is absent there and present in your own checkout.
`slicing.verify.prepare` is the list that closes that gap, and both entries in it
were found by walking into the same wall: `build:core-api` because `typecheck:main`
consumes `packages/api/dist`, and `build:ui` because `typecheck:renderer` consumes
`packages/ui/dist` while upstream's own `typecheck:ui` builds it first. Either one
missing turns **every slice of every issue** red for a reason that has nothing to
do with slicing.

**A slice is a base plus a set of files, not a set of commits** — but it can be
*published* as several. One concern across layers is one slice, and `commits`
partitions its files into an ordered list of `{subject, files}`: one pull
request, a commit per layer, so main never sees half of it and a reviewer still
reads each layer apart. `materialize` commits the groups in order;
`slice verify --commits` builds each intermediate commit and records it as
`commitChecks`, which gate nothing. Whether upstream wants every commit to build
is an open question (podman-desktop#19798), and the slice as a whole is what
preflight holds to green.

The form a slice is verified and materialised through is one and the same:

```
git diff --binary --find-renames <base>...<ref> -- <the slice's files>
```

The reason is ordering. `slice verify --all` is step 1 of the `/pd:pr` flow — that
is, **before** any branch exists and before any squash. The slice's commits do
not exist at that moment, and the only thing that does is the diff restricted to
its files. `--from-pr` follows from the same shape: somebody else's published diff
is substituted for the local one and the slicer is unchanged.

Materialisation is the inverse of that diff: a branch from the base,
`git apply --index --binary`, one commit. **The original working branch is not
destroyed** — if the graph turns out to be wrong there is nothing to roll back.

**A branch is only the slice while it sits where the slice says.** Once a slice
branch exists, verification builds it rather than the change set — after
materialisation the branch is the slice, and a review fix lands there. What makes
that safe is a base check, and its absence cost a full run: an issue with one
slice gets the same branch name from `branches.sliced` that `pdkit worktree
create` gave the working branch, so verify found a branch, built the working tree
on the commit it had been cut from, and wrote `standalone: true` against `main`
(18835). A branch whose merge-base with the slice's base is not that base is now
refused, naming both commits; `standalone` is what the build measured, not what
the graph intended; and the base ref and its commit are stored with the run, so
the claim is checkable without `git merge-base` and a suspicion.

**Freshness is checked by digest.** `slices.json` stores, per slice, the `sha256`
of that exact diff and the base SHA. `slice-standalone` in preflight recomputes
it in place: a mismatch is a **`fail` demanding a re-run, not a `pass`**. A green
verification of yesterday's diff is exactly the proof `lib/evidence.js` was
written against. As a side effect this also checks materialisation: a slice
branch's diff must match, byte for byte, what was verified.

| Mechanically, `pdkit slice set` | Left to `pd-slicer` |
|---|---|
| no two slices share a file | whether a slice stands on its own **in meaning**, without the next one |
| the union of slices is the whole diff; a changed file in no slice is an error | whether a slice is groundwork that must be acknowledged in the PR body |
| `base` is `main` or another slice; the graph is acyclic | which files make a meaningful slice at all |
| a slice whose standalone run is red cannot branch from `main` | the wording of `Why separate` and `Where to look` |
| `extension-api` files are in one slice, first, with no other layer | |
| a slice's R-IDs are derived from the tasks owning its files, plus the requirements of every task that owns no files at all; the union covers the frozen set | |
| `max_files_per_slice`, and a slice spanning layers — a warning, not a refusal | |
| an existing IPC channel's two ends are in one slice | contracts no detector reads: events sent by name, config keys |
| no more slices than the plan's hypothesis without `whyDeviates` | whether the deviation is a reason or a preference |
| `commits` partition their slice; every subject is a conventional commit | the order of the commits and what each is called |

`slices.md` is **rendered from `slices.json`**, never printed by an agent. Its
merge order says "any order" for slices no stack connects, rather than listing
their indexes with arrows; that list went into three PR bodies on DESKTOP-19818
as an order nobody had verified. `merge-order` in preflight fails a body that
states an order the graph does not have.

**Joining slices that are already out.** `pdkit slice join` merges slices into
one whose commits are the joined slices, under the subjects their branches were
published with, and records the pull requests it replaces (`supersedes`). It
goes through `build()`, so every rule above holds for the result. Slices it
renumbers are matched by slug, and a published one keeps its pull request and
its branch. It refuses a branch review moved away from the change set: joining
from the change set would drop that work. The issue goes back to `sliced` with
a reason, the graph is approved again, and `pdkit pr supersede` closes each old
pull request with a reply token for it, after the new one is open.

---

**In brief** — [`architecture/`](../../architecture/README.md): [4 · The slicer](../../architecture/04-slicer.md)

**In practice** — [`workflows/`](../../workflows/README.md):

- [§3 — A feature, cut into several pull requests](../../workflows/03-feature-in-several-prs.md)
- [§11 — Upstream asks you to split an open pull request](../../workflows/11-split-open-pr.md)
- [§11a — Upstream asks you to join open pull requests](../../workflows/11a-join-open-prs.md)

← [`/pd:audit`](audit.md) · [Contents](../README.md) · [`/pd:pr`](pr.md) →
