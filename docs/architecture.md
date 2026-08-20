# Architecture

The short version. The full design — the reasoning, the measurements and the
rejected alternatives — is in [`specification.md`](specification.md).

## The constraint everything follows from

We work in a fork of a repository we do not own. That forbids three things other
workflow tools take for granted:

1. **State cannot live in the tree.** It would show up in a diff and then in a
   pull request. State lives in `$PDKIT_HOME`, keyed by issue number — which also
   means several worktrees share one state rather than each keeping a copy.
2. **We cannot open scratch issues.** Tools that store epics as GitHub issues
   assume they own the repository. Our source of truth is local files.
3. **A careless push is public.** Hence the gate.

## The pieces

| Piece | Role |
|---|---|
| `bin/pdkit` + `lib/` | everything deterministic: state machine, IDs, slicing, gates, preflight, validation evidence |
| `skills/` | the workflow surface — what you invoke |
| `agents/` | bounded workers with their own context |
| `hooks/` | the rules that a prompt cannot guarantee |
| `knowledge/` | upstream constitution, shipped with the plugin |
| `templates/` | the shape of every artefact |

The split is not stylistic. Anything that must be **true** is in `lib/` and
`hooks/`, where it can be tested. Anything that requires **judgement** is in
`skills/` and `agents/`. A rule stated only in a prompt is a rule that holds most
of the time.

## The lifecycle, and its two ways out

An issue moves through a state machine that only `pdkit` may advance. The usual
path runs triage → plan → exec → validate → audit → slice → preflight → pull
request, and ends at `merged` once every pull request has landed.

Two branches off it are worth knowing about, because both are ordinary outcomes
that the first version of the machine could not express.

**A reviewer can reject the approach rather than the diff.** `pr-open` and
`review-in-progress` lead back to `triaged` through `pdkit issue rework`. The pull
request stays open and the branch stays put; the route is chosen again and
planning starts from the issue rather than from the diff that was refused. Without
that edge the only moves were to push again — which assumes the design survived —
and to abandon an issue still worth doing.

**An issue can end in an answer rather than a diff.** When the bug is real and the
cause lives outside the repository, the deliverable is a reproduction, a detector
command and a workaround. `answered` is that state, and it is deliberately **not**
terminal: at the moment the findings are posted you are waiting on the reporter.
Three exits — `resolved` when somebody confirms, back to `planned` when the answer
implies product work, `abandoned` when it goes quiet. Entry is guarded by a
capture, for the same reason PASS is: a workaround nobody ran is a suggestion, and
a suggestion posted in the voice of a finding costs the reporter their evening.

**There is no way back to the start, and `pdkit reset` is not one.** A cycle that
went wrong early cannot be re-entered by a transition: `new` has no predecessor,
and giving it one would write a trip into the history that the work never took —
destroying the distinction between artefacts that were never produced and
artefacts that were lost. So the reset *removes the record* instead. With no
`state.json` the machine reads its own blank, whose only exit is `triaged`, and
the next cycle is forced to start where a cycle starts. It clears one issue's
artefacts, consent tokens and active pointers, leaves every neighbour alone, and
leaves the journal alone too — an issue back at `new` with no history would be
indistinguishable from one nobody ever worked on.

## What the slicer is, in one paragraph

A slice is a base plus a set of files. It is verified before any branch exists, by
applying the diff restricted to those files to a scratch worktree from `main` and
running the repository's own typecheck, lint and tests there. Green means it
branches from `main`; red means it needs a stack, and the red run is the evidence
for that stack. The result is produced by `pdkit` and stored with the digest of
the diff it describes, so preflight can ask later whether it is still about this
diff — which is also how a materialized branch is checked against what was
verified. Nothing in that sentence has a parameter an agent could supply.

## What validation promises, and what it does not

`pdkit validate` brings up the built application with remote debugging on and
prints the endpoint; Playwright MCP attaches to it and drives it. Evidence is
attached as it goes — a captured run, or a file that has been hashed and described
— and the status of a step is derived from what is attached. There is no
`--status`.

The promise is deliberately narrower than the slicer's, and the difference is
worth being explicit about. A slice's verdict is machine-readable all the way
down: it is an exit code. "The contrast is now 4.6:1" is an observation, and no
code can confirm it was read correctly. So PASS means **an artefact was
captured**, not that the application behaves. Promising more would buy a check
that reports on work it did not do — the same failure as a `pass` where a `skip`
belonged.

The third outcome follows from that. A step nobody could demonstrate is
`unverified`, and it does not block the transition: without Playwright the
pipeline would stall at `implemented`, and a gate that expensive gets routed
around. What keeps it from evaporating is preflight, which refuses a pull request
body that does not name it.

## Why hooks rather than instructions

Three things are enforced rather than requested, and each closes a failure that
was actually observed:

- **The push gate.** `git push` and `gh pr create` are denied without a
  short-lived token for that exact branch. A token knows what it is consent for: a
  `push` token is keyed by branch and issued only from `preflight-green`; a
  `reply` token is keyed by pull request, for writes that belong to no branch.
  Keys of different kinds cannot be found for one another, so consent to publish
  code is not consent to speak in a review — which it silently was before the
  kinds existed. Writes to the issue tracker are denied outright, from every
  state: no gate can be opened for them, because the routes that produce issue
  text all say a human posts it.
- **File ownership.** A worker writing outside its task's `Owns` set fails. This
  turns the ownership map from a request into an invariant and removes a class of
  merge conflicts rather than resolving them.
- **Receipts.** A task cannot be marked complete without captured command output,
  and after three failed captures it is blocked until somebody says in writing
  what changed.

The gate reads the command rather than matching a substring on it. A hook's
`matcher` can only see the tool name, so the parsing happens in code: leading
assignments, `&&`, `||`, `;`, substitutions, subshells, a program named by path, a
quoted `argv[0]`, and wrapper programs. That last one is not about any particular
tool — hooks on the Bash tool are global, so a wrapper can appear in this project
without this project being told.

## Known weaknesses

Stated rather than discovered later:

- A fresh-context auditor of the same model catches drift from the plan, not blind
  spots shared with the model that wrote the code.
- Slicing a finished diff is expensive. That is why the plan carries a slice
  hypothesis.
- `Patch comes off` is a textual check, and named for it: the diff applies in
  reverse. Whether the build survives a revert is measured at +100% per slice
  (+26% narrowed to typecheck) and is deliberately not bought — the revert that
  matters happens weeks later, against a tree that has moved.
- Stacked PRs are fragile, which is why independent slices are the default.
- Consent fatigue is real. The gate prints the PR body and branch list rather than
  a yes/no prompt, because that is the thing worth reading.
- Validation proves an artefact was captured, not that the artefact shows the
  right thing. Whether the screen was correct stays with a human.
- Lists in the config replace rather than merge, so a list copied by `init` and
  never edited stops tracking the shipped default. `doctor` reports it; nothing
  prevents it, because silently re-extending a list somebody edited would be
  worse.
