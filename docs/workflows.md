# Workflows

Every use case the plugin covers, grouped by what you are trying to do. Each one
names the commands and the decision points that stay yours.

- **Part I — [Choosing and starting work](#part-i--choosing-and-starting-work)**
  · [pick from the backlog](#0-picking-what-to-work-on)
  · [a bug fix](#1-a-bug-fix)
  · [a one-line fix](#2-a-one-line-fix)
  · [a feature in several pull requests](#3-a-feature-cut-into-several-pull-requests)
- **Part II — [Proving it works](#part-ii--proving-it-works)**
  · [validation with evidence](#4-validating-against-the-running-application)
  · [work that was tried and reverted](#5-work-that-was-already-tried-and-reverted)
  · [an answer instead of a diff](#6-an-issue-that-ends-in-an-answer)
- **Part III — [Living with an open pull request](#part-iii--living-with-an-open-pull-request)**
  · [a stale PR](#7-a-pull-request-that-has-gone-stale)
  · [feedback after the merge](#7a-feedback-that-arrives-after-the-merge)
  · [coming back after a break](#8-coming-back-after-a-break)
  · [the reviewer rejected the approach](#9-the-reviewer-rejected-the-approach-not-the-diff)
  · [a PR replaced by another](#10-a-pull-request-replaced-by-another)
  · [splitting an already-open PR](#11-upstream-asks-you-to-split-an-open-pull-request)
  · [work that predates the plugin](#12-work-that-predates-the-plugin)
  · [reviewing someone else's PR](#13-reviewing-someone-elses-pull-request)
  · [two issues at once](#14-two-issues-at-once)
  · [a task that keeps failing](#15-a-task-that-has-failed-three-times)
  · [starting one issue over](#16-starting-one-issue-over)
- **Part IV — [Reference](#part-iv--reference)**
  · [preflight](#what-preflight-actually-runs)
  · [the push gate](#the-push-gate)
  · [ownership](#the-ownership-hook)
  · [receipts](#receipts)
  · [thresholds](#calibrating-the-thresholds)
  · [decision points](#decision-points-that-stay-yours)
  · [knowledge](#revising-what-the-plugin-thinks-it-knows)
  · [where state lives](#where-the-state-lives)

**What works today:** every scenario below has machinery behind it and is covered
by tests. **What has been proven against a live repository is narrower**, and the
difference is worth knowing before trusting a step — section 13 of
[`specification.md`](specification.md) keeps the full accounting, with evidence
per row. In short: the `quickfix` and `standard` routes have each gone end to end
to a published upstream pull request, once as a two-slice graph into two of them,
and one issue has been through the whole machine to `merged` with a reviewer and
a rebase in the middle. Much of that was driven through `pdkit` in a terminal —
so twelve of the twenty-two skills below have never been invoked as `/pd:*`.

## Before anything

```
pdkit doctor                  # required tools, config, hook wiring
pdkit doctor --gate-selftest  # drives every forbidden command through the real hook
```

Run the second one after installing, after upgrading, and after touching anything
under `lib/hooks/`. It is the only check that answers "is the gate actually on" —
every unit test in the suite stays green while a plugin with a broken manifest
gates nothing at all.

---

# Part I — Choosing and starting work

## 0. Picking what to work on

```
/pd:triage             → shortlist; nothing is written and nothing moves
pdkit issue list --label "area/terminal" --limit 20
```

`/pd:triage` without a number answers a different question from the rest of this
file: not "how do I do this issue" but "which issue". One GraphQL request brings
back the open backlog with the facts that say whether an issue can be started at
all — pull requests referencing it **in this repository**, who it is assigned to,
whether a maintainer has answered, whether a bug report carries a reproduction,
and how long since a human last touched it.

Two of those are worth spelling out, because both looked fine while being wrong:

- **Idle time is measured from human activity, not `updatedAt`.** The stale bot
  posting a notice moves the timestamp. Sorted on `updatedAt`, an issue whose
  last human comment was five months ago sits at the top of the list.
- **A cross-reference from another repository is not a linked pull request.**
  Somebody's prototype repo can reference an upstream issue, and a merged PR over
  there says nothing about whether the work exists here.

What the listing does not do is pick. The order is over facts; whether a
requirement is clear enough to plan against is not a fact, and that is the part
that decides. Read the top few, then triage one.

## 1. A bug fix

```
/pd:triage 12345      → route, drafted requirements
/pd:plan 12345        → reconnaissance, open questions, plan     [you approve]
/pd:plan-review 12345 → adversarial review of the plan
/pd:exec 12345        → implementation, one task per worker, receipts
/pd:validate 12345    → evidence from the running application
/pd:audit 12345       → diff against plan, fresh context
/pd:slice 12345       → usually one slice                        [you approve]
/pd:preflight 12345   → deterministic gates
/pd:pr 12345          → branch, PR body, PR                      [you confirm push]
```

## 2. A one-line fix

```
/pd:triage 12908      → route: quickfix
/pd:quickfix 12908
/pd:preflight 12908
/pd:pr 12908                                                     [you confirm push]
```

Planning is skipped on purpose. If the diff fits in one sentence, a plan is
overhead — and the threshold in config is a defence against ceremony, not an
optimization.

If the fix outgrows the thresholds, `pdkit issue escalate 12908` sends it back to
triage. That ordering is not bureaucracy: requirements derived from a diff you
have already written describe what you built rather than what was needed.

## 3. A feature, cut into several pull requests

The full path. `/pd:slice` will usually produce 2–5 pull requests, and the plan
has to have anticipated that: a diff planned without slicing in mind cannot be
cut apart afterwards without redoing the work.

```
/pd:slice 12345       → graph of slices, each one verified       [you approve]
/pd:pr 12345          → per slice: branch, preflight, body, PR   [you confirm each]
```

What happens under those two lines:

```
pdkit slice suggest --issue 12345 --json     facts: file → package → layer → task → R-IDs
pdkit slice set --issue 12345 --from f.json  refuses a graph that cannot work
pdkit slice verify --issue 12345 --all       builds each slice alone, from main
pdkit slice render --issue 12345             slices.md, verified columns included
pdkit state 12345 --to sliced                                    [you approve]
pdkit slice materialize --issue 12345 --slice 1 --subject "…"
pdkit preflight 12345 --slice 1              … then the body, the second pass,
                                             the gate, and the next slice
```

**A slice is a base plus a set of files.** Verification runs before any branch
exists, so what gets built is the diff restricted to those files, applied to a
scratch worktree from `main`.

**Green standalone means the slice branches from `main`. Red means it needs a
stack** — and the red run is the evidence for the stack, not a failure to fix.
Independence is preferred because a stack is fragile: after #1 merges, #2 needs
its base switched and its review threads point at lines that moved.

What the machine refuses, so the slicer does not have to be trusted with it: two
slices sharing a file, a changed file in no slice, a cycle between bases, a public
API change mixed into another layer or merging after it, an R-ID that reaches no
slice.

What stays judgement: whether a slice justifies itself without the next one.
Upstream does not accept dead code staged for a future PR.

**Verification is re-checked, not remembered.** `slices.json` stores the digest of
the diff that was verified; preflight recomputes it and fails on a mismatch. On a
materialized branch that doubles as proof the branch is what was verified.

If a review fix lands in a slice that others are stacked on:

```
pdkit slice cascade --issue 12345 --from 1    rebase the dependents, verify again
```

Anything that stopped being green is reported, not rebased into a lie.

---

# Part II — Proving it works

## 4. Validating against the running application

Between `/pd:exec` and `/pd:audit`, and the only phase that looks at the
application rather than at the code.

```
/pd:validate 12345    → evidence, an e2e candidate, and validation.md
```

What happens under that line:

```
pdkit validate steps  --issue 12345          requirements, Done when, e2e decision
pdkit validate launch --issue 12345 [--build]  the app, with CDP on
                                             → Playwright MCP attaches here
pdkit validate attach --issue 12345 --title … --evidence shot.png --observed "4.6:1"
pdkit validate codify --issue 12345 --spec tests/playwright/src/specs/x.spec.ts
pdkit validate run    --issue 12345          the run PASS rests on
pdkit e2e stability   --issue 12345          three in a row, stopping at the first red
pdkit validate finish --issue 12345          outcome, validation.md, transition
pdkit validate stop   --issue 12345
```

**PASS is an attached artefact, not a claim.** `attach` has no `--status`: a
captured run produces pass or fail, a screenshot with an observation produces
`observed`, and a step with neither is `unverified`. There is no input through
which "I read the code and it looks right" becomes a pass.

**The promise is narrower than it sounds, on purpose.** No code here can confirm
that what appeared on screen was correct. PASS means an artefact was captured;
whether the artefact shows the right thing stays with you and the reviewer.

**`unverified` does not stop the pipeline.** Without Playwright there would be no
way out of `implemented`, and a gate that expensive gets routed around. What stops
the gap from vanishing is the other end: `validation-evidence` in preflight refuses
a pull request body that does not name the undemonstrated steps under `Notes for
reviewers`. An unverified step nobody mentions reads exactly like a verified one.

**A new e2e test runs three times in a row before it counts**, and the series is
tied to a digest of the spec: edit the test afterwards and preflight fails asking
for a re-run rather than passing on a stale series. A flake carried into someone
else's repository is the worst thing this workflow can deliver.

## 5. Work that was already tried and reverted

```
/pd:triage 12775       → route: redo
pdkit issue history 12775
```

Triage takes this route when it finds a merged pull request and a revert. The
archaeology comes first, and `pdkit` holds that ordering rather than asking for
it: on the redo route the issue **cannot leave `triaged`** until
`archaeology.json` exists, and that file is written only when GitHub has actually
been asked. A summary cannot produce it, for the same reason a convincing account
of a test run cannot produce a receipt.

One call brings back the attempt, what reverted it, how long it lived in the base
branch, what reviewers said at the time, what merged in those files afterwards,
and what could not be established. `pd-archaeologist` then answers what the facts
cannot: why it was reverted, and whether that reason still applies.

Two things are easy to get wrong here, and both were found on a live issue:

- **A revert references the pull request it reverts, not the issue.** Asking the
  issue's timeline alone reports a merged attempt and no revert — which reads as
  "this landed and is still there".
- **The attempt and its revert have to be paired, not picked by date.** The newest
  merge on an issue can easily post-date the revert; pairing them by recency
  produces an attempt its own revert predates, with review comments from the wrong
  pull request.

Carry the regression into the requirements alongside the original ask. A redo that
satisfies only the original one lands and is reverted for the same reason.

## 6. An issue that ends in an answer

The bug is real and reproduces, and the cause is not in this repository — a
version skew between a client and the machine it drives, a host setting, a
dependency. There is nothing to change here, and there is still work: a
reproduction, a command that separates this problem from its look-alikes, and a
workaround.

```
/pd:validate 12345    → attach the reproduction as evidence
pdkit findings new --issue 12345
pdkit state 12345 --to answered
```

**Entry is guarded by a capture.** `answered` is refused while nothing is
attached, and for a specific reason: a workaround nobody ran is a suggestion, and
a suggestion posted in the voice of a finding costs the reporter their evening.

`findings.md` asks for two things that are easy to skip — a detector command, and
what would have kept this from reaching a user. An environmental cause is a reason
not to change this repository; it is not a reason for the repository to say
nothing.

**Publishing is a human action.** `gh issue comment` is denied by the hook from
every state, with no way to open a gate for it.

**`answered` is not the end.** At the moment the findings are posted you are
waiting on the reporter, and three things happen: they confirm, and the issue goes
to `resolved`; the answer turns out to imply product work, and it goes back to
`planned`; nobody replies, and it goes to `abandoned`.

```
pdkit close --issue 12345 --finish --confirmed "@reporter, 2026-08-09"
```

`--confirmed` is required and takes a fact about them, not a verdict about us:
deciding on our own that somebody else's problem went away is not ours to decide.

---

# Part III — Living with an open pull request

## 7. A pull request that has gone stale

```
/pd:pr-status                        → what is open, what is blocked, how idle
/pd:pr-sync 17577                    → threads, fixes, replies
```

What the dashboard tells you, and what it deliberately does not:

```
pdkit pr list                        every row, and how old its reading is
pdkit pr refresh 17577               read GitHub into prs.json
pdkit pr ci 17577                    the CI verdict, plus the failure text
pdkit pr threads 17577               bots collapsed, threads mapped to slices
```

**`pr list` is local, and every row says when it was last read** — `read:3d`, with
`←` past six hours. A sweep of ten pull requests was measured at 32 GraphQL points
and 37 seconds, so nobody refreshes everything before every glance; that makes an
old row the normal case, and a verdict from three days ago used to print exactly
like one from a second ago. Refreshing by "what looks recently touched" does not
work either: CI finishing does not move a pull request's `updatedAt` — measured,
eight of eight.

**A red job has two possible meanings and they are measured apart.** `fail` is red
here and green on other people's open pull requests. `inconclusive` is the same
job red on theirs too — a warning, not a block, because refusing to proceed over
something the change did not do teaches people to work around the gate. `flake` is
the same job answering twice on one commit. A `pending` job prints its age: a check
stuck IN_PROGRESS since June is a finding about the pull request, not about CI.

**And for the jobs that are yours, the log comes with the verdict.** The window is
anchored on the runner's `##[error]`, so what precedes it is the output that led
there — measured because a plain tail showed credential cleanup and no failure.
The other verdicts do not fetch one: `inconclusive` describes someone else's
problem and `flake` is already the finding. `--no-logs` for the sweep.

**Threads are not the whole of the feedback.** Review submissions and top-level
comments come back too, and on a stale PR that is usually where the blocking
comment is. Bots are collapsed to one line with a link — never dropped, and an
escalation word expands one back.

Publishing takes two tokens, because they are two different acts of consent:

```
pdkit gate open --issue 17221 --branch <b>              push, per branch, spent on use
pdkit gate open --issue 17221 --pr 17577 --kind reply   replies, per PR, covers the batch
```

## 7a. Feedback that arrives after the merge

The pull request is merged and a reviewer asks something anyway. It happens, and
it is not a defect in anybody's process: on #18561 the question came a week after
the merge and was a good one — what does a very long container command do to the
display?

There is nothing to push, so `/pd:pr-sync` has nothing to drive. What is left is
a decision, and the decision has to survive the issue closing.

```
pdkit defer new --issue 18248 --pr 18561 --raised-by simonrey1 --kind bug \
  --what "a very long container command may break the interface display; it needs an ellipsis plus a tooltip in the renderer" \
  --url https://github.com/podman-desktop/podman-desktop/pull/18561#issuecomment-5266241008
```

That writes a journal entry and drafts the follow-up issue under
`deferrals/D1.md`. **Opening the issue is yours** — `gh issue create` is denied
at the hook from every state.

**The draft is laid out in upstream's own issue form**, so you open the issue
through the template in the GitHub UI and copy field by field. `--kind` picks
which form: `bug` (default), `feature` or `task`, matching
`.github/ISSUE_TEMPLATE/` upstream. The headings in the draft are that form's
field labels, so the posted issue reads like every other one in the repository
rather than like something a tool produced. The operating system and the version
are filled in from the machine and the checkout.

**The title comes first**, under its own heading, because it is the first field
of the form and not part of the body. It is derived from `--what`, and `--title`
overrides when the two differ — a feature request is titled by what should exist,
while `--what` records what was set aside. It is never truncated: upstream titles
run to a hundred characters, and one cut mid-clause says less than a long one
while looking finished.

Screenshots get **visible placeholders**, one per image found under the issue's
`evidence/` directory:

```
**[SCREENSHOT 1 — replace this line by dragging in `long-cmd-token-summary.png`]**
```

Visible rather than an HTML comment, deliberately: a comment renders as nothing,
so one left unreplaced reaches the issue invisibly — the same defect this
repository has fixed three times elsewhere. Posted unreplaced, that line is
obvious to you and to the reader.

**Why this is a new issue rather than a wider pull request.** The one that merged
fixed a conversion in the logic: the container command was not being joined.
Truncation, an ellipsis and a tooltip are the renderer's. Putting both in one
pull request would have made a one-line fix into a UI change, sent it to a second
domain owner for review, and given preflight a slice spanning two layers to warn
about. "Out of scope" is not the argument; **the layer is**, and it is the
argument that survives being read by the reviewer who raised the point.

Then close the issue that is actually finished:

```
pdkit close 18248 --finish
```

It **warns rather than refuses**:

```
  ! D1 is still open, and closing does not settle it:
      a very long container command may break the interface display … — simonrey1, #18561
      https://github.com/podman-desktop/podman-desktop/pull/18561#issuecomment-5266241008
      `pdkit defer resolve D1 --issue 18248 --follow-up <n>` when you open one.
DESKTOP-18248 is merged
```

Closing is the last step, so there is no later gate this could be caught at —
which sounds like an argument for refusing until you notice the other half: a
gate standing between a finished issue and its terminal state gets paid every
time and earns its keep almost never. What keeps the promise is not the gate. It
is that the journal is append-only, so `pdkit defer list --issue 18248` still
answers after the issue is `merged`, and `pdkit journal --issue 18248` still has
the line.

```
pdkit defer list --issue 18248            # what is outstanding
pdkit defer list --issue 18248 --all      # including what has been settled
pdkit defer resolve D1 --issue 18248 --follow-up 18604
pdkit defer drop D1 --issue 18248 --reason "asks about a code path the fix removed"
```

`drop` takes a reason for the same purpose `task unblock` does: it is the only
record of why something a reviewer raised is not being done.

## 8. Coming back after a break

```
/pd:sync
/pd:resume 12345      → upstream drift, rebase, conflicts
/pd:preflight 12345
/pd:pr 12345
```

`pdkit drift 12345` measures each slice from **its own** branch point, and says
separately which upstream commits touched lines the plan cites. A commit in the
file is a candidate for a mechanical conflict; a commit in those lines is a
candidate for a semantic one, and semantic means stop.

A previous green preflight means nothing after a rebase.

## 9. The reviewer rejected the approach, not the diff

An ordinary outcome of review in somebody else's repository, and for a long time
the machine had no way to say it: the only moves from an open pull request were to
push again — which assumes the design survived — and to abandon an issue still
worth doing.

```
pdkit issue rework 12345 --reason "maintainer wants this in the provider, not the UI"
```

The pull request stays open and the branch is untouched. The issue returns to
`triaged`, **not** to `planned`: the route is picked again and planning starts from
the issue rather than from the diff that was refused. The requirement set thaws,
because an objection to an approach is usually a requirement nobody wrote down; the
identifiers keep their numbers, because an R-ID means one thing forever.

Not to be confused with [starting over](#16-starting-one-issue-over). A rework
keeps everything and adds the objection as a requirement; a reset forgets the lot.
When a reviewer has told you what is wrong with the design, that sentence is the
most valuable thing the review produced.

## 10. A pull request replaced by another

A rework produces a second pull request, and the first one gets closed. Closed is
not the same as rejected, and the difference decides whether the issue is finished:

```
pdkit pr closed 17577 --superseded-by 18562
```

Without this, the rollup treats every closed pull request as unfinished work —
right when a maintainer rejected it, wrong when a rework replaced it. With it, the
issue settles once the replacement merges. What that rests on is the successor's
own state, not the sentence in the reason field.

## 11. Upstream asks you to split an open pull request

```
pdkit slice suggest --issue 17221 --from-pr 17577
pdkit pr threads 17577               which new slice each existing thread moves to
```

The same slicer, with a published diff substituted for the local one. The
substitution holds through the whole chain — `suggest`, `set`, `verify` — because a
flag that redirects the source in one command of a chain is not half a feature; it
is a feature that does not work.

## 12. Work that predates the plugin

A branch and a pull request exist, and `state.json` says `new`. Walking it through
the whole chain so the record "agrees" would mean writing a plan nobody planned and
freezing requirements nobody stated.

```
pdkit issue adopt 17577 --pr 17577 --branch DESKTOP-17577/… --reason "open two months, predates the plugin"
```

Adoption records what exists — state, route, PR number — marks the record `adopted`
with the reason, and stops. The artefacts of the states it never passed stay
missing, and `adopted` explains why: an issue with no plan because nobody wrote one
and an issue whose plan was lost are different things. Only from `new`: overwriting
a live record would erase the one history that cannot be rebuilt.

## 13. Reviewing someone else's pull request

```
/pd:review-pr 2903
```

Outside the issue lifecycle entirely. Nothing moves a state machine, and nothing is
published — the report lands in `$PDKIT_HOME/reviews/2903.md`, and posting it is a
human action in your own words.

```
pdkit review fetch 2903 --json      files by layer, public API, schemas, SPDX,
                                    the linked issue, the threads reviewers
                                    already opened, CI status
pdkit review render 2903 --values v.json [--reveal]
```

The diff is read locally, from `refs/pull/2903/head` against where that pull request
branched. Against the tip of `main` it would carry every commit that landed since,
and the review would ask the author about work they never did.

Then four axes in parallel — architecture, API compatibility, tests, product — and
`pd-review-synth` to dedupe and reach one verdict.

### What comes out

A file with a fixed shape, rendered from `templates/review-report.md` rather than
written free-hand, so a section cannot go missing by being forgotten:

```markdown
# Review: PR #2903 — <title>

Verdict: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES | NEEDS_DISCUSSION
Confidence: high | medium | low — and why

## Requirement fit                                  ← one row per issue requirement
| Issue requirement | Covered | Where |
## Blocking (correctness, compatibility, data loss)
## Should fix before merge
## Nits (author's discretion)
## Questions for the author
## What I could not verify
```

Three of those carry the discipline, and each exists because of a way reviews go
wrong:

- **`Confidence` takes a reason, not just a word.** "high" on a PR whose area you
  have never opened is the failure this field exists to make visible.
- **`What I could not verify` is mandatory and rarely empty.** What cannot be
  established by reading, which steps need a human, which platform was not
  exercised. A review that reads as complete when it is not is worse than one that
  admits its edges.
- **`Requirement fit` needs the linked issue**, which is why `review fetch` reads
  it. Without it the table is filled with guesses about what the author was asked
  to do.

`--reveal` opens the finished report in your file manager; where there is no
desktop it says so and carries on.

**The report can be in your language while everything published stays English.**
`languages.review_report` in the config decides — the report is read by you, and
the comment you eventually post is written by you, so nothing about it has to
match what upstream sees.

### Two rules, both from experience

A reviewer told to find problems will find them in correct code, so **an empty
section is a valid result** — the axis prompts forbid reporting style, demanding
defensive code for impossible cases, and "this could be more abstract".

And **commit scope is never mentioned**: upstream does not require it, it is our
own discipline, and `pdkit review fetch` deliberately never reports it. Spending an
author's attention on a rule their project does not have is how a review loses the
standing to raise the ones it does.

## 14. Two issues at once

```
pdkit worktree create --issue 12345
pdkit worktree create --issue 12908
```

One tree per issue, beside the fork rather than inside it. State lives in
`$PDKIT_HOME` keyed by issue, so both trees see the same plan, receipts and slice
graph — while the *active task* pointer is per tree, which is what lets two trees
run two tasks of the same issue without either ownership hook guarding the wrong
files.

`pdkit worktree remove --issue 12345` refuses while the tree holds a branch that has
not landed: removing it takes the commits with it and says nothing.

## 15. A task that has failed three times

```
pdkit task attempts --issue 12345
pdkit task unblock --issue 12345 --task T1 --reason "plan amended: A1 splits the fixture"
```

Every failed capture of `Done when` is counted, and the count comes from the
captures rather than from anyone's account of them. At `exec.max_attempts` — three
by default, zero switches it off — the task is blocked in three places, because
there are three ways past it: the completion hook, `pdkit task start`, and the
summary a new session prints. That last one matters most: three failures live in
the context a restart just discarded.

**The reason on `unblock` is required, and it is the whole mechanism.** Twice, "fix
it and try again" is right. The third time it is the advice that built the loop, and
the question worth forcing is what changed between the second attempt and the third.
If nothing did, the plan is wrong rather than the code.

## 16. Starting one issue over

Sometimes the answer to a failing task is not a fourth attempt. The triage read
the issue as something it is not, or the scouts mapped the wrong package, and
everything since has inherited that — because every step reads what the steps
before it wrote. Continuing costs more than restarting.

```
pdkit reset 12345             # what would go, and what would stay. Writes nothing
pdkit reset 12345 --confirm   # do it
/pd:triage 12345              # from nothing
```

The record is **removed rather than moved**, so the machine reads the issue as
`new` — its own word for nothing has happened here — and `triaged` is the only
exit. There is no transition back to `new` and there deliberately is not one: it
would put a trip in the history that the work never took, and the distinction
between "these artefacts were never produced" and "these artefacts were lost" is
what every later check rests on.

It touches **one** issue. Its neighbours keep their records, their tokens and
their worktrees, and the match is exact rather than by prefix — `DESKTOP-1854`
does not select the tree of `DESKTOP-18548`.

Read the dry run's second half before agreeing to it. Three things stay, and one
of them surprises people:

- **an open pull request stays open.** This forgets it; it does not close it. If
  starting over means the published attempt should not stand, closing it is a
  human action on GitHub. Nothing is lost by forgetting it — dedup is the first
  step of triage, so the next cycle finds it again from GitHub.
- **the journal keeps every entry** and gains one saying what was reset and where
  its artefacts went. It is append-only by construction, which is what keeps the
  earlier attempt legible six months later.
- **deferrals survive**, for the same reason they survive a merge: a promise made
  to a reviewer is not undone by us starting again locally.

Artefacts are archived rather than deleted — `$PDKIT_HOME/archive/<issue>/<time>/`,
which nothing reads and one `mv` restores. `--purge` deletes instead.

Worktrees are not removed unless you ask:

```
pdkit reset 12345 --confirm --worktrees
```

and removal still refuses a tree holding a branch that has not landed. A branch
with unpushed commits is work, not a record of work, and a command called "start
over" must not be the thing that drops it.

### Three things this is not

| Situation | What it actually is |
|---|---|
| a reviewer refused the **approach** | `pdkit issue rework` (scenario 9). Their objection is the most valuable thing the review produced; a reset throws it away |
| the work was tried before and **reverted** | the `redo` route (scenario 5). The reason it was backed out was written down at the time, and rediscovering it by re-implementing is what that route exists to prevent |
| the issue is **not worth doing** | `pdkit state <n> --to abandoned --reason "…"`. A reset says nothing about whether the work should happen |

---

# Part IV — Reference

## What preflight actually runs

`pdkit preflight <issue>` runs twenty-one checks, and on podman-desktop it takes
minutes, because it runs the repository's real scripts. Script names are resolved
from the repository's own `package.json` — there is no `pnpm lint` there, and
`pnpm test` drags in the e2e suite.

Three results, and the difference between them matters:

| | Meaning |
|---|---|
| **pass** | the check ran and was satisfied |
| **skip** | the check did not run, and the summary says why |
| **fail** | blocking, unless the check is advisory (`debug-leftovers`, `quickfix-size`) |

A skip is never a pass. `steps-to-check` skipping because no PR body exists yet
means that check has not run at all.

**`working-tree` is first, and red there invalidates the rest.** The file checks
read the committed diff; the command checks run whatever is on disk. On a clean tree
those are one thing. On a dirty one the report mixes two, and it can go green on a
diff that will not be pushed.

### The two passes

Six checks read the PR body, and the body depends on preflight — `Notes for
reviewers` is mandatory exactly when preflight flags something CI cannot judge, and
equally when validation could not demonstrate a step. One pass cannot close that
loop, so:

```
pdkit preflight 12345                                   # pass 1, no body
pdkit render prBody --issue 12345 --values v.json --strip-comments > body.md
pdkit preflight 12345 --body-only --body body.md        # pass 2
```

Green on pass 2 is what the gate is issued from. Pass 1 alone is not enough, and
`--body-only` without `--body` is refused rather than reported green.

## The push gate

Nothing reaches GitHub without a consent token, and a token is issued for one
branch, expires in ten minutes, and is spent on first use.

```
pdkit gate open --issue 12345 --branch DESKTOP-12345/slug
git push origin DESKTOP-12345/slug
pdkit pr create --issue 12345 --branch DESKTOP-12345/slug --title … --body body.md
```

`gate open` refuses unless the issue is in `preflight-green` and the branch belongs
to that issue. Both are checked inside `pdkit` rather than asked of the caller.

Refused without a token, and refused the same way whether you type it or an agent
does:

- `git push` in any shape — chained behind `&&`, in a subshell, in a command
  substitution, named by absolute path, or behind a wrapper program (`env`, `sudo`,
  `nice`, `nohup`, …)
- `gh pr create|edit|merge|review`, `gh issue create|comment|close`
- `gh api` with a mutating method, and `gh api graphql` carrying a mutation

Refused **always**, token or not:

- `git push --force` without `--force-with-lease`
- `git add -A` and `git add .`
- `git rebase -i` — the husky `commit-msg` hook adds `Signed-off-by` to a message
  that already has one, then rejects the duplicate it created. Squash with
  `git reset --soft <base> && git commit`
- `git commit --no-verify`

Ordinary work is untouched: `git status`, `git add <path>`, `git commit -m`,
`gh pr view`, `gh api` reads. If a refusal looks wrong, `pdkit doctor
--gate-selftest` says whether the gate is behaving; rephrasing the command is not a
fix, and the parser was written for exactly that attempt.

## The ownership hook

While a task is marked active in a working tree, writes outside that task's files
are refused:

```
pdkit task sync --issue 12345          # read the Owns sets out of the task files
pdkit task start --issue 12345 --task T1
…
pdkit task stop
```

`task sync` is not optional. Without it the state record has no ownership for the
task, and the hook allows every write while saying so — which reads as nothing
having happened.

Two allowances are deliberate. With no active task nothing is constrained: the rule
belongs to executing a planned task, not to having the plugin installed. And with a
task whose ownership was never synced, the write goes through with a message naming
the command that fixes it, because blocking there would make an unsynced plan look
like a broken tool.

What catches a worker that ran outside all of this is `pdkit audit`, which reports
every file changed outside every task's ownership. The hook catches it in time; the
audit catches it for certain.

## Receipts

A task is finished when the command in its `Done when` has been run and what it
printed has been recorded:

```
pdkit receipt write --issue 12345 --task T1
```

`pdkit` runs the command itself. There is no parameter for output text — the choice
between "the tests passed" and the test runner's own words is not offered — and the
digest it records over the captured block means a receipt edited afterwards stops
validating.

Completing a task without one is refused. So is completing one whose receipt records
a non-zero exit: that receipt is valid, and what it proves is that the work is not
done.

## Calibrating the thresholds

Four numbers in `config.yaml` were common sense: two quickfix bounds, the stale
window, and the attempt ceiling. `pdkit stats` measures the population they are
about — what upstream actually merges:

```
pdkit stats --limit 100
pdkit stats --limit 100 --author <you>    # once you have merged pull requests
```

It prints distributions of files changed, lines changed, time to merge and how long
open pull requests stay quiet, then puts each configured value beside what the
population did. It recommends nothing and writes nothing.

Read the sampling window it prints. `gh pr list` orders by creation date, so a
hundred merged pull requests are the last few weeks of work rather than a hundred
merges — which under-represents slow ones precisely because they are slow, and that
is the tail the stale threshold is about.

## Decision points that stay yours

The plugin stops and waits at exactly five places, and none of them can be automated
away:

1. Plan approval — after `[NEEDS DECISION]` items are resolved.
2. Slice graph approval.
3. Push confirmation — per branch, in the same turn, never carried over.
4. Plan amendments arising from review.
5. Anything added to `knowledge/`, whether proposed by `/pd:close` after one issue
   or by `/pd:knowledge` over the whole base.

Three more are decisions the plugin refuses to make rather than waits on: publishing
a review of someone else's pull request, commenting in the upstream tracker, and
posting the findings of an `answered` issue. All three are writes into a project that
is not ours, and all three are refused by the hook rather than gated.

## Revising what the plugin thinks it knows

```
/pd:knowledge
```

`knowledge/` ships with the plugin and is read by every later issue, so an entry that
quietly stopped being true costs more than a missing one.

```
pdkit knowledge check --json     dead paths, drifted layer order, entry shape
pdkit knowledge export --json    the base, for a one-way push to an external store
```

The check earns its keep immediately: on the machine this was written on it found
`slicing.layer_order` in `$PDKIT_HOME/config.yaml` still pinned to the value
`pdkit init` copied at stage 0, so three layers added two stages later had never
taken effect there. Arrays replace rather than merge — deliberately, so an edited
list is not silently re-extended — and the cost is that an unedited copy freezes.
`pdkit doctor` now reports that as `config:arrays`.

Nothing here writes to `knowledge/`. Additions are proposed and you approve them: a
base that grows on its own is a base people stop reading.

## Where the state lives

`$PDKIT_HOME`, default `~/.pdkit/podman-desktop` — **outside the fork**, so nothing
the plugin records can end up in a pull request.

```
pdkit state 12345             # where an issue is, and where it may go next
pdkit journal --issue 12345   # why it got there
```

`state.json` knows *where*; the journal knows *why*. "Why is slice #2 stacked rather
than branched from main" is recoverable six months later only from the journal, which
is append-only and never rewritten.

Almost every entry is written by whatever produced the fact. The exception is a
conflict, because nothing can observe one:

```
pdkit journal conflict --issue 12345 --kind semantic --file packages/main/src/plugin/exec.ts \
  --commit a3f21e --resolution "upstream replaced the callback the plan built on" --amendment A1
```

Two event names, `conflict-mechanical` and `conflict-semantic`, and no way to name a
third. A command that wrote any event would let `preflight-green` be typed beside the
one preflight measured, and a reader cannot tell a typed event from a produced one.

The append-only rule is what makes [starting over](#16-starting-one-issue-over)
safe to offer. `pdkit reset` clears the issue's artefacts, its consent tokens and
its active pointers — and writes one more journal entry rather than removing any,
so the attempt it forgets is still readable afterwards. Anything derived from the
journal reads it that way too: the attempt count stops at the last reset, because
the T1 after one is a different task from the T1 before it.
