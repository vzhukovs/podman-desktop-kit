# 13. Status: what has been verified, and what has not

[Specification](README.md) › Section 13

The section exists so that "the plugin is tested" is not read more widely than it
is — the same discipline as `What I could not verify` in a review report. It has
one rule, learned the hard way after it fell three versions behind: **a row is
removed by the same thing that puts one there — a journal entry, or an artefact
you can point at.**

## Verified against live upstream, with its evidence

| What | Evidence |
|---|---|
| **The `quickfix` route end to end**, from "I'll take it" to a published pull request ([#18561](https://github.com/podman-desktop/podman-desktop/pull/18561)) | journal 17:11–17:52 on 2026-08-01: `triaged` → `worktree-create` → `quickfix` → `preflight-green` → `gate-open`/`gate-spent` → `pr-registered` → `pr-open`, then a reply token to edit the body |
| **The `standard` route end to end**, to pull request [#18562](https://github.com/podman-desktop/podman-desktop/pull/18562) | issue 17221, journal 18:42–21:39: `adopted` → `rework` → `planned` → `requirements-frozen` (R1–R4) → `plan-approved` → two tasks with `task-start`/`task-receipt`/`task-stop` (and one `task-attempt` with a non-zero exit) → `implemented` → `validated` → `audited` → `slices-set` → `slice-verified` → `slices-approved` → `slice-materialized` → `preflight-green` → gate → PR |
| **`validate` with Playwright and a codified test** | `validation.json` for 17221: the spec `experimental-feature-feedback.spec.ts`, its digest, **four green runs in a row**; separately `app-launched` with a CDP endpoint and an accessibility-tree snapshot |
| **Replacing a PR through `rework`** | #17577 closed as superseded by #18562, with the issue itself left unfinished |
| **`review-pr` on other people's pull requests** | `reviews/18464.md` (`REQUEST_CHANGES`) and `reviews/18556.md` (`APPROVE_WITH_NITS`), both with a confidence line and a filled `What I could not verify` |
| **The gate as a hook, not as a function** | a `denied` journal entry on 2026-08-02 for `git push --dry-run`: the refusal came from a handler the host launched, not from a test |
| **[Scenarios 12 and 13](10-scenarios.md#scenarios-the-brief-did-not-name) and the machine half of `redo`**, by dry run against other people's upstream PRs | `slice suggest --from-pr 18434` → a five-slice graph by layer with a `merge-base` base; both public-API refusals fired on a real `extension-api.d.ts` diff; `issue history 17873` produced the correct pair #17976 ↔ #18323 and reviewer quotes from the real attempt |
| **The plugin loads as a plugin, and a skill is invocable as `/pd:*`** | 2026-08-10: `claude --plugin-dir . -p "/pd:doctor"` against the fork returned the full doctor report, so the manifest loads, the skill body runs, and `bin/` reaches the Bash tool's `PATH` — `pdkit` resolved as a bare command. `claude plugin validate . --strict` passes |
| **`close --finish`, the [invariant-4](02-plugin-structure.md#22-state-outside-the-repository) rollup, and the transition to `merged`** | 18248, 2026-08-12: `pr refresh` observed a merge made in the browser and journalled `pr-merged #18561 observed by refresh` once; `close --finish` then read the rollup (1 merged, 0 open, 0 closed) and wrote `event:merged 1 pull request(s) merged`, with `pr-open -> merged` in the state history. Worktree removal refused in the same run — recorded here at the time as correct, and it was not: see below |
| **Flake detection** | 2026-08-13 on [#18779](https://github.com/podman-desktop/podman-desktop/pull/18779): three jobs went red on an Electron install failure, two re-runs turned them green, and `pdkit pr ci` reports `flake` on five — the three plus two whose red run nobody had noticed. It had never fired before because it could not: three separate defects sat between it and its data (below) |
| **Skills run as `/pd:*`, and agents dispatched by name** | 18832, 2026-08-18: `/pd:doctor`, `/pd:sync`, `/pd:plan` and `/pd:plan-review` all ran through a session, from the plugin as enabled in `settings.json` rather than from `--plugin-dir`. `/pd:plan` dispatched four `pd:pd-scout` agents on different questions and `/pd:plan-review` dispatched `pd:pd-plan-critic`; `research.md`, `plan.md`, seventeen task files and `plan-review.md` are what they produced |
| **The adversarial gate changing an outcome, twice** | 18832 on 2026-08-18 and again on 2026-08-19: both times `plan check` was green and `pd-plan-critic` returned three must-change findings anyway, and both times the issue went back through `triaged` to be replanned. Six blockers in total, no two the same, and none of them of a kind `plan check` looks for — a task made unimplementable by the plugin's own `Owns` exclusivity rule (found twice, under two different architectural answers), a fix that reintroduced the bug it was fixing one layer up, a step rewriting a test that already existed. The second run also showed the synthesis half working against its own agent: the critic proposed extracting a shared abstraction for a third future consumer, and the host checked, found the third consumer does not use the field at all, and dropped the finding |
| **The gate under deliberately widened permissions** | 2026-08-18: a session started with `--allowedTools Bash` was refused `git push --dry-run origin main` by the `pre-bash` handler the host launched, journalled as `event:denied`. Granting a tool does not disable the hook — which is the question that had to be answered before any run was given write access |
| **A deferral raised and retracted outside review** | 18832: `defer new` recorded a postponement decided at *planning* time, with no `--pr` to hang it on, and `defer drop` retracted it with a reason once `plan-review` disproved the argument it rested on. Both are journal entries; the machinery is not specific to a review thread |
| **A multi-slice graph end to end**, two slices into two published pull requests ([#19001](https://github.com/podman-desktop/podman-desktop/pull/19001), [#19002](https://github.com/podman-desktop/podman-desktop/pull/19002)) | 18967, 2026-08-26 to 08-27, on the `standard` route: `triaged` → `planned` → **three** `plan-review` rounds → `plan-approved` → T1–T5 with receipts → `implemented` → `validated` → `audited` → `slices-set 2 slice(s), merge order #1 → #2` → `slice-verified` on both → `slices-approved` → `slice-materialized` ×2 → `preflight-green` twice, the second from the predecessor's branch → two gates, two pull requests. Four approved amendments, every one raised by something that ran: a `Done when` command that had never worked, an audit finding, and twice by the slicer's own R-ID arithmetic. The `multi-slice` **route** — chosen as such at triage, which is what picks the path — remains untaken; this issue reached the same machinery from `standard` |
| **Review, rebase and merge — the second half of the lifecycle**, on [#18889](https://github.com/podman-desktop/podman-desktop/pull/18889) | 18832, 2026-08-26 to 08-31: `/pd:pr-sync` read the threads, two `pd-thread-resolver` agents produced the fixes, A2 and A3 were proposed and approved from what reviewers said, a reply token was opened and spent on the body edit, and `pr-merged #18889 observed by refresh` → `event:merged` closed it. It was the first issue through the whole machine from triage to `merged` with a human reviewer in the middle; the next row has the ones after it |
| **A real rebase against real upstream drift, both kinds of conflict** | 18832 on 2026-08-28, after upstream `ea086a5d599`: `drift` named four upstream commits under the slice, and both journal entries exist — `conflict-mechanical` on `container-utils.ts` (adjacent-line collision, no shared intent) and `conflict-semantic` on `ContainerDetails.spec.ts`. The semantic one is the case the module was written for and says so in its own text: only the appended-test collision surfaced as a git conflict, while the type break "would have merged silently and been caught by typecheck alone" |
| **Three more issues to `merged`** | 18834 → [#19048](https://github.com/podman-desktop/podman-desktop/pull/19048), `pr-merged` and `merged` on 2026-09-21: the pull request was opened and then reworked through seven more `pr-open` rounds from 09-02 to 09-04, with two amendments approved and four deferrals raised (three resolved) from what review asked for, each round re-verified and preflighted before the push. 18835 → [#19317](https://github.com/podman-desktop/podman-desktop/pull/19317), merged the same day after one review round and one amendment. 17221 → [#18562](https://github.com/podman-desktop/podman-desktop/pull/18562), `pr-merged … observed by refresh` on 2026-09-21, seven weeks after it was published. With 19901 and 18778 below, seven issues have now reached `merged`: four on `standard`, three on `quickfix` |
| **Two more `quickfix` issues to `merged`, one run as a skill** | 19901 → [#19902](https://github.com/podman-desktop/podman-desktop/pull/19902), 2026-10-27: `/pd:quickfix 19901` in a session transcript at 09:09, `triaged` with prior context naming the reviewer's request it came from, `pr-open` at 09:25, one more `pr-open … updated from 982b04665`, then `pr-merged #19902 observed by refresh` and `event:merged 1 pull request(s) merged` at 17:09 — the same day. 18778 → [#18779](https://github.com/podman-desktop/podman-desktop/pull/18779) merged too (`pr-merged … observed by refresh` on 2026-10-23), and the issue followed on 2026-10-29: `close --finish` read the rollup (1 merged, 0 open, 0 closed), wrote `event:merged 1 pull request(s) merged` and `worktree-remove DESKTOP-18778` |
| **Slices rejoined into one pull request after review, and the old ones superseded** | 19818, 2026-10-22 to 10-23: three slices cut by layer from one IPC signature change, published as [#19829](https://github.com/podman-desktop/podman-desktop/pull/19829), [#19830](https://github.com/podman-desktop/podman-desktop/pull/19830) and [#19831](https://github.com/podman-desktop/podman-desktop/pull/19831); review refused three, because each one merged alone broke the image checker. `slice join` made them one slice with a commit per old slice, published as [#19849](https://github.com/podman-desktop/podman-desktop/pull/19849), and `pr supersede` closed the three upstream — `pr-closed #19829 superseded by #19849`, and the same for #19830 and #19831, within nineteen seconds. What this exposed is in the 0.11.0 entry of `CHANGELOG.md`: the plan had said one slice, and the `hypothesis` and `ipc-contract` refusals in `slice set` exist because of it |
| **`close --finish` removing the worktrees of a squash-merged pull request** | `worktree-remove` for the issue's tree and its `verify-` tree right after `merged`, three times: 18832 on 2026-08-31, 18834 and 18835 on 2026-09-21. This is the refusal described below as recorded wrongly, now answered from `prs.json` |
| **The SessionStart summary, fired by the host** | session transcripts in the fork record `SessionStart:clear` attachments whose command is `${CLAUDE_PLUGIN_ROOT}/bin/pdkit hook session-start` and whose content is the summary itself (`pdkit: issue 18967 — pr-open, standard`, then `task`, `next`, `model`, `run`, `recent`) — sixteen firings, the handler launched by the host rather than by a self-test |
| **An approved amendment applied to the record and the tasks by command** | 18915 on 2026-10-19: `requirements-amended A1 — already reflected in the record, now recorded as applied: R1,R3,R5,R7,R8`, then `amendment-tasks A1 — withdrew T2,T3,T4`. A1 had been approved before 0.6.0 and mended by hand; `amendment sync` recognised the hand-mended record and finished the rest, which is the case it was written for |
| **Fourteen of the twenty-four skills invoked as `/pd:*`, and six agent types dispatched by name** | `doctor`, `sync`, `plan`, `plan-review` on 18832; `triage`, `exec`, `audit`, `slice`, `preflight` on 18967; `pr-sync` on 18889; `validate` and `pr` on 18833, 18835 and 18915; `close` on 18835; `quickfix` on 19901 — each a `<command-name>/pd:…` in a session transcript in the fork. The agents: `pd-scout`, `pd-plan-critic`, `pd-implementer`, `pd-auditor`, `pd-slicer`, `pd-thread-resolver` |
| **Windows, blocking and green** | `ci: Windows blocks again`, 2026-08-31: `continue-on-error` came off once the job reported 976 tests, 0 failures, and every CI run since blocks on all three platforms. Before that day it had tested **nothing** — `node --test 'test/*.test.js'` passes the pattern to node with its quotes, because cmd.exe does not strip single quotes, so it matched no files and exited 0, green for the whole life of the repository. Fixing that revealed the second one: `bin/pdkit` imported `lib/cli.js` by filesystem path, which ESM accepts on POSIX by accident and refuses on Windows as an unknown scheme `d:` — so **`pdkit` had never started there, and the gate had never refused a push on a Windows session**. Then 96 real failures, path separators in stored records and CRLF in captured stdout, ported over four commits during which the job reported without blocking. The lesson is the one below in three layers: the platform that could have seen this was the platform whose job was reporting success without running. `test/invariants.test.js` now holds the first two: no single quotes in the test script, and every dynamic import of a built path through `pathToFileURL` |

## Never executed, in order of risk

| What | Why it is not a detail |
|---|---|
| **The plugin as installed from a catalogue over the network.** It now loads from a marketplace entry in `settings.json` — but that entry's source is a local directory | Half the row closed on 18832: the manifest is found through `extraKnownMarketplaces` plus `enabledPlugins`, not only through `--plugin-dir`, and skills and agents resolve from it. What is still untested is the fetch: a marketplace pulled from a remote repository, which is the path every other user takes |
| **Ten of the twenty-four skills**: `editor`, `open`, `knowledge`, `pr-status`, `reset`, `resume`, `review-pr`, and `package-map`, `upstream-rules`, `worktree-kit`, which trigger by meaning. Fourteen have been invoked through a session; the row above lists them | Each skill body is prose, and prose is the half of this plugin that is not covered by anything. A skill that names a flag `pdkit` no longer has fails at the moment somebody is depending on it, and two of these were caught doing it: `/pd:preflight`, which ran, advised standing on a branch the graph had invented; `/pd:pr`, which did not run but was read and followed, documented a base `pr create` could not open against. **Not invoked is not the same as not exercised**, and the ten divide on it. `close --finish` finished 18248 and 18832, the `quickfix` route ran three times, `review fetch` and `review render` produced two reports, `pr list` and `drift` are routine — all through `pdkit` in a terminal, with the skill that wraps them never loaded (`close` and `quickfix` have since run as skills too). What is untested there is the prose: the part that says what to do with the output, in what order, and when to stop and ask |
| **Three of the seven hook events.** `pre-bash` has genuine firings in the journal, `subagent-stop` has host firings recorded as `agent-done` and watched by `pdkit doctor`, `session-start` has host firings in session transcripts (the row above), and `pre-write` is exercised by `owns:selftest` through the manifest | The self-test spawns the handler the way the host does, which proves the handler works and not that the host calls it. `post-write`, `pre-compact` and `prompt-submit` have never been seen fired by the host; `prompt-submit` shipped in 0.6.0. The receipt handler shows what that costs: it passed every test for four months while registered on `TaskCompleted`, an event subagents never raise. On 18832 a session *did* write plan and task files through the host's `Write` tool, so `post-write` was almost certainly called — and left no trace either way, because a handler that passes silently is indistinguishable from one that was never wired up. That is the same shape as the flake verdict below, and it is why this row needs an artefact rather than an absence of complaints |
| **`cascade`, and rebasing dependents.** Two slices with a stacked base ran end to end on 18967 — cut, verified, materialised, preflighted from the predecessor's branch, published — so that half of the row is closed. `cascade` itself has now run once, on 18967 on 2026-10-16, and stopped: `slice-regressed from #1: rebased none; conflicts on #2`. #19002 was then withdrawn by amendment A7 and closed unmerged, so no dependent has yet been carried through a rebase, and there is still no `slice-cascade` event | What the run found is in [the section above](04-contracts/pr.md#pdpr--the-only-place-that-writes-to-github): the graph carried a base the publish route could not express, and nothing between `slice set` and `gh` compared the two. Both ends now do. What remains untested is a review fix landing in a slice something else is stacked on, which is what `cascade` is for, and it needs a reviewer rather than a fixture |
| **`replyToThread` with both GraphQL mutations.** `pr-sync` itself has now run against real threads | Narrower than it was and no easier. On #18889 `pr threads` read four threads from two reviewers, `pd-thread-resolver` produced fixes for two of them, and two became approved amendments — everything up to the reply. The replies themselves were posted by the human, by choice, so `addPullRequestReviewThreadReply` and the resolve mutation are still unexecuted. That last step is the one that writes into somebody else's pull request, which is exactly why it will not be closed with synthetic material |
| **The `redo` route carried through to code** | The facts of a previous attempt are now collected correctly and `archaeology.json` is written by a real query, but no redo has reached a diff: that is a separate issue, not a separate task |
| **[Scenarios 12 and 13](10-scenarios.md#scenarios-the-brief-did-not-name) on our own work** | Run against somebody else's diff, and that is the boundary: `--from-pr` is verified from fetch to graph, while materialising a foreign PR hit the repository's own pre-commit hook on an old checkout. Branches from a foreign diff, and thread migration into new pull requests, remain unexecuted |
| **`pd-conflict-analyst`.** The conflicts it exists to classify have now happened | 18832's rebase produced one of each kind and both are journalled, so the material this row waited on arrived — but the session classified them itself rather than dispatching the agent, so what the agent does with a real conflict is still unknown. The narrower question that replaces this row: does a fresh-context read reach the same verdict as the session that wrote the code, on a conflict where the dangerous half never appeared as a conflict at all |

None of these blocks the work: each closes with the next issue of the right kind
rather than with a dedicated task.

## A refusal that was recorded as correct, and was not

`close --finish` on 18248 kept a worktree whose pull request had merged, and the
row above recorded that as the check working: the branch had landed upstream but
not into the local base, so the tree still held commits the base did not.

It was wrong, and it took a second issue to see it. On 18832 the same thing
happened — `close --finish` printed `pull requests: 1 merged` and then kept both
worktrees on the grounds that the branch was not merged into `main` — and this
time the local base was *not* the explanation. **Upstream squash-merges.** A
squashed branch's commits are never ancestors of anything, so `git branch
--merged` cannot answer yes about a merged pull request, ever. Two issues, two
identical outcomes, and one of them filed as evidence that the check worked.

The reason it read as correct the first time is worth keeping: a check that
refuses can be wrong in exactly one direction that never looks wrong. It said
"there might be work here", there was no work, and nothing about the refusal
distinguished caution from a rule that cannot fire. That is the same shape as the
flake verdict below, from the other end — silence looks like nothing happening,
and a refusal looks like something being caught.

The answer is the one this document reaches everywhere else: ask the record.
`prs.json` says the pull request merged, which is the fact `close` had already
printed two lines earlier. Ancestry stays as the fallback for a branch no pull
request knows about, which is most of them.

## A verdict that could not be reached, in three layers

Flake detection sat in the "never executed" table from the first version, and the
reason was assumed to be a shortage of flakes. It was not. Between the check and
its data were three defects, each of which alone was enough to silence it, and
each found only by watching the real thing fail to happen on #18779.

1. **The data was never requested.** `checkRunsForCommit` read a commit's check
   runs without `filter=all`, and that endpoint defaults to `filter=latest` — one
   run per check name. After a re-run the failure is simply absent. Measured on
   one commit: `latest` returns 1 run for `k8s sanity e2e tests`, `all` returns 3.
2. **The data was requested only when it could not help.** `refresh` fetched the
   per-commit runs only when some check was *currently* red — that is, it asked
   "did this job answer twice" exactly when the answer had to be no, because the
   ordinary flake is red, re-run, green, and nothing is red by the time anyone
   looks.
3. **The verdict was unreachable even with the data.** `judge` returned `pass` on
   a green conclusion before it ever compared the runs, so the only flake it
   could have reported was one still red — while the comment beside it named the
   opposite case, "a re-run that went green is exactly what hides this".

The test that should have caught the first was present and named for it, and it
stubbed the response: it proved the parser kept two runs, never that the request
asked for them. That is the second time here a test proved its own fixture rather
than the behaviour it was named for.

The general shape is worth keeping, because it has now cost three findings in one
day: **a check that never fires is not evidence that the condition never occurs.**
Silence is the one result that looks identical whether the mechanism works or was
never wired up, which is why section 13 requires an artefact to *remove* a row and
not merely the absence of complaints.

## Measurements that settled a question by refusing to buy something

Two open items were closed by measuring them, and both measurements ended in
buying nothing.

- **The honest form of `Patch comes off`** costs 152 s per slice on a warm tree
  (`test:unit` 85 s, `typecheck` 36 s, `test:main` 24 s, `lint:check` 3 s,
  `typecheck:main` 3 s) — that is, +100% per slice, or +26% narrowed to
  typecheck. Affordable, and still the wrong purchase, for the reason in
  [section 11 item 8](11-known-weaknesses.md). What the measurement produced instead was the rename: the
  caveat had been living in an HTML comment while a green tick rendered under a
  header reading `Reverts cleanly`. A comment is not visible in what a person
  reads, and the tick claimed more than the check did.
- **The GraphQL cost of the dashboard** is 32 points out of an hourly 5000 for a
  ten-PR sweep, and 37 seconds. Seconds are the constraint, not the budget, so no
  cache was introduced — and the answer the item had proposed for the day the
  limit was hit turned out to be wrong on its own terms, since CI completion does
  not move `updatedAt`. What the measurement produced instead was the finding
  that the dashboard never said **when** it had read a row.

## Calibration of the guessed thresholds

Four numbers in the config were common sense. `pdkit stats` measures the
population they are about: upstream's median merged pull request is 2 files and
34 lines, p90 is 10 files, and time to merge is p90 two days. The `quickfix`
thresholds therefore cover not a rare case but the majority — 71% of merged pull
requests touch ≤ 3 files and 40% fit in 20 lines. A fourteen-day stale window
looks generous against that population (20 of 78 open pull requests are past it),
**but the sample is sorted by creation date and is never wider than eleven days**,
so it under-counts precisely the slow tail the threshold is about. What to do
with the numbers stays with the owner: the command recommends nothing and writes
nothing.

## Cost of a cycle

`pdkit cost` (`lib/cost.js`) measures tokens spent per issue against the size of
the work, so that a cycle that got cheaper can be told from a cycle that was
smaller. Sources: Claude Code's transcripts (`~/.claude/projects/<slug>/`,
subagents under `<session>/subagents/`), the journal, and each issue's records
read through the modules that own them. A call belongs to the issue of the
nearest earlier journal entry within six hours; the phase is set by that issue's
last state transition. The scale is cost units, `input + 0.1·cache-read +
1.25·cache-write + 5·output`, ×5 on Opus: list-price ratios rather than dollars,
so a price change does not read as progress. Issues are grouped by route and
never compared across routes. `--snapshot` writes `$PDKIT_HOME/cost/<date>.json`,
and `--compare <date>` sets that snapshot against the issues journalled after it.

Two properties of the transcripts decide whether the numbers are right, and the
first analysis missed both. **One API response is written as one line per
content block**, each with the same `message.usage`, so summing lines counted
most calls twice; calls are keyed by `message.id`. **Subagent calls are in their
own files**, not in the session's, and `isSidechain` is absent from a third of
the parent's lines; the split is by file.

The baseline (2026-10-16, six `standard` issues, 4332 calls) is 13.3 M units per
task and 160 k per changed line, with 12% of calls attributed to no issue. The
dearest phases are `pr` and `pr-sync`, at 33–60% of a cycle, and 82% of the
dearest cycle is cache reads. Like `stats`, the command recommends
nothing; it prints the unattributed share and its caveats every time.

---

**In brief** — [`architecture/`](../architecture/README.md): [7 · Known weaknesses](../architecture/07-known-weaknesses.md)

**In practice** — [`workflows/`](../workflows/README.md):

- [Calibrating the thresholds](../workflows/reference/thresholds.md)
- [Measuring what a cycle costs](../workflows/reference/cost.md)

← [12 · Delivery order](12-delivery-order.md) · [Contents](README.md)
