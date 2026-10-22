---
name: resume
description: "Come back to an issue after a break: drift analysis, rebase, plan amendment."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: sonnet
effort: medium
---

Everything here assumes the world moved while you were away, and asks whether it
moved under the plan or merely around it.

## First: does the machine know about this work at all

`pdkit state <issue>`. If it says `new` while a branch and a pull request exist,
the work predates the plugin — the common case for anything opened before it was
installed, and the one this command is most often reached for.

```
pdkit issue adopt <n> --pr <k> --branch <b> --reason "<where this came from>"
```

Adoption records what is true and stops. It does **not** walk the issue through
triage and planning to make the record look complete: an issue with no plan
because nobody wrote one is a different thing from one whose plan was lost, and
`adopted` in the record is what keeps them different. Say so in the report
rather than treating the absent artefacts as gaps to fill — there is nothing to
recover, and inventing a plan after the fact describes the code that exists
instead of the requirement that was.

## Steps

0. **Checkpoint.** `pdkit checkpoint <issue> --phase resume`, before anything
   is fetched or rebased.

0a. **What it was waiting on.** `pdkit issue blocks <issue> --check` reads each
   blocker's state from GitHub.
   - **Still open.** The rebase can still happen, but the rows marked
     `blocked by` stay untouched, and the next `/pd:pr-sync` carries on
     without them.
   - **Closed, and what it carried has merged.** First
     `pdkit issue unblock <issue> --by <blocker> --reason "merged as #<pr>"`.
     The rebase below then brings the merged work under this branch, and the
     next `/pd:pr-sync` does the rows that waited for it.
   - **Closed without merging.** That is a decision for the person, not a
     lift: the dependency was the reviewer's request, and it is still unmet.

1. **Fetch, and bring `main` up to date.** `git fetch upstream --prune` and
   `git fetch origin --prune`. `pdkit drift` reads the local `upstream/main`
   and fetches nothing, so without this step it measures against whatever was
   last fetched.

   Then the local `main`, fast-forward only. Find where it is checked out with
   `git worktree list --porcelain` (the entry with `branch refs/heads/main`):

   - checked out nowhere: `git fetch . upstream/main:main`, which refuses
     anything but a fast-forward;
   - checked out in a tree: `git -C <that tree> merge --ff-only upstream/main`,
     and only if `git -C <that tree> status --porcelain` is empty.

   Skip it and say why when that tree is dirty, or when
   `git rev-list --count upstream/main..main` is not 0. A `main` ahead of
   upstream carries a commit somebody made on the base branch, and the person
   decides what happens to it. Nothing else is touched in that tree.

   Do it here rather than through `/pd:sync`: that command is the person's to
   run, and the Skill tool refuses it. If they want the full picture of every
   worktree, suggest they run it themselves.

2. **`pdkit drift <issue>`** — the upstream commits that landed since each slice
   branched and touched that slice's files.

   Without a slice graph the branch comes from the registered pull request, or
   from a local `DESKTOP-<n>/…` branch; `--ref` and `--files` override both.
   **A report that measured nothing says so.** "No branch found" is not "no
   drift", and the difference is the whole value of the command — read the last
   line before believing the middle.

   Each slice is measured from **its own** branch point. A stacked slice
   branched from its predecessor, so drift against `main` would report the
   previous slice's own commits as upstream movement.

   The column that matters is the last one: whether a commit touched **lines the
   plan cites**. A commit in the file is a candidate for a mechanical conflict. A
   commit in the lines the plan built on is a candidate for a semantic one, and
   semantic means stop.

3. **Rebase, slice by slice, in merge order.** `pd-conflict-analyst` classifies
   every conflict:

   - **mechanical** — imports, formatting, a moved file, a rename. Resolve it
     to exactly what both sides need and nothing more. Do not reorder or
     reformat beyond the conflict. Imports keep the `/@/` aliases and the
     `node:` prefix (`${CLAUDE_PLUGIN_ROOT}/knowledge/maintainer-rules.md` §5). A tidy-up made while
     resolving reaches the pull request as a change its title does not
     explain, and the maintainer rejects that (§1). Journal the resolution:

     ```
     pdkit journal conflict --issue <n> [--slice <i>] --kind mechanical \
       --file <path> [--commit <upstream sha>] --resolution "<what you took and why>"
     ```

   - **semantic** — upstream rewrote what the plan stood on. **Stop.** Read the
     new commits, produce an amendment (`pdkit amendment new`), and get it
     approved before touching anything else. Journal it with
     `--kind semantic --amendment A<k>` once the amendment exists.

   This is the one entry a person writes by hand, and the reason is that nothing
   can observe it. A receipt is a capture, a slice verdict is a run, a merge is
   an API answer — each of those is closed to you precisely because a machine
   produces it. What upstream rewrote under the plan is visible only to whoever
   resolved it, and an unwritten resolution is gone: six months later the diff
   shows what was chosen and nothing shows why.

   The hint from step 2 is a hint. The dangerous semantic conflict is the one
   that merges cleanly: git is satisfied, the build is green, and the code now
   does something the plan never intended. If a conflict touches logic the plan
   depended on, treat it as semantic even when nothing complained.

4. **Re-verify from scratch.** `pdkit slice verify --issue <n> --all
   --standalone`, then `pdkit preflight <n> --slice <i>`. A previous green
   describes a diff that no longer exists — and the digest check will say so
   before you do.

5. **Hand over to `/pd:pr-sync <k>`.** Nothing is pushed from here. The
   rebased branch reaches its pull request in `/pd:pr-sync` step 9, after
   `pdkit pr diff` has shown what the push changes, together with whatever
   accumulated in review while the branch sat. `pdkit pr list --issue <n>`
   gives `<k>`.

## When the phase went somewhere it should not

If this phase built on an option pdkit does not carry, or a refusal was routed
around before anyone noticed, go back to its start rather than patch forward:

```
pdkit rollback <n>              what would come back, and what stays
pdkit rollback <n> --confirm    after the person has read that
```

Branches return to their heads at the checkpoint, with the present tips kept
under `refs/pdkit-backup/`. Artefacts return from the copy, with the present
ones archived. The state record comes back too. It is refused if the phase
moved the issue to another state, because a transition is not undone by
rewriting the record. What was published stays published, and the journal
keeps everything. Show the dry run in full and ask before `--confirm`. Then
run the phase again, in a new session.

## When it is worse than a rebase

If upstream reimplemented the thing the issue was about, say so plainly and
stop. The routes for that are `redo` (the work existed and was reverted) and
`invalid` (it is already fixed), and both start at `/pd:triage`, not here.
Rebasing a plan onto a world that no longer needs it produces a pull request
nobody can review.

## Next

`/pd:pr-sync <k>` for what accumulated in review — **in a new session**. What
this one worked out is already recorded: conflicts in the journal through
`pdkit journal conflict`, changes of intent as amendments, the verdicts in
`slices.json` and `preflight.json`. The rebase itself is not something the
review round needs, and in context it would be re-read on every one of its
turns. `pdkit next <issue>` prints the line.
