# Workflows

Scenarios, in the order you are likely to hit them. Each names the commands and
the decision points that are yours rather than the plugin's.

**What works today:** scenarios 0 through 5 and 7, up to and including an open
pull request, its review, and coming back to it after upstream has moved.
Everything marked *(stage N)* below is registered but still a stub — the skill
says so rather than improvising. Publishing itself has been exercised once end
to end; replying to a live review has not (see the plan for stage 4).

## Before anything

```
pdkit doctor                  # required tools, config, hook wiring
pdkit doctor --gate-selftest  # drives every forbidden command through the real hook
```

Run the second one after installing, after upgrading, and after touching
anything under `lib/hooks/`. It is the only check that answers "is the gate
actually on" — every unit test in the suite stays green while a plugin with a
broken manifest gates nothing at all.

## 0. Picking what to work on

```
/pd:triage             → shortlist; nothing is written and nothing moves
pdkit issue list --label "area/terminal" --limit 20
```

`/pd:triage` without a number answers a different question from the rest of
this file: not "how do I do this issue" but "which issue". One GraphQL request
brings back the open backlog with the facts that say whether an issue can be
started at all — pull requests referencing it **in this repository**, who it is
assigned to, whether a maintainer has answered, whether a bug report carries a
reproduction, and how long since a human last touched it.

Two of those are worth spelling out, because both looked fine while being
wrong:

- **Idle time is measured from human activity, not `updatedAt`.** The stale bot
  posting a notice moves the timestamp. Sorted on `updatedAt`, an issue whose
  last human comment was five months ago sits at the top of the list.
- **A cross-reference from another repository is not a linked pull request.**
  Somebody's prototype repo can reference an upstream issue, and a merged PR
  over there says nothing about whether the work exists here.

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

If the fix outgrows the thresholds, `pdkit issue escalate 12908` sends it back
to triage. That ordering is not bureaucracy: requirements derived from a diff
you have already written describe what you built rather than what was needed.

## 3. A new feature, cut into several pull requests

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

What the machine refuses, so the slicer does not have to be trusted with it:
two slices sharing a file, a changed file in no slice, a cycle between bases, a
public API change mixed into another layer or merging after it, an R-ID that
reaches no slice.

What stays judgement: whether a slice justifies itself without the next one.
Upstream does not accept dead code staged for a future PR.

**Verification is re-checked, not remembered.** `slices.json` stores the digest
of the diff that was verified; preflight recomputes it and fails on a mismatch.
On a materialized branch that doubles as proof the branch is what was verified.

If a review fix lands in a slice that others are stacked on:

```
pdkit slice cascade --issue 12345 --from 1    rebase the dependents, verify again
```

Anything that stopped being green is reported, not rebased into a lie.

## 3a. Validating a change against the running application

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

**`unverified` does not stop the pipeline.** Without Playwright there would be
no way out of `implemented`, and a gate that expensive gets routed around. What
stops the gap from vanishing is the other end: `validation-evidence` in preflight
refuses a pull request body that does not name the undemonstrated steps under
`Notes for reviewers`. An unverified step nobody mentions reads exactly like a
verified one.

**A new e2e test runs three times in a row before it counts**, and the series is
tied to a digest of the spec: edit the test afterwards and preflight fails asking
for a re-run rather than passing on a stale series. A flake carried into someone
else's repository is the worst thing this workflow can deliver.

## 3b. Work that was already tried and reverted

```
/pd:triage 12775       → route: redo
pdkit issue history 12775
```

Triage takes this route when it finds a merged pull request and a revert. The
archaeology comes first, and `pdkit` holds that ordering rather than asking for
it: on the redo route the issue **cannot leave `triaged`** until
`archaeology.json` exists, and that file is written only when GitHub has
actually been asked. A summary cannot produce it, for the same reason a
convincing account of a test run cannot produce a receipt.

One call brings back the attempt, what reverted it, how long it lived in the
base branch, what reviewers said at the time, what merged in those files
afterwards, and what could not be established. `pd-archaeologist` then answers
what the facts cannot: why it was reverted, and whether that reason still
applies.

Two things are easy to get wrong here, and both were found on a live issue:

- **A revert references the pull request it reverts, not the issue.** Asking
  the issue's timeline alone reports a merged attempt and no revert — which
  reads as "this landed and is still there".
- **The attempt and its revert have to be paired, not picked by date.** The
  newest merge on an issue can easily post-date the revert; pairing them by
  recency produces an attempt its own revert predates, with review comments
  from the wrong pull request.

Carry the regression into the requirements alongside the original ask. A redo
that satisfies only the original one lands and is reverted for the same reason.

## 4. A pull request that has gone stale

```
/pd:pr-status                        → what is open, what is blocked, how idle
/pd:pr-sync 17577                    → threads, fixes, replies
```

What the dashboard tells you, and what it deliberately does not:

```
pdkit pr refresh 17577               read GitHub into prs.json
pdkit pr ci 17577                    the CI verdict, measured
pdkit pr threads 17577               bots collapsed, threads mapped to slices
```

**A red job has two possible meanings and they are measured apart.** `fail` is
red here and green on other people's open pull requests. `inconclusive` is the
same job red on theirs too — a warning, not a block, because refusing to
proceed over something the change did not do teaches people to work around the
gate. `flake` is the same job answering twice on one commit. A `pending` job
prints its age: a check stuck IN_PROGRESS since June is a finding about the
pull request, not about CI.

**Threads are not the whole of the feedback.** Review submissions and top-level
comments come back too, and on a stale PR that is usually where the blocking
comment is. Bots are collapsed to one line with a link — never dropped, and an
escalation word expands one back.

Publishing takes two tokens, because they are two different acts of consent:

```
pdkit gate open --issue 17221 --branch <b>              push, per branch, spent on use
pdkit gate open --issue 17221 --pr 17577 --kind reply   replies, per PR, covers the batch
```

Splitting an already-open pull request, when upstream asks:

```
pdkit slice suggest --issue 17221 --from-pr 17577
pdkit pr threads 17577               which new slice each existing thread moves to
```

## 5. Coming back after a break

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

## 6. Reviewing someone else's PR

```
/pd:review-pr 2903
```

Outside the issue lifecycle entirely. Nothing moves a state machine, and nothing
is published — the report lands in `$PDKIT_HOME/reviews/2903.md`, and posting it
is a human action in your own words.

```
pdkit review fetch 2903 --json      files by layer, public API, schemas, SPDX,
                                    the threads reviewers already opened
pdkit review render 2903 --values v.json
```

The diff is read locally, from `refs/pull/2903/head` against where that pull
request branched. Against the tip of `main` it would carry every commit that
landed since, and the review would ask the author about work they never did.

Then four axes in parallel — architecture, API compatibility, tests, product —
and `pd-review-synth` to dedupe and reach one verdict.

Two rules, both from experience. A reviewer told to find problems will find them
in correct code, so an empty section is a valid result. And **commit scope is
never mentioned**: upstream does not require it, it is our own discipline, and
`pdkit review fetch` deliberately never reports it.

## 7. Two issues at once

```
pdkit worktree create --issue 12345
pdkit worktree create --issue 12908
```

One tree per issue, beside the fork rather than inside it. State lives in
`$PDKIT_HOME` keyed by issue, so both trees see the same plan, receipts and
slice graph — while the *active task* pointer is per tree, which is what lets
two trees run two tasks of the same issue without either ownership hook
guarding the wrong files.

`pdkit worktree remove --issue 12345` refuses while the tree holds a branch
that has not landed: removing it takes the commits with it and says nothing.

---

## What preflight actually runs

`pdkit preflight <issue>` runs nineteen checks, and on podman-desktop it takes
minutes, because it runs the repository's real scripts. Script names are
resolved from the repository's own `package.json` — there is no `pnpm lint`
there, and `pnpm test` drags in the e2e suite.

Three results, and the difference between them matters:

| | Meaning |
|---|---|
| **pass** | the check ran and was satisfied |
| **skip** | the check did not run, and the summary says why |
| **fail** | blocking, unless the check is advisory (`debug-leftovers`) |

A skip is never a pass. `steps-to-check` skipping because no PR body exists yet
means that check has not run at all.

**`working-tree` is first, and red there invalidates the rest.** The file
checks read the committed diff; the command checks run whatever is on disk. On
a clean tree those are one thing. On a dirty one the report mixes two, and it
can go green on a diff that will not be pushed.

### The two passes

Six checks read the PR body, and the body depends on preflight — `Notes for
reviewers` is mandatory exactly when preflight flags something CI cannot judge,
and equally when validation could not demonstrate a step. One pass cannot close
that loop, so:

```
pdkit preflight 12345                                   # pass 1, no body
pdkit render prBody --issue 12345 --values v.json --strip-comments > body.md
pdkit preflight 12345 --body-only --body body.md        # pass 2
```

Green on pass 2 is what the gate is issued from. Pass 1 alone is not enough,
and `--body-only` without `--body` is refused rather than reported green.

## The push gate

Nothing reaches GitHub without a consent token, and a token is issued for one
branch, expires in ten minutes, and is spent on first use.

```
pdkit gate open --issue 12345 --branch DESKTOP-12345/slug
git push origin DESKTOP-12345/slug
pdkit pr create --issue 12345 --branch DESKTOP-12345/slug --title … --body body.md
```

`gate open` refuses unless the issue is in `preflight-green` and the branch
belongs to that issue. Both are checked inside `pdkit` rather than asked of the
caller.

Refused without a token, and refused the same way whether you type it or an
agent does:

- `git push` in any shape — chained behind `&&`, in a subshell, in a command
  substitution, named by absolute path, or wrapped by a rewriter such as `rtk`
- `gh pr create|edit|merge|review`, `gh issue create|comment|close`
- `gh api` with a mutating method, and `gh api graphql` carrying a mutation

Refused **always**, token or not:

- `git push --force` without `--force-with-lease`
- `git add -A` and `git add .`
- `git rebase -i` — the husky `commit-msg` hook adds `Signed-off-by` to a
  message that already has one, then rejects the duplicate it created. Squash
  with `git reset --soft <base> && git commit`
- `git commit --no-verify`

Ordinary work is untouched: `git status`, `git add <path>`, `git commit -m`,
`gh pr view`, `gh api` reads. If a refusal looks wrong, `pdkit doctor
--gate-selftest` says whether the gate is behaving; rephrasing the command is
not a fix, and the parser was written for exactly that attempt.

## The ownership hook

While a task is marked active in a working tree, writes outside that task's
files are refused:

```
pdkit task sync --issue 12345          # read the Owns sets out of the task files
pdkit task start --issue 12345 --task T1
…
pdkit task stop
```

`task sync` is not optional. Without it the state record has no ownership for
the task, and the hook allows every write while saying so — which reads as
nothing having happened.

Two allowances are deliberate. With no active task nothing is constrained: the
rule belongs to executing a planned task, not to having the plugin installed.
And with a task whose ownership was never synced, the write goes through with a
message naming the command that fixes it, because blocking there would make an
unsynced plan look like a broken tool.

What catches a worker that ran outside all of this is `pdkit audit`, which
reports every file changed outside every task's ownership. The hook catches it
in time; the audit catches it for certain.

## Receipts

A task is finished when the command in its `Done when` has been run and what it
printed has been recorded:

```
pdkit receipt write --issue 12345 --task T1
```

`pdkit` runs the command itself. There is no parameter for output text — the
choice between "the tests passed" and the test runner's own words is not
offered — and the digest it records over the captured block means a receipt
edited afterwards stops validating.

Completing a task without one is refused. So is completing one whose receipt
records a non-zero exit: that receipt is valid, and what it proves is that the
work is not done.

Those failures are counted, and the count comes from the captures rather than
from anyone's account of them:

```
pdkit task attempts --issue 12345
pdkit task unblock --issue 12345 --task T1 --reason "plan amended: A1 splits the fixture"
```

At `exec.max_attempts` — three by default, zero switches it off — the task is
blocked. The completion hook refuses it, `pdkit task start` will not pick it up,
and a new session says so in its first lines, which is where it matters most:
three failures live in the context a restart just discarded.

The reason on `unblock` is required, and it is the whole mechanism. Twice,
"fix it and try again" is right. The third time it is the advice that built the
loop, and the question worth forcing is what changed between the second attempt
and the third. If nothing did, the plan is wrong rather than the code.

## Calibrating the thresholds

Four numbers in `config.yaml` were common sense: two quickfix bounds, the stale
window, and the attempt ceiling. `pdkit stats` measures the population they are
about — what upstream actually merges:

```
pdkit stats --limit 100
pdkit stats --limit 100 --author <you>    # once you have merged pull requests
```

It prints distributions of files changed, lines changed, time to merge and how
long open pull requests stay quiet, then puts each configured value beside what
the population did. It recommends nothing and writes nothing.

Read the sampling window it prints. `gh pr list` orders by creation date, so a
hundred merged pull requests are the last few weeks of work rather than a
hundred merges — which under-represents slow ones precisely because they are
slow, and that is the tail the stale threshold is about.

## Decision points that stay yours

The plugin stops and waits at exactly four places, and none of them can be
automated away:

1. Plan approval — after `[NEEDS DECISION]` items are resolved.
2. Slice graph approval.
3. Push confirmation — per branch, in the same turn, never carried over.
4. Plan amendments arising from review.
5. Anything added to `knowledge/`, whether proposed by `/pd:close` after one
   issue or by `/pd:knowledge` over the whole base.

Two more are decisions the plugin refuses to make rather than waits on:
publishing a review of someone else's pull request, and commenting in the
upstream tracker. Both are writes into a project that is not ours, and both are
refused by the hook rather than gated.

## Revising what the plugin thinks it knows

```
/pd:knowledge
```

`knowledge/` ships with the plugin and is read by every later issue, so an
entry that quietly stopped being true costs more than a missing one.

```
pdkit knowledge check --json     dead paths, drifted layer order, entry shape
pdkit knowledge export --json    the base, for a one-way push to basic-memory
```

The check earns its keep immediately: on the machine this was written on it
found `slicing.layer_order` in `$PDKIT_HOME/config.yaml` still pinned to the
value `pdkit init` copied at stage 0, so three layers added two stages later had
never taken effect there. Arrays replace rather than merge — deliberately, so an
edited list is not silently re-extended — and the cost is that an unedited copy
freezes. `pdkit doctor` now reports that as `config:arrays`.

Nothing here writes to `knowledge/`. Additions are proposed and you approve
them: a base that grows on its own is a base people stop reading.

## Where the state lives

`$PDKIT_HOME`, default `~/.pdkit/podman-desktop` — **outside the fork**, so
nothing the plugin records can end up in a pull request.

```
pdkit state 12345             # where an issue is, and where it may go next
pdkit journal --issue 12345   # why it got there
```

`state.json` knows *where*; the journal knows *why*. "Why is slice #2 stacked
rather than branched from main" is recoverable six months later only from the
journal, which is append-only and never rewritten.
