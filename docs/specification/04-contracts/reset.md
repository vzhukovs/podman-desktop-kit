# `/pd:reset <issue>` — starting one issue over

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:reset`

The failure it closes is ordinary and had no answer: a cycle that went wrong
early, where continuing means every later step inherits the mistake because every
later step reads what the earlier ones wrote. Before this command the only route
out was `rm -rf` on a directory whose neighbours share a parent — a thing nobody
should have to type carefully at midnight.

Shaped like `close`: bare, it reports and changes nothing; `--confirm` acts. The
two are the only commands standing where the question is whether a cycle is over,
and both are read by someone who wants the consequences before agreeing to them.

**Four stores hold something about an issue, and they are not treated alike.**

| Store | What happens | Why |
|---|---|---|
| `issues/<n>/` | archived to `archive/<n>/<timestamp>/`, or deleted on `--purge` | this is the research the next cycle must not inherit. Archived by default because a gate that is expensive to pass gets routed around, and an undo that is one `mv` makes `--confirm` cheap to grant |
| `gates/` | tokens carrying this issue's number are revoked | consent must not outlive the record that justified it. Matched on the `issue` field inside the token, not on its key: a reply token's key names a pull request, which says nothing about the issue unless you already hold `prs.json` — which is inside the directory about to move |
| `active/` | pointers naming a task of this issue are cleared, in every working tree | otherwise a hook is left enforcing an `Owns` set for a task whose file has gone |
| `journal/` | **kept**, and one `reset` entry appended | [invariant 2](../02-plugin-structure.md#22-state-outside-the-repository). It is also what makes the reset legible: an issue back at `new` would otherwise be indistinguishable from one nobody ever worked on |

Two consequences follow from the journal being kept, and both are printed rather
than left to be discovered. **Deferrals survive**, because they are derived from
the journal precisely so a promise to a reviewer outlives the issue — and it
equally outlives us deciding to start again. **Nothing upstream moves**: an open
pull request is forgotten, not closed. That last one is the item worth reading
twice, and the design self-heals around it — dedup is the first step of triage,
so the next cycle rediscovers from GitHub what this one forgot.

Working trees are a fifth case and sit outside `$PDKIT_HOME`. A branch carrying
unpushed commits is *work*, not a record of work, so removal is `--worktrees`
rather than the default, and still goes through the check that refuses a tree
holding a branch which has not landed. A command called "start over" must not be
the thing that silently drops commits.

**One consumer had to change.** Attempt counts are derived from the journal, and
task numbering restarts with the record — so the T1 of the new cycle would
inherit the failures of the T1 of the old one and could be born blocked. The walk
now stops at the last `reset` entry, cut by position rather than by timestamp: the
journal is second-resolution, and a reset and the first capture after it can share
one.

---

**In brief** — [`architecture/`](../../architecture/README.md): [3 · The lifecycle](../../architecture/03-lifecycle.md)

**In practice** — [`workflows/`](../../workflows/README.md):

- [§16 — Starting one issue over](../../workflows/16-starting-over.md)

← [`/pd:close`](close.md) · [Contents](../README.md) · [`/pd:review-pr`](review-pr.md) →
