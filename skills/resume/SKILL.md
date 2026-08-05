---
name: resume
description: "Come back to an issue after a break: drift analysis, rebase, plan amendment."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: opus
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

1. **`/pd:sync`** — fetch, and see where the fork stands. Read-only.

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

   - **mechanical** — imports, formatting, a moved file, a rename. Resolve it,
     and journal the resolution:

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

5. **Publish under a gate.**

   ```
   pdkit state <n> --to preflight-green
   pdkit gate open --issue <n> --branch <b>
   git push --force-with-lease origin <b>
   ```

   This is the only place `--force-with-lease` is allowed: your own branch,
   under a token. `--force` without a lease is refused always, token or not.

6. **Hand over to `/pd:pr-sync <k>`** for whatever accumulated in review while
   the branch sat.

## When it is worse than a rebase

If upstream reimplemented the thing the issue was about, say so plainly and
stop. The routes for that are `redo` (the work existed and was reverted) and
`invalid` (it is already fixed), and both start at `/pd:triage`, not here.
Rebasing a plan onto a world that no longer needs it produces a pull request
nobody can review.
