# `/pd:resume <issue>` — coming back after a break

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:resume`

1. `/pd:sync`: fetch upstream, update `main`.
2. `pdkit drift <issue>` — which upstream commits since the branch point touched
   our slices' files.
3. Rebase. Conflicts are classified by `pd-conflict-analyst`: **mechanical**
   (imports, formatting, a file moved) are resolved immediately, each resolution
   journalled; **semantic** (upstream rewrote what the plan stood on) means
   **stop**, analyse the new commits, and take a plan amendment to approval.
4. After the rebase, `preflight` and `slice verify --all` again. A previous green
   means nothing.
5. Hand off to `/pd:pr-sync` for accumulated threads.

**Each slice has its own branch point.** It is the `merge-base` of the slice's
branch with its base, and for a stacked slice the base is the predecessor's
branch, not `main`. Measuring drift from `main` for a stacked slice shows
somebody else's commits in it — the same error that stage 3 closed with "the
preflight base comes from the graph".

What `pdkit drift` adds over a commit list is a separate column: did the commit
touch **the lines the plan cites** (`file:line` from task context). A commit in
the file is a candidate for a mechanical conflict; a commit in the cited lines is
a candidate for a semantic one. It is a hint, not a verdict, and it must not turn
into permission to skip reading the new commits.

Nothing is pushed from `resume`. The rebased branch reaches its pull request
through `/pd:pr-sync`, step 8.

**Work that predates the plugin is adopted, not replayed.** The ordinary case is
the reverse of [scenario 5](../10-scenarios.md): a branch and a pull request exist while `state.json`
says `new`. Walking it through the whole chain so the record "agrees" would mean
writing a plan nobody planned and freezing requirements nobody stated — inventing
exactly the artefacts the machine exists for. `pdkit issue adopt <n> --pr <k>
--branch <b> --reason <why>` records what exists and stops: state, route, PR
number, and an `adopted` field with the reason. The artefacts of the states it
never passed stay missing, and `adopted` explains why — an issue with no plan
because nobody wrote one and an issue whose plan was lost are different things.
Adoption is possible only from `new`: overwriting a live record would erase the
one history that cannot be rebuilt.

---

**In practice** — [`workflows/`](../../workflows/README.md):

- [§8 — Coming back after a break](../../workflows/08-coming-back.md)
- [§12 — Work that predates the plugin](../../workflows/12-predates-the-plugin.md)

← [`/pd:pr-sync`](pr-sync.md) · [Contents](../README.md) · [`/pd:close`](close.md) →
