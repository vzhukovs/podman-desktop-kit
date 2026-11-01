# `/pd:pr-sync <pr#>` — feedback from review

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:pr-sync`

1. `pdkit pr threads <n>` — unresolved threads, top-level comments, and review
   submission bodies through GraphQL.
2. **Bot filter.** Known bots collapse to one line with a link — collapse, not
   drop. A match against `review.bot_escalate` (security, data loss, correctness)
   expands the thread back.
3. **Clustering**, and mapping each thread to an R-ID / slice / file. A thread
   that maps to nothing is a signal: either the reviewer found a requirement the
   plan did not have, or they did not understand the PR. Both are valuable.
4. **Classification**: `accept` (fix it) / `discuss` (needs an answer, not a fix)
   / `defer` (separate issue) / `reject` (reasoned disagreement). A `defer` is
   recorded by `pdkit defer new`, not by the reply that mentions it — see [2.3](../02-plugin-structure.md#23-the-journal).
5. If an `accept` changes the plan, `amendments/A<k>.md` is generated with the new
   or changed R-ID and the affected slices, **and it goes to the human for
   approval** — `pdkit amendment approve` or `reject --reason`. Approval moves no
   state: the plan becomes what the amendment says and the work continues against
   it, and what finds the work done against the previous version is `pdkit audit`.
   Until somebody decides, the amendment is a proposal and the plan has not
   moved, which is what `pdkit amendment list` says out loud.
   Approval also applies the amendment's `Requirements affected` table — the
   one write a frozen requirement set accepts. Added R-IDs continue the
   numbering from the counter; withdrawn, superseded and replaced ones leave the
   live set and keep their numbers; the Change cell is one of `added`,
   `withdrawn`, `unchanged`, `superseded by R<k>`, `replaced by R<k>`, and any
   other word refuses the approval, naming the line. The record keeps which
   amendments it has taken (so none is applied twice), the journal gets a
   `requirements-amended` entry with the set before and after, and plan.md's
   `- Requirements:` line is rewritten to the live set. If either half does not
   follow, approve says which and exits non-zero; `pdkit amendment sync` finishes
   it. The `### T<k>` blocks under `Slices affected` are read with the plan's
   own parser and materialized: `tasks/T<k>.md` rendered (an existing file is
   kept, not overwritten), the block added to plan.md's `## Tasks`, and
   `task sync` re-run. A heading `### T<k> (replaces T<j>, …):` withdraws the
   tasks it names: their Status becomes `withdrawn by A<k> (replaced by T<k>)`,
   the record moves them from `owns` to `withdrawn`, and they keep their IDs.
   A withdrawn task writes nothing (the pre-write hook), cannot be started or
   receipted, and `pdkit audit` lists it as withdrawn rather than as missing.
   Tasks that do not parse, reuse a live ID or claim a live task's file keep
   the amendment proposed.
6. `pd-thread-resolver` per thread, in parallel, each within its own files.
7. Cascade: if a fix touched a slice others are stacked on, `pdkit slice cascade`
   rebases the dependents and re-runs verification; whatever stopped being
   standalone is flagged.
8. Preflight → gate → push → replies and `resolve` through GraphQL.

This is the only place `git push --force-with-lease` is permitted — through the
gate, on your own branch, to the pull request it already has. That is how a
branch rebased by `/pd:resume` or cascaded in step 7 reaches its pull request.
`--force` without a lease is denied at the hook always.

| Mechanically, `pdkit pr threads` | Left to the model |
|---|---|
| bot or human, by account type | what the reviewer meant |
| thread → file → slice → task → R-ID | `accept` / `discuss` / `defer` / `reject` |
| a thread matching no slice is flagged | whether a plan amendment is needed |
| a `bot_escalate` match is marked "read in full" | the wording of the reply |

**The asymmetry in the last row is deliberate.** A word match **raises** a thread
and never lowers one. Mechanically discarding a security finding because it did
not contain the right word is precisely the mistake the bot filter exists to
prevent, not to commit.

**The unit of consent here is different from push.** A push token is per branch,
because each branch is a separately published artefact. Draft replies are read by
a human in one go, and one token for that showing is exactly what they approved;
a token per thread would mean confirming eight times in a row, and a gate that is
expensive to pass gets routed around. Hence `pdkit gate open --pr <k> --kind
reply`, eligible from `pr-open` and `review-in-progress`.

---

**In practice** — [`workflows/`](../../workflows/README.md):

- [§7 — A pull request that has gone stale](../../workflows/07-stale-pr.md)
- [§7a — Feedback that arrives after the merge](../../workflows/07a-feedback-after-merge.md)

← [`/pd:pr-status`](pr-status.md) · [Contents](../README.md) · [`/pd:resume`](resume.md) →
