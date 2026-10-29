# `/pd:triage <issue>` — the entry point that cannot be skipped

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:triage`

Half the value of the plugin is here: it decides **whether planning is needed at
all**.

0. **What came with the command.** The first line of `/pd:triage <n>` is the
   invocation; everything after it in the same message is prior context, and it
   is recorded verbatim under `## Prior context` in `issue.md`. A line boundary
   rather than a flag, so nothing has to parse it. What it holds is what the
   issue text cannot: related work already merged, an approach to repeat or to
   avoid, a trap the previous attempt hit. Typed into a chat message it would
   die with the session, and `/pd:plan` three days later reads the disk.
   Verbatim, for the same reason the `[inferred]` list is read back — a summary
   is the plugin's reading of what it was told, and a wrong reading propagates
   into the plan as a record everything trusts. `none given` when nothing came,
   because an empty section reads as forgotten rather than as absent.
1. `pdkit issue fetch <n>` — body (always whole), labels, the newest
   `triage.fetch_comments` comments (`--full` for all), linked pull requests.
2. **Dedup**: open pull requests referencing the issue; closed ones (a revert
   means the `redo` route, and `pd-archaeologist`).
3. Two or three `pd-scout` runs in parallel locate the affected packages. Reading
   the code wholesale is forbidden — a map only.
4. Nature and size. The `trivial` threshold: an estimated diff of ≤ 20 lines,
   ≤ 3 files, no `packages/extension-api`, no schema changes, no new dependencies.
5. A draft R-set with a **source tag** on every requirement: `[issue]` verbatim,
   `[paraphrase]` reworded, `[inferred]` supplied by the agent, `[review]` stated
   by a reviewer, `[operator]` stated in the prior context that came with the
   command. The last two were added the same way, by finding a requirement with
   nowhere to come from: on a rework the strongest one is a maintainer's
   objection rather than anything in the issue, and at step 0 it is whatever the
   person starting the work already knew. Neither may be folded into `[issue]`,
   which means a maintainer can be pointed at the line that says it. A read-back
   is mandatory: the `[inferred]` list is shown separately, before the file is
   written. It is a cheap defence against "the plugin invented the requirements".
6. Verdict: `ROUTE: quickfix | standard | multi-slice | redo | invalid`.

**On the `quickfix` route tracing goes by issue number and no R-IDs are
allocated.** A single `R1` on a one-line fix is ceremony for the sake of
uniformity. Three consequences follow, and all three are implemented:

- the PR body carries `Fixes #12345` instead of a coverage table, and
  `Steps to check` stays mandatory regardless of diff size;
- in preflight, the one check that skips because of the route is
  `validation-evidence`, since the route does not validate, and `quickfix-size`
  runs on this route only;
- **escalation.** If the fix outgrows the thresholds, the route is raised to
  `standard` and **R-IDs are allocated at that moment** — from requirements
  recovered out of the issue, not out of the code already written. The ordering
  is the point: R-IDs derived from a finished diff describe what was built rather
  than what was needed, and the whole trace becomes self-confirming.
  `pdkit issue escalate <n>` rolls the state back to `triaged`.

The `invalid` route is also a result: duplicate, already fixed, does not
reproduce. Its output is a draft comment; publishing is a human action.

## The `redo` route

The machine goes first, as everywhere. `pdkit issue history <n>` collects facts
and reaches no verdict.

| Mechanically, `pdkit issue history` | Left to `pd-archaeologist` |
|---|---|
| which PR landed it, when, whose, what it touched | why it was reverted — in the revert's own words, not a paraphrase |
| which PR reverted it, and which regression issue that one cites | whether the objection was to the approach or to details |
| how many days the change lived in the base branch | whether the objection still applies today |
| what reviewers said: `CHANGES_REQUESTED` and blocking threads, bots collapsed | what this attempt must do differently |
| what merged in the same files **after** the revert | |
| what could not be established (`gaps`) | |

Two things here are not obvious, and both were found on a live issue:

- **A revert references the pull request, not the issue.** Asking the issue's
  timeline is not enough: `#17829 revert: #16294` does not appear in the timeline
  of issue #12775, which that PR closed. So every merged PR gets a second
  question — "who references you".
- **The attempt and its revert are established as a pair, not picked by date.**
  The newest merge on an issue can easily post-date the revert, and then the
  report shows an attempt its own revert precedes: a lifetime of zero days and
  review comments from an unrelated pull request.

**The ordering is not advice.** [Section 10](../10-scenarios.md) requires archaeology before any
implementation. Until it was implemented that ordering was held by a sentence in
a prompt; now `state.transition` refuses to leave `triaged` on the `redo` route
while `archaeology.json` is absent, and that file is written only by a real
lookup. Same device as receipts: not a stricter check, but the absence of a way
to do without the input.

## Batch mode: `/pd:triage` with no number

A different question — not "how do I do this issue" but "which one". The machine
goes first here too: `pdkit issue list [--label a,b] [--limit 20]` returns the
open backlog with the facts that say whether an issue can be started at all.

| Mechanically, `pdkit issue list` | Left to the model |
|---|---|
| pull requests referencing the issue **in this repository**; an open one means work is under way | whether the requirement is clear enough to plan against |
| assignee: somebody has taken it | whether behaviour is described concretely enough to check |
| whether a maintainer replied (`MEMBER`/`OWNER`/`COLLABORATOR`), **excluding the issue author** | how big this looks |
| whether a bug report carries a reproduction: a `Steps to reproduce` section with content, not `_No response_` | whether it is worth taking now |
| which upstream template the body follows, or none | |
| how many days since a **human**, not a bot, touched it | |
| a merged PR plus a revert — a `redo` candidate; closed without merge — the attempt was already rejected | |

One GraphQL request for the whole list rather than one per issue: `gh issue list
--json comments` returns empty arrays, so the obvious shape would cost twenty
round trips and still need a second call. One request is about 1.3 s, and gives
every issue the same instant in time.

Three things here are not tidiness, and each was found by a live run:

- **A linked PR must be in this repository.** A cross-reference can arrive from
  anywhere on GitHub; on #18381 it was a merged pull request in a stranger's
  prototype repo.
- **Idle time is measured from human activity, not `updatedAt`.** The stale bot
  moves the timestamp, so sorting by it floats precisely the abandoned issues to
  the top.
- **The issue author is not "the project answering"**, even when they are a
  `MEMBER`.

The output is an **order over facts, not a recommendation**: blocked last, then
by number of signals, then by human recency, then by issue number so two runs
print the same list — an order that reshuffles cannot be discussed. There is
deliberately no `score` field: what actually decides is not in the table, and a
number would look measured.

**Batch mode writes nothing and moves nobody.** A listing that triaged for you
would be a listing that chose for you, and choosing is the one non-mechanical
part of the scenario.

---

**In practice** — [`workflows/`](../../workflows/README.md):

- [§0 — Picking what to work on](../../workflows/00-picking-what-to-work-on.md)
- [§2 — A one-line fix](../../workflows/02-one-line-fix.md)
- [§5 — Work that was already tried and reverted](../../workflows/05-tried-and-reverted.md)

← [4 · Contracts of the key commands](README.md) · [Contents](../README.md) · [`/pd:plan`](plan.md) →
