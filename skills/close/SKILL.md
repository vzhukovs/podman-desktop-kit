---
name: close
description: "Close out a merged issue: harvest what was learned, clean up worktrees."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: sonnet
---

## Steps

1. **`pdkit close <issue> --json`** — the facts: what merged and when, which
   amendments happened, what the journal recorded as notable, which worktrees
   are still on disk.

2. **Check the rollup before anything else.** An issue is finished when *every*
   one of its pull requests has landed. One merged slice of three is not a
   finished issue, and a pull request the maintainer closed is unfinished work
   rather than finished work — that is the entry to the `redo` route, not the
   exit.

   `pdkit close --finish` refuses while anything is open, and it is right to.

3. **Harvest.** Read the facts and decide what belongs in `knowledge/`:

   - a trap that cost time and would cost it again (the `RunOptions` class of
     thing);
   - a review expectation nobody had written down;
   - a package boundary that turned out to be different from what the plan
     assumed.

   Not a narrative of the work, and not "we learned to test more carefully". If
   a finding would not change what a future run does, it is not knowledge, it is
   a diary entry.

   Propose the additions and let the user approve them. `knowledge/` ships with
   the plugin and is read by every later issue; growing it quietly is how it
   stops being read.

   This is the per-issue half, done while the details are still live. The pass
   over the whole base — entries that have gone stale, paths that moved, a
   layer chain that drifted — is `/pd:knowledge`, and it is periodic rather than
   part of finishing anything.

4. **`pdkit close <issue> --finish`** — moves the issue to `merged` and removes
   its worktrees. Removal refuses on a tree holding an unmerged branch, because
   that is the one case where tidying up loses work. `--force` only once you
   mean to abandon those commits.

## When the issue was answered rather than changed

An issue in `answered` finished differently: the deliverable was a reproduction,
a detector and a workaround, published as a comment, and no diff of ours settled
it. The rollup has nothing to say about it — asking it produces "no pull request
was ever opened", which is true and about nothing.

```
pdkit close <issue> --finish --confirmed "<who confirmed, and how>"
```

`--confirmed` is required and is a **fact about them**, not a verdict of ours:
the reporter said it worked, or a maintainer closed the issue. Without it the
close is refused, because deciding on our own that someone else's problem went
away is the same overreach `awaiting-review` refuses for domain owners. If
nobody ever answers, the honest end is `abandoned` and the reason says so; if
the answer implied product work, the issue goes back to `planned` instead of
being closed at all.

## What not to do here

Do not close the upstream issue and do not comment on it. Both are refused by
the hook, and the refusal is the workflow being honest with itself: writing to
someone else's tracker is a human action, and upstream closes its own issues
when the pull request merges.
