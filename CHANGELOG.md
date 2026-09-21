# Changelog

All notable changes to this plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, a MINOR bump may carry a breaking change and PATCH is reserved for
fixes — see [RELEASING.md](RELEASING.md).

## [Unreleased]

## [0.2.0] - 2026-09-21

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Then **`pdkit doctor --gate-selftest`**, once. The gate is registered by the
manifest and executed by the host, so an upgrade that broke that wiring leaves
every test green and the plugin gating nothing — this is the only check that can
tell.

Nothing in `$PDKIT_HOME` has to be moved or edited. `preflight.json`,
`validation.json`'s R-ID lists and `archive/` are written on first use, and
records written by 0.1.0 are read as they stand.

Two changes are visible to a cycle that is already in flight:

- **An issue at `slices-approved` can no longer be moved to `preflight-green` by
  hand.** The transition now asks `preflight.json` for a run on the current head
  commit, which 0.1.0 never wrote. Run `pdkit preflight <issue>` — both passes,
  the second once the pull request body exists — and the move goes through as it
  did. Issues already past that state are untouched, and `pdkit issue adopt`
  stays exempt, because work that predates the plugin never ran preflight.
- **A push token carries two uses**, `push` then `pr`, spent separately. The
  published sequence — `gate open`, `git push`, `pdkit pr create` — works as
  documented for the first time. One token still means one push.

### Added

- **`pdkit validate supersede <Vk> --by <Vn> --reason "<what happened>"` retires a
  step that measured the environment.** On DESKTOP-18835 the e2e spec could not
  start a second Electron instance — the application `validate launch` had
  brought up was holding the single-instance lock — and not one test executed.
  The same spec passed four times in a row once that window was closed. `finish`
  takes the worst status in the record, nothing could retire the red step, and
  the issue moved only because `validation.json` was edited by hand: the one act
  the whole design exists to make unnecessary.
  - **A record, not an eraser.** The step keeps its exit code, its run and its
    place in the table, marked `fail, set aside for V7`; the reason and the
    replacement go under a new `Set aside` section of `validation.md`, and the
    supersession is journalled as `validation-superseded`. What changes is the
    arithmetic: `outcomeOf` no longer counts it, and `validation-evidence` stops
    naming it in preflight.
  - **Four guards, and they are the reason this is not a way of typing PASS.**
    The step named by `--by` must have demonstrated something itself — a run that
    passed, or an artefact with an observation; a step that passed cannot be set
    aside, because the only use for that is hiding a pass; the reason is required
    and is a sentence a person writes; and nothing is deleted.
  - **An R-ID that only the retired step carried is named at the moment it stops
    counting as covered.** Losing one silently is how a requirement demonstrated
    once ends up demonstrated never.
- **A validation step carries every R-ID it demonstrates.** `--requirement` takes
  as many as apply — `--requirement R1 --requirement R2`, or `--requirement
  "R1, R2"` — because one screenshot of a list shows the new column, the sort
  order and the empty state at once, and the record held exactly one. The rest
  were described in prose and traced by nobody.
  - A flag typed twice used to keep the second one silently. `parseArgs` now
    collects repeats into a list, so a command that wants several gets them and
    one that wants a single value sees something that is not a string and says
    so, instead of acting on half of what was asked.
  - Records written before this read as the list they always meant, and the
    singular key does not survive the next write.
- **`pdkit reset <issue>` starts one issue over.** A cycle can go wrong early —
  the triage reads the issue as something it is not, the scouts map the wrong
  package — and then every later step inherits the mistake, because every later
  step reads what the earlier ones wrote. The machine had no answer: `new` has no
  predecessor, so nothing could return an issue to the state its own artefacts
  had never been produced in, and the only route out was `rm -rf` on a directory
  whose neighbours share a parent.
  - **Not a transition, and deliberately not one.** Adding an edge into `new`
    would write a trip into the history that the work never took, and destroy the
    distinction `adopted` exists for — "these artefacts were never produced"
    reading differently from "these artefacts were lost". The record is *removed*
    instead, so `state.read` returns its own blank, whose only exit is `triaged`.
  - **A dry run by default**, shaped like `close`: bare it reports and changes
    nothing, `--confirm` acts. The report has two halves, and the second is the
    one that stops a mistake — what stays.
  - **Four stores, three of them cleared.** The issue's artefacts (archived to
    `$PDKIT_HOME/archive/<issue>/<timestamp>/`, or deleted with `--purge`), its
    consent tokens, and its active-task pointers in every working tree. Tokens are
    matched on the issue inside the record rather than on the key, because a reply
    token's key names a pull request — which says nothing about the issue unless
    you already hold the `prs.json` that is inside the directory about to move.
  - **The journal is the fourth, and it is kept.** Invariant 2 has no delete, and
    that turns out to be the property this needs most: an issue back at `new` with
    no history would be indistinguishable from one nobody ever worked on. One
    `reset` entry is appended saying what the issue was and where its record went.
  - **It touches one issue.** Worktrees are matched exactly rather than by
    substring, so `DESKTOP-1854` does not select the tree of `DESKTOP-18548` — and
    they are not removed at all without `--worktrees`, which still refuses a tree
    holding a branch that has not landed. A branch with unpushed commits is work,
    not a record of work, and a command called "start over" must not be the thing
    that drops it.
  - **Nothing upstream moves**, and the output says so twice: an open pull request
    is forgotten, not closed. The design self-heals around it, because dedup is
    the first step of triage — the next cycle rediscovers from GitHub what this
    one forgot. Deferrals survive for the same reason they survive a merge.
  - Distinct from the three outcomes it is easy to confuse with, and the skill
    says which is which: `issue rework` when a reviewer refused the approach (the
    objection is the most valuable thing the review produced), the `redo` route
    when the work was tried and reverted, `abandoned` when it is not worth doing.
- **`pdkit defer` records what a review thread set aside.** `/pd:pr-sync` has
  offered four ways to answer a thread since it was written — `accept`,
  `discuss`, `defer`, `reject` — and three of them led somewhere. Nothing
  recorded a `defer`, so the decision existed only as whatever the reply happened
  to say. Found on #18561: after the pull request merged, a reviewer asked what a
  very long container command does to the display, and the answer — truncation
  belongs to the renderer, a follow-up issue will be opened — lived in a GitHub
  comment and nowhere else. `close --finish` would have moved the issue to
  `merged` without a word about it.
  - The record is **derived from the journal, not stored**, for the reason
    `lib/attempts.js` gives for the attempt count, plus one that is particular
    here: an issue that merges is in a terminal state and a promise made to a
    reviewer is not, so it has to live somewhere that state cannot erase. The
    journal is append-only, so `pdkit defer list` still answers afterwards.
  - `defer new` also drafts the follow-up issue, **in the shape of upstream's own
    issue form** — `--kind bug|feature|task`, matching
    `.github/ISSUE_TEMPLATE/` in podman-desktop. The headings are that form's
    field labels, so the draft is copied field by field into the template in the
    GitHub UI and the posted issue reads like every other one in the repository
    rather than like something a tool produced. Operating system and version are
    filled in from the machine and the checkout, because a field typed from
    memory is a field that names last year's OS. The title has its own heading —
    it is the form's first field and not part of the body — derived from
    `--what`, overridable with `--title`, and never truncated: upstream titles
    run to a hundred characters, and one cut mid-clause says less than a long one
    while looking finished.
  - Screenshots get one **visible** placeholder per image found under the issue's
    `evidence/` directory. Visible rather than an HTML comment on purpose: a
    comment renders as nothing, so one left unreplaced reaches the issue
    invisibly — the defect already fixed in the `Patch comes off` caveat, the
    config arrays message and `steps-to-check`. Posted unreplaced, the line is
    obvious.
  - Opening the issue stays a human action: `gh issue create` is denied at the
    hook from every state.
  - `defer drop` requires `--reason`, on the same grounds as `task unblock`: it
    is the only record of why something a reviewer raised is not being done.
- **`pdkit amendment approve|reject|list`.** `amendment new` has always ended by
  saying "nothing moves until this is approved", and nothing could approve one —
  an instruction with no way to carry it out, which is the defect
  `pdkit journal conflict` was written to fix the first time. On DESKTOP-18548 two
  amendments sat `proposed` for six days while the work ran against a plan neither
  had changed, and the correction that superseded the first was a blockquote
  somebody typed at the top of the file.
  - No state transition. The plan becomes what the amendment says and the work
    continues against it; what finds the work done against the previous version is
    `pdkit audit`.
  - The status is rewritten in the artefact rather than kept only in the journal,
    because that file is the record of the decision and one saying `proposed`
    after approval contradicts it. The rewrite is one line: everything a person
    added by hand is exactly what a re-render would lose.

### Fixed

- **`pdkit close` judged whether an issue could end from a record it had not
  read in seven weeks.** The rollup is the only thing that may move an issue to
  a terminal state, and it read the local `prs.json` and nothing else. Review,
  rebase and the merge itself all happen in the browser, so the copy on disk is
  usually older than the answer — on DESKTOP-17221 `close` reported `pr-open`,
  `open: [18562]` and `allMerged: false` about a pull request that had merged
  that morning, and the way out was for the person to guess that
  `pdkit pr refresh` was the missing step.
  - **`close` now re-reads every pull request the record still calls open**,
    before the rollup, through the new `pr.refreshOpen()`. Only the open ones:
    `merged` and `closed` are the two states GitHub does not take back, and
    re-reading them spends four requests to be told what the record already
    says. No peer population either — "is this red job ours" is a question about
    work in progress, and nothing about closing turns on the answer.
  - **A read that cannot be made is a fact in the report, not a crash.** `gh`
    missing, `gh` unauthenticated, the network down: `refreshFailed` names the
    pull request and how old the record it could not replace is, the facts on
    disk are still reported, and `--finish` refuses on the open pull request
    exactly as it should when nobody could establish the state.
  - **This is also what made the squash-merge fix unreachable.** Removing the
    worktree of a landed branch rests on `mergedAt` in the same record, so a
    stale copy refused to clean up after a merge it had not heard about.
- **A worktree git half-removed was reported as kept, and then invisible.**
  `git worktree remove` deletes the administrative directory before the working
  tree, so a failure part-way leaves a registration gone and a directory behind.
  `remove()` returned git's error, `close` printed `kept`, and the 1.1 GB left
  at `pd-worktrees/DESKTOP-17221` was tracked by nothing: `worktree list` does
  not report it, so no later `close` would offer it, and the next
  `worktree create` at that path would have failed on it.
  - **The two failures are now told apart by asking git.** Still registered
    means git refused and nothing moved — unchanged behaviour, unchanged
    message. Not registered any more means the removal was begun and abandoned,
    and it is finished here: the leftover deleted, `worktree prune` run, and the
    journal told, which it previously was not although the decision to remove
    had been taken and carried out.
  - **Deleting happens inside the worktree root or not at all.** The bound is
    checked where the deletion is, rather than inherited from a caller's
    `basename()` — this is the only place in the plugin that removes a directory
    git is no longer tracking.
  - **`close` distinguishes three outcomes**, and `kept` is now only said of a
    tree git still has: `removed`, `removed — git left files behind; deleted`,
    and `unregistered but still on disk: <path>`, which is the one that needs a
    person.
- **`pdkit close` reported every amendment as awaiting approval, including the
  approved ones.** The harvest built its `amendments` line out of the journal's
  `amendment-proposed` entry and printed that entry's detail verbatim — a string
  written at the moment of proposal, reading `A1 — awaiting approval` for ever
  after. `pdkit amendment approve` rewrites the file and journals a decision of
  its own; `close` read neither. On DESKTOP-18835 two amendments approved three
  days earlier were both reported as though nobody had decided, in the one report
  anybody reads about what happened to the plan.
  - **The status is read off the amendment file**, which is where
    `parseAmendment` has always said it belongs: the file is the artefact a
    person opens, and it is the thing approval rewrites. A status settled by hand
    is therefore read too.
  - **Who decided, and why, still comes out of the journal** — the half the file
    does not keep. `A1 — approved (by a maintainer)`, and a rejection carries the
    reason that is the only record of why the plan did not move.
  - **The human output says it as well.** The field existed only under `--json`,
    so the half of the harvest that is about the plan was invisible to the person
    the harvest is for.
- **A task that writes nothing turned its ownership into two files that do not
  exist.** A whole-suite gate — typecheck, tests and linters over the whole tree
  — writes no files by design, and two live runs said so the same way:
  `Owns: (none — verification only, writes no files)`. The parser split that
  sentence on its comma and `pdkit task sync` stored the two halves as paths. On
  DESKTOP-18835 the gate was the only task claiming R7, R8 and R15; the phrases
  matched no file in the diff, so `slice set` refused a one-slice graph for three
  requirements nobody had forgotten, and the way out was to spread them over the
  seven tasks that do write files — a sentence about the plan, not about the work.
  - **Prose is not a path.** An `Owns` that says `(none`, or nothing at all, is
    read as no files. Half a sentence is worse than no answer: nothing downstream
    could tell those two entries from paths, and the empty-ownership rule in
    `plan check` saw a list of two and passed every time.
  - **A verification task is a shape a plan may take**, and `plan check` now says
    so: owning no files is refused only when there is no executable `Done when`
    either — a task that writes nothing and runs nothing does nothing.
  - **Empty is not the same as missing, and the pre-write hook is where that
    matters.** No entry means nobody ran `task sync`, and writes stay
    unconstrained with a message. An entry that IS empty means the plan gave the
    task no files, and every write it attempts is refused — otherwise the empty
    set would be the widest permission in the system instead of the narrowest.
  - **`slice set` gives its requirements to every slice.** A requirement whose
    only task owns no files is a claim over the whole change — "refactor only",
    "no unannounced visible change" — and every pull request cut from it is a
    place that claim has to hold.
- **`slice verify` answered for the wrong branch whenever the names matched, and
  called it standalone.** `pdkit worktree create` names the working branch from
  the same template `branches.sliced` gives slice #1, so for an issue with one
  slice the two names are identical by construction. verify found a branch under
  the slice's name, took it for the materialized slice, built the tree at its tip
  — ten files behind `main` — and recorded `standalone: true` against `main`.
  `slices.md` printed `Base: main | Standalone: ✅` for a build on main that had
  never happened, and `slice-standalone` then read that record as the proof it
  exists to demand. Found on DESKTOP-18835 by comparing the recorded SHA with
  `git merge-base` by hand; nothing in the output would have said it.
  - **The base is checked before anything is built.** A branch whose merge-base
    with the slice's base is not that base is refused, naming both commits and
    both ways out: rebase it, or delete it and let verify build the slice from
    the change set. A refusal rather than a silent fallback — it does not touch
    somebody's branch, and it says the true thing.
  - **`standalone` is measured rather than read off the graph.** `baseSlice ===
    null` is what a slice intends; what makes the word true is where the build
    stood.
  - **The verification records the base it used**, ref and commit, and
    `slices.md`, `pdkit slice` and the preflight summary print it. A green tick
    beside a SHA is a claim anybody can check; on its own it is a word.
- **`pdkit slice render` could overwrite a verified column.** The `--values` file
  was spread on top of the measured values, so a file carrying `rows` or
  `verifiedAt` replaced the ticks with whatever it said — in the one document
  whose columns mean something precisely because they cannot be typed in. The
  comment above the function had claimed the opposite since it was written. The
  merge now happens inside `renderValues`, which takes the caller's prose,
  keeps `rationale`, and writes the measured keys over everything else.
- **`preflight-green` could be typed, and it is the state the push gate opens
  from.** Section 1 has stated the hard rule since 0.1 — a push token is issued
  from that state and nowhere else — and the gate checked it faithfully. Nothing
  checked that the state was true. `slices-approved -> preflight-green` is a
  legal move, so the entire chain of gates could be replaced by fourteen
  characters. Walked into on DESKTOP-18832, where a session set it by hand after
  a slice graph landed, opened a token and pushed.
  - The repair is the device every other guarded state already used: something on
    disk only a real run could have produced. `answered` refuses while nothing is
    captured, the redo route refuses to leave `triaged` without the archaeology —
    and preflight wrote **nothing at all**, printing a report and forgetting it,
    which is exactly why this was the one rule with no evidence behind it.
  - `preflight.json` now records every run, green or red, both passes. The
    transition asks three things of it: the checks ran on **this** commit (filed
    under the resolved head SHA, so a green run of a diff that has since moved is
    not evidence); nothing blocking is failing; and the four body-dependent
    checks have seen a body. That last one makes the second pass load-bearing
    rather than ceremonial — a check that skipped because it had nothing to read
    has judged nothing.
  - Adoption stays exempt, deliberately: `issue adopt` writes the state instead
    of transitioning, because work predating the plugin never ran preflight.
- **The documented publish sequence could not work.** `/pd:pr` has said
  `gate open`, `git push`, `pdkit pr create` since it was written — and the push
  spent the token that `pr create` then needed. Found the worst way round on
  DESKTOP-18832: the refusal arrived *after* the push, leaving a public branch
  with no pull request to explain it.
  - A push token now carries two uses, `push` and `pr`, spent separately. One
    reading — the body and the branch shown together at `gate open` — rather than
    two confirmations, the second of which would have followed the irreversible
    half. **One token, one push is untouched**: a token that has pushed cannot
    push again.
  - The order is fixed and not symmetric. Opening the pull request spends the
    token whole, so a push may precede it and never follow it — otherwise a token
    that had opened a pull request would still carry a push, landing new commits
    on a branch already under review with nobody confirming them. Caught by an
    existing test that had encoded the old rule as "one token, one write", which
    turned out to be the right rule for the wrong reason.
  - Reply tokens are unchanged: no uses, spent by the TTL, because what they
    authorise is the batch of drafts somebody read in one go.
- **`slice verify` said `RED` for a run that proved nothing.** A red slice has two
  causes and they are not the same finding: the slice broke something, or the base
  fails that command too. The plugin already measured the difference — it resets
  the same tree to the base, runs the same command, caches the answer, excludes
  such slices from `independenceProblems`, renders `⚠️` in `slices.md`, downgrades
  the preflight check to a warning and journals `slice-verify-inconclusive`. Five
  places knew the word `inconclusive`. The sixth — the command a person runs and
  reads at the moment it happens — printed `RED`.
  - On DESKTOP-18832 that cost a session half an hour of rediscovering by hand a
    fact already in `slices.json`, and ended in a judgement call made under an
    uncertainty the machine did not have. `slice verify` now has three words, and
    the inconclusive one names where to look; `verify --all` carries the verdict
    per slice and says the cause once rather than accusing N slices of it.
- **Every renderer slice was inconclusive, and the reason was one missing build
  script.** `slicing.verify.prepare` lists what a cleaned tree must build before
  anything is checked, and it held `build:core-api` alone. `typecheck:renderer`
  consumes `@podman-desktop/ui-svelte`, which resolves through `packages/ui/dist`
  — not in git, not built by that script, and built by upstream's own
  `typecheck:ui`. On a clean tree that is 577 errors across 295 files, none of
  them in the slice, and since typecheck runs first the test step that would have
  built it is never reached.
  - This is the second time the same shape has been found, one live run apart:
    `build:core-api` was added for `typecheck:main` and `packages/api/dist`. Both
    are now in the shipped list, and the key is documented in
    `configuration.md`, where it had never appeared at all.
- **The baseline cache outlived the thing it measured.** It was keyed on base and
  command, so a base that failed because the tree was never told to build what the
  command needs stayed `false` after the prepare list was corrected — every issue
  that had once measured a false baseline would have reported inconclusive
  forever, with the cache the only thing that could have said why. The preparation
  is now part of the key.
- **The machine said `next: implemented`, and a session typed `/pd:implement`.**
  `pdkit state` could say which states an issue may move to and never which
  command gets it there. Seven of the eight states in the chain are spelled like
  the command that reaches them — `triaged`/`triage`, `planned`/`plan`,
  `validated`/`validate` and so on — so the eighth gets guessed, and it is the
  one place the two vocabularies diverge: `implemented` is reached by `/pd:exec`.
  Observed on DESKTOP-18832, where a plan review ended by recommending a command
  that does not exist.
  - Nothing contradicted it, because **the forward links did not exist**. Every
    skill in the chain ended on a `pdkit state --to` call and named nothing
    after it: `/pd:plan` pointed at `/pd:plan-review`, which pointed back at
    `/pd:plan`, and past that the chain stopped.
  - `lib/state.js` now carries `ADVANCES` and `nextStep()`, printed by the
    transition, by the record and by the SessionStart summary — the three places
    a next step is read. Against the record rather than the state, because one
    answer depends on the route: a `triaged` issue on the quickfix route goes to
    `/pd:quickfix`, and sending it to `/pd:plan` is what `escalate` exists to
    undo.
  - Ten skills gained a `## Next` section, so the chain reads forward as well as
    back. `/pd:plan-review` says outright that the command is spelled `exec`
    rather than `implement`, and why.
  - Two states answer with a sentence instead of a command. `sliced` waits on an
    approval that is a person's to give, and naming a skill there would name one
    that must not run yet.
  - Two invariants pin it: every `/pd:x` written in a skill or a doc resolves to
    a real skill, and every non-terminal state names something to run. The
    existing test covered `pdkit <command>` mentions and nothing else — a wrong
    `/pd:*` name passed every test in the suite.

### Changed

- **The attempt count stops at a reset.** It is derived from the journal, which
  `pdkit reset` may not delete — and task numbering restarts with the record, so
  the T1 of the new cycle would have inherited the failures of the T1 of the old
  one and could have been born blocked. The walk is cut by position rather than by
  timestamp: the journal is second-resolution, so a reset and the first capture
  after it can share one, and `>` would drop the capture while `>=` kept the
  reset.
- **`pdkit close` names deferrals that are still open**, and does not block on
  them. Closing is the last step, so there is no later gate — which argues for
  refusing until the other half is weighed: a gate between a finished issue and
  its terminal state is paid every time and earns its keep almost never.
- **Flake detection fires. It never had, and three defects were in the way** —
  each alone enough to silence it, each found by watching it stay silent through
  a real flake on #18779.
  1. `checkRunsForCommit` asked for a commit's check runs without `filter=all`,
     and that endpoint defaults to `filter=latest`: one run per check name, so
     after a re-run the failure is simply absent. On that commit `latest` returns
     1 run for `k8s sanity e2e tests` and `all` returns 3.
  2. `refresh` fetched those runs only when a check was *currently* red — asking
     "did this job answer twice" exactly when the answer has to be no, since the
     ordinary flake is red, re-run, green. Now unconditional: one REST call
     against a measured budget of 32 points out of an hourly 5000 for a ten-PR
     sweep, and a verdict nobody can reach is not a saving.
  3. `judge` returned `pass` on a green conclusion before comparing the runs, so
     the only flake reachable was one still red — while the comment beside it
     named the opposite case. Whether a job disagreed with itself is a fact about
     the commit, not about what it says when somebody looks.
  With all three fixed, `pdkit pr ci 18779` reports `flake` on five jobs: the
  three that were re-run and two whose red run nobody had noticed.
  The test that should have caught the first was present and named for it, and it
  stubbed the response — it proved the parser kept two runs, never that the
  request asked for them. It now asserts the argv, and fails against the old
  code. Second time here a test proved its own fixture rather than the behaviour
  it was named for.
- **`steps-to-check` reads a step, not a line.** Written out, a step usually runs
  to three lines — the action, the command, and what should come back — and the
  check filtered numbered *lines* and tested only those. A step whose result sat
  on its own indented line was reported as stating none, while the reviewer was
  looking straight at it. Found on DESKTOP-18778, where all four steps failed
  that way and the body was correct.
  The bound on the fix is the interesting half: continuation is **indentation**,
  which is what makes a line part of a list item in markdown. Taking everything
  up to the next number instead would let unindented prose further down the
  section satisfy a step that says nothing — the exact failure the check exists
  to catch. This is the third time a check here has been narrower than the thing
  it claimed to measure, and the second where the fix was scope rather than
  vocabulary.
- **`pdkit worktree create` names the branch.** It took `--branch` and nothing
  derived one, so the ordinary call left the tree on a detached HEAD — and the
  first thing that said so was `branch-name` in preflight, which is the step
  before the gate. By then there are commits on a detached HEAD and the fix is a
  branch plus an amend. Found on DESKTOP-18778, exactly that way.
  `--slug` now derives the name through `ids.branchName`, so the tree starts on
  the name preflight and the gate will later check against, rather than on one
  typed twice and spelled differently the second time. Without a slug the tree is
  still detached — looking around before naming the work is legitimate — but it
  says so at creation and names the two commands that fix it. The journal entry
  records which of the two it was.
- **A reply token can be issued after the pull request has merged.** Found by
  walking into the refusal: a reviewer asked a question on #18561 a week after it
  landed, answering is an ordinary continuation of the same review conversation,
  and the gate said the issue was merged and refused. That is the failure section
  6 names for the tracker rules — a gate that cannot open is worse than a refusal
  that says what to do — except here no route says a human posts it instead,
  because replying on your own pull request is what `pdkit pr reply` is for.
  **It widens nothing about publishing code:** `push` is still one state, and a
  reply key cannot be found for a push.
- `pdkit close --confirmed` reached the usage text, having existed since the
  answered route landed without appearing in `--help`.

## [0.1.0] - 2026-08-10

First public release. Stages 0 through 5 of the delivery plan
([specification](docs/specification.md), section 12) are implemented; two routes
have run end to end against live upstream. What has **not** been exercised is
listed in section 13 of the specification and summarised in the README, and the
list is not short — most notably, twenty of the twenty-one skills have never been
invoked through a session, because almost every measured run drove `pdkit`
directly.

The entries below are grouped by the stage that produced them, because that is
the order in which the pieces became usable rather than the order they were
designed.

### Stage 0 — the frame

- **Plugin skeleton**: manifest, marketplace entry, `bin/pdkit`, and the module
  layout the rest hangs on.
- **21 skills** (18 orchestrating, 3 phrase-triggered) and **14 agents**.
- **Hook registration**: six entries on `bin/pdkit`, with every decision in
  `lib/hooks/` where it can be tested.
- `lib/yaml.js` — a reader for a documented subset of YAML that refuses anything
  outside it, with a line number, instead of degrading quietly. A reader that
  skipped a construct it did not understand would return a config that looks
  loaded and is missing a key.
- `lib/config.js` — three-layer configuration, maps merged per key and **lists
  replaced whole**: a list assembled from two halves is a list nobody wrote, and
  `layer_order` decides the order slices merge in.
- `lib/repo.js` — the package map generated from `pnpm-workspace.yaml`, so it
  cannot drift from the workspace; repository resolution reports a remote
  mismatch instead of guessing.
- `lib/journal.js`, `lib/state.js`, `lib/ids.js`, `lib/doctor.js` — the
  append-only journal, the state machine (the only writer of `state.json`),
  R-IDs frozen on plan approval, and an environment check that reports nothing
  as available without exercising it.

### Stage 1 — the single-PR backbone

Scenarios 1 and 2 run end to end, from an issue to an open pull request.

- **The push gate.** `lib/hooks/command-parse.js` decomposes a Bash command into
  everything it will actually execute: operators, substitutions, subshells,
  leading assignments, quoted `argv[0]`, programs named by path, and wrapper
  programs. `lib/gate.js` issues consent tokens — one branch, ten minutes, spent
  on first use — and `lib/hooks/dispatch.js` decides. Nothing reaches GitHub
  without one.
- `pre-bash` **fails closed.** Every other hook event allows the call when its
  handler cannot load; this one refuses, because there "cannot run" means the
  gate is off rather than a feature being incomplete.
- **Preflight**, with a machine-readable report. Script names are resolved from
  the repository's own `package.json` rather than baked in: a hard-coded name,
  after an upstream rename, becomes a check that silently does not run — the
  worst possible outcome for a gate. A missing script is a `skip` that says so,
  and a check that throws is a failure.
- `lib/upstream.js` — SPDX in the repository's house format, conventional commit
  validation that separates blocking problems from advisory notes, and the
  API-surface grep that codifies the `RunOptions` trap.
- `lib/gh.js` — issue and linked-PR reads that name upstream explicitly, and
  `createPullRequest`, which verifies and spends the consent token itself because
  the Bash hook cannot see a child process.
- `doctor --gate-selftest`, which drives every forbidden command through the hook
  the manifest registers. Verified against three ways of breaking the gate: a
  matcher not on `Bash`, a deleted rule, and a handler that will not load.

### Stage 2 — quality

Drift from the plan stops reaching a pull request.

- `lib/active.js` — which task is running in which working tree. The piece the
  model was missing: `state.json` knew that T1 owns three files, and nothing could
  tell that T1 is what runs *here*. Keyed on the tree, because five worktrees
  share one `$PDKIT_HOME` and two of them can be on the same issue at different
  slices.
- `lib/globs.js` — path matching for `Owns`. Refuses what it cannot express
  exactly (`src/**.ts`) instead of approximating it, since the difference is how
  deep a permission reaches.
- **The ownership hook.** Writes outside the active task's files are refused, with
  the refusal naming the whole owned set. Two allowances are deliberate and
  tested: no active task constrains nothing, and a task whose ownership was never
  synced allows the write while naming the command that fixes it.
- **Receipts as a gate.** `pdkit receipt write` runs the command from `Done when`
  itself; there is no parameter for output text, so "summarise the run
  convincingly" is not a path that exists. A digest over the captured block
  catches a receipt edited afterwards. `validateReceipt` answers "is this a real
  capture" and deliberately not "did the run succeed" — a red receipt is valid,
  and it is the one worth having most.
- `lib/artefacts.js` and `lib/audit.js` — the mechanical half of plan review and
  of the audit, including every file changed outside every task's ownership. No
  verdict field, and `pdkit audit` always exits zero: a collector that graded its
  own findings would be the second opinion the audit exists to get.
- `session-start` re-anchors to the active task and revokes outstanding tokens;
  `pre-compact` writes the active task to the journal.

### Stage 3 — slicing

One change set becomes N atomic pull requests, each built before it is offered.

- `lib/slice.js` — the graph and the criterion. **A slice is a base plus a set of
  files, not a set of commits**: verification is step one of the `/pd:pr` flow,
  before any branch exists, so what gets built is the diff restricted to those
  files. The same diff is what materialising applies back, and what `--from-pr`
  substitutes for a published one.
- **The refusals.** `pdkit slice set` rejects, by name: two slices sharing a file,
  a changed file in no slice, a base that is not a slice or forms a cycle, a
  public API change mixed into another layer or merging after it, and an R-ID that
  reaches no slice. Spanning layers and exceeding `max_files_per_slice` warn
  instead — those are conversations, not defects.
- **The criterion.** `pdkit slice verify` builds a slice alone on `main` in a
  worktree and runs the repository's own typecheck, lint and scoped tests. Green
  means it branches from `main`; red means it needs a stack, and the red run is
  the evidence for the stack rather than something to hide.
- **The verdict is produced, never supplied.** `slices.json` is written only by
  `lib/slice.js`, the run is attached as a receipt and validated by the same
  function receipts use, and `slices.md` is rendered from the graph. There is no
  parameter through which an agent could write "standalone: ✅".
- **Freshness.** The digest of the verified diff is stored and recomputed by
  preflight, which fails rather than passes on a mismatch. On a materialised
  branch that is also proof the branch is what was verified.
- `pdkit slice materialize` cuts the branch from the slice's base, applies the
  slice and makes one commit, leaving the working branch untouched.
- `pdkit slice cascade` rebases what is stacked on a changed slice and verifies
  each one again. Anything that stopped being green is reported and journalled,
  not rebased into a lie.
- `lib/worktree.js` — create, list, remove, and prepare the verification tree.
  Removal refuses while a tree holds an unmerged branch; preparation cleans `-fdx`
  with one exception, `node_modules`, and the marker recording which lockfile is
  installed lives inside it so the claim and the thing it claims about share a
  fate.

Measured while doing it: installing into a fresh worktree from a warm pnpm store
takes about fifteen seconds, not the minutes assumed when the reuse policy was
chosen. What dominates is the repository-wide `lint:check`, at roughly 100 seconds
per slice.

### Stage 4 — the pull request lifecycle

A pull request stops being something the plugin forgets the moment it is opened.

- `lib/pr.js` — pull requests as entities with identifiers. Before this the number
  of an opened pull request survived only inside a state-transition reason, so
  nothing could answer which PR belonged to which slice, which slice a review
  thread was about, or what to re-check after a fix.
- **Merge is a fact about a pull request, not about an issue.** `merged` is
  terminal and upstream merges slices one at a time; recording the first merged
  slice on the issue would have locked it before the second could reach
  `preflight-green`. `pdkit close --finish` moves the issue, and only when every
  pull request has landed.
- **A red job is measured, not interpreted.** Four outcomes: `fail` (red here,
  green on other people's open PRs), `inconclusive` (red on theirs too — a
  warning, since blocking on what the change did not do teaches people to route
  around the gate), `flake` (the same job, the same commit, two answers), and
  `pending` with its age. The baseline is the peer population rather than the base
  branch: podman-desktop runs `pr-check` on `pull_request`, so `main` never runs
  those jobs and a base comparison would call every red inconclusive.
- `lib/threads.js` — the audit applied to review feedback. Bot or human, thread to
  file to slice to task to requirement, and a thread whose file belongs to no
  slice flagged rather than dropped. Escalation words match in one direction only:
  they expand a collapsed bot back to full text and never collapse anything.
- **Review threads are not where the feedback is.** Review submissions and
  top-level comments are read as well, because on the pull request this stage was
  built against both open threads were a bot's while the reason it was blocked was
  a four-line `CHANGES_REQUESTED` body.
- `lib/drift.js` — what landed upstream under each slice since it branched,
  measured from that slice's own branch point, with commits touching lines the
  plan cites reported separately. Hunks are read with `--unified=0`: with context
  lines a one-line change claims six, and every commit in the file would look
  semantic.

### Stage 5 — evidence, reviews, and revising what the plugin knows

- `lib/validation.js` — validation as an entity with an owner. `validated` was the
  one state an issue could only enter by hand, because nothing answered "was this
  validated, and by what evidence".
- **PASS is an attached artefact, not a claim.** `validate attach` has no
  `--status`: a captured run produces pass or fail, a screenshot produces
  `observed` only once it has been hashed and described, and a step with neither
  is `unverified`. The promise is deliberately narrower than the one slice
  verification makes — no code here can confirm that what appeared on screen was
  right.
- **The application is brought up the way upstream brings it up.** `validate
  launch` spawns the build with `--remote-debugging-port`, waits for
  `/json/version` and prints the endpoint Playwright MCP attaches to. That is what
  upstream's own CDP runner does, which also answers the one question held open as
  needing a proof of concept: podman-desktop has been driven over CDP in its own
  CI all along, and no packaging is required.
- **The run of the codified test is what PASS rests on.** A checklist is verified
  once, by one person, today; a test is verified by CI on every pull request that
  follows. `pdkit e2e stability` runs it three times in a row and stops at the
  first red, and the series is tied to a digest of the spec.
- **`unverified` does not stop the pipeline, and does not vanish either.** The
  `validation-evidence` check refuses a pull request body that does not name the
  undemonstrated steps under `Notes for reviewers` — an unverified step nobody
  mentions reads exactly like a verified one.
- `lib/review.js` — the audit applied to somebody else's pull request. Files by
  layer, exported symbols reaching the public API, schemas changed with nothing
  generated beside them, added files without a licence header, and the threads
  reviewers already opened so four axes do not repeat a point from last week. No
  verdict, and **no mention of commit scope**: upstream does not require it, and
  spending an author's attention on a rule their project does not have is how a
  review loses the standing to raise the ones it does.
- `lib/knowledge.js` — the mechanical half of revising `knowledge/`: dead paths,
  `file:line` citations pointing past the end of a file, entries that stopped
  following their own declared shape, and a layer chain that has drifted.

### Entering the cycle, and leaving it

- **Choosing what to work on.** `lib/backlog.js` collects what is mechanical about
  "can this be started": pull requests referencing the issue, the assignee, whether
  a maintainer answered, whether a bug report carries a reproduction rather than an
  empty `_No response_`, and how long since a human touched it. One GraphQL request
  for the whole batch — `gh issue list --json comments` returns empty arrays, so
  the obvious shape would have cost twenty round trips and still needed a second
  call. **The order is over facts, not a recommendation**, and there is no `score`
  field: whether a requirement is clear enough to plan against is not in the table,
  and it is the thing that decides.
- **The `redo` route exists.** `lib/archaeology.js` collects which pull request
  landed a previous attempt, what reverted it, how long it lived, what reviewers
  said, and what merged in those files since. The ordering "archaeology before any
  implementation" is now held by the machine: on the redo route an issue cannot
  leave `triaged` until `archaeology.json` exists, and that file is written only
  from a real lookup. The guarantee is narrow on purpose — it means the previous
  attempt was looked up, not that its lesson was learned.
- **A task stops being retried after it has failed enough times.**
  `lib/attempts.js` derives the count from the journal rather than storing it:
  storing would mean either a second writer for `state.json` or a new state file
  for one integer. What increments it is a capture with a non-zero exit and nothing
  else. Three places refuse a blocked task, because there are three ways past it —
  the completion hook, `pdkit task start`, and the session summary, which is where
  it matters most: three failures live in the context a restart just discarded.
- **An issue can end in an answer rather than a diff.** Measured by walking a real
  issue whose cause is a version skew outside the repository. `answered` is a
  state, and deliberately **not** terminal: at the moment the findings are posted
  the issue is waiting on the reporter, and the machine could wait on a reviewer
  and could not wait on a reporter. Entry is guarded by a capture — a workaround
  nobody ran is a suggestion, and a suggestion posted in the voice of a finding
  costs the reporter their evening. Closing takes `--confirmed "<who>"`: a fact
  about them, not a verdict about us.
- **The state machine can say "the reviewer rejected the approach".** `pr-open`
  and `review-in-progress` lead back to `triaged` through `pdkit issue rework`.
  Until then the only moves from an open pull request were to push again — which
  assumes the design survived — and to abandon an issue still worth doing.
- **Work older than the plugin is adopted, not replayed.** `pdkit issue adopt`
  records the state, the pull request and a required reason, and leaves the
  artefacts of the states it never passed missing: an issue with no plan because
  nobody wrote one and an issue whose plan was lost are different things.
- **`pdkit stats` measures the population the guessed thresholds are about.** The
  first run says the quickfix bounds are not the narrow case they were meant to
  be: 71% of merged pull requests change three files or fewer, and 40% fit in
  twenty lines. Time to merge is p90 two days. The sampling window is printed
  beside the numbers, because `gh pr list` orders by creation date and the ones
  missing from a hundred-PR sample are the slow ones — which is the tail the stale
  threshold is about.

### Findings from live runs

Each of these was found by running the thing, and none of them could have been
found by a unit test.

- **Preflight's base is a ref, not a branch name.** On a fork the local branch
  named `main` is a copy as fresh as the last pull. First live run: a local `main`
  491 commits behind turned a two-file diff into an 805-file one, and preflight
  reported four blocking failures about other people's work. Nothing looked wrong.
  The base now resolves to the upstream remote-tracking ref, and the report prints
  which ref it read, at what sha and from what date.
- **Preflight took its ref from whatever was checked out.** The base came from the
  graph; the ref did not — correct only when preflight runs from the slice's own
  worktree. Run from anywhere else, every file check read an unrelated change and
  said nothing, because `HEAD` always resolves. Found as a green report saying "the
  public API declaration is untouched" about a slice whose only file is
  `extension-api.d.ts`.
- **The quickfix route could not reach the gate.** `preflight-green` is reachable
  from `quickfix` and not from `triaged`, and no skill entered the `quickfix`
  state — so both preflight passes went green and the gate could not be opened at
  all.
- **`--from-pr` substituted the diff source in `slice suggest` alone**, so a
  proposal drafted from a published pull request was checked against `main...HEAD`
  and refused a file at a time. A flag that redirects the source in one command of
  a chain is not half a feature; it is a feature that does not work.
- **A revert was recognised only when its title started with the word.** Upstream
  wrote `fix(renderer): revert extension details summary card…`, so the pair was
  never established, the fallback took the newest merge — an unrelated feature —
  and the report named the wrong pull request as the attempt, quoted reviewers from
  it, and concluded "merged and nothing reverts it".
- **A cross-reference from another repository is not a linked pull request.**
  `pdkit issue fetch 18381` reported a merged pull request in a stranger's
  prototype repository. Triage reads an open linked PR as "the work exists, stop",
  so this was an expensive false positive arriving by a new route.
- **Idle time was measured from `updatedAt`.** The stale bot moves the timestamp,
  so GitHub's own recency ordering puts abandoned issues at the top of a backlog
  listing. Bots are now recognised by account type — GraphQL returns the stale bot
  as `github-actions`, without the `[bot]` suffix a name list matches on.
- **The issue author is not the project answering**, even when they are a member.
  Otherwise the "a maintainer replied" signal is one a reporter can raise for
  themselves.
- **A consent token did not know what it was consent for.** `dispatch.js` fell back
  to the current branch for commands with no branch of their own, so the token
  issued to push slice #1 also authorised `gh pr review`, `gh issue comment` and
  any `gh api` mutation — one confirmation, given for publishing code, silently
  covering writes nobody was asked about. Tokens are now keyed `push:<branch>` or
  `reply:pr-<k>`, and keys of different kinds cannot be found for one another.
- **A check that had not answered was read as a failure.** A third-party status
  context spells "not yet" as `state: PENDING` and always normalises to COMPLETED,
  so it arrived as "finished and not green". Twenty-five seconds after a PR opened,
  twenty-three jobs were in progress, nothing was red, and the rollup said `fail`.
- **A pull request that was replaced no longer blocks its issue forever.** The
  rollup treated every closed pull request as unfinished work — right when a
  maintainer rejected it, wrong when a rework replaced it. `pdkit pr closed
  --superseded-by <k>` settles it once the replacement merges, and what that rests
  on is the successor's own state, not the sentence in the reason field.
- **The materialised slice signs its own commit.** Leaving the trailer to the husky
  hook put it in the subject: the hook appends with `echo >>`, a message from a
  single `-m` has no blank line after it, and git reads a paragraph as the subject.
  The branch came out with a 130-character subject ending in `Signed-off-by:`.
- **`slice materialize` reported "nothing to commit" for a commit the repository's
  own pre-commit hook refused.** Two different failures arriving as one sentence,
  asserting a cause that was never measured.
- **The command that runs one codified spec ran the whole suite.** podman-desktop's
  `test:e2e:run` ends in a directory, so Playwright got two positional filters and
  ran all forty-four specs — noticed when a three-second spec was still going after
  ten minutes, while `validate run` was calling that the evidence for one step.
  Resolution order is now explicit, and a command that cannot be narrowed is
  refused rather than used.
- **`pdkit pr ci` reads the failure, not only the verdict.** The window is anchored
  on `##[error]`, and that is a measurement: on one pull request the marker sits
  fifty lines from the end of a 245-line log and everything after it is the runner
  removing credentials, so a plain tail showed all cleanup and no failure,
  confidently. The real cause was `E: Package 'qemu-user-static' has no
  installation candidate` — infrastructure, and nothing a reading of the diff would
  find.
- **`pdkit drift` found nothing because it passed nothing.** The module had
  accepted a ref and a file list all along and the command passed neither, so it
  reported "not cut yet — nothing to measure from" about a branch that existed.
  Measured properly: 21 upstream commits in those files, one of them in the two the
  fix is about.
- **A report that measured nothing said so.** The closing verdict was printed
  whether or not anything had been measured, and whether or not a plan existed to
  cite — reading, either way, as a clean bill of health.
- **The audit resolved its base the way preflight does.** It diffed against the
  literal `'main'`, not even reading `repo.base_branch`.
- **`steps-to-check` reported what it measured.** It matched a phrasing rather than
  the presence of an expectation, and "it reads `ls -l /etc`" is an expected result
  it was rejecting.
- **A check that waits for people is named differently from one that waits for a
  machine.** Upstream's domain review status follows labels its triager bot
  maintains and never resolves on its own, so reporting it as `pending` tells a
  reader to come back later for something that will not happen. It is
  `awaiting-review` now, and `pdkit pr list` prints who is holding it.
- **The dashboard says how old each reading is.** A verdict read three days ago
  printed exactly like one read a second ago. It stopped being a corner case when
  the sweep was measured: ten pull requests cost 37 seconds, so refreshing
  everything before every glance is precisely what nobody does.
- **`ci-blind-spots` knows about the dependency graph.** A lockfile moving is the
  one change whose risk lives a level below the diff, and it passed the blind-spot
  check in silence. Keyed on `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc` and
  `patches/` rather than on `package.json`: a manifest edited on its own installs
  exactly what was installed before.
- **A twentieth preflight check, `quickfix-size`**, which measures what the
  quickfix thresholds were always about and never blocks. Production and test lines
  are counted separately: on the first live run the fix was two lines and its test
  sixty-two, so a blocking check would have escalated a correct one-line change
  into full planning for being properly tested.
- **The templates could hold only one of everything.** `templates/plan.md` had a
  hardcoded T1 block, `templates/slices.md` a hardcoded slice #1, and the issue
  template a single requirement row with its source tag baked in — so the R-set,
  which every later trace hangs on, could only be written for an issue with exactly
  one requirement.
- **A hook read the end of the pipe rather than its payload**, and the suite left
  temp directories and live processes behind. Both were found by running things,
  and neither was visible from a passing test.

### Measurements that ended in buying nothing

- **The honest form of `Patch comes off`** costs 152 s per slice on a warm tree —
  +100%, or +26% narrowed to typecheck. Affordable, and still the wrong purchase: a
  revert lands weeks later against a tree that has moved, so a build proved green
  on the day of slicing answers about a tree that will not exist. The column is
  renamed to what it measures; the caveat had been living in an HTML comment while
  a green tick rendered under a header reading `Reverts cleanly`.
- **The GraphQL cost of the dashboard** is 32 points out of an hourly 5000 for a
  ten-PR sweep. Seconds are the constraint, not the budget, so no cache was
  introduced — and the conditional refetch keyed on `updatedAt` that suggested
  itself is refuted on its own terms: CI completion does not move `updatedAt`,
  measured eight times out of eight, so it would skip exactly the pull requests
  whose verdict just changed.
- **Two scenarios were struck by measuring the upstream population.** Of 200 merged
  pull requests, 88 are bots (dependabot alone: 84); of the 112 human ones exactly
  three concern dependencies, and all three fit the `quickfix` thresholds — so a
  dedicated dependency-bump route is a key with no work behind it. And there is no
  mass refactor across independent packages to slice: the largest human pull
  request in the sample is 32 files inside one layer.

### Preparing this release

- **The repository carries the licence header it demands upstream.** Every file
  carried a bare `SPDX-License-Identifier` line, which is exactly the form
  `knowledge/upstream-rules.md` tells contributors podman-desktop does not accept.
  All 100 source files now carry the house block, taken byte for byte from
  upstream, and `LICENSE` is byte-identical to theirs.
- **The PR body signs itself.** The attribution line was written by hand once and
  then lived in a plan file. It is in the template now, and the GitHub login is
  resolved from the fork slug the clone already knows, falling back to the
  authenticated user. When neither can answer, the clause naming a person is left
  out rather than rendered as a dangling `@`.
- **The design record exists in English**, as `docs/specification.md`, sections 0
  through 13 — with the section numbers preserved, because eighty comments in
  `lib/` cite them.
- **Two evaluated-and-rejected adapters leave no trace.** Their config keys, a
  doctor check named after one of them, and the comments arguing about them are
  gone. What stays is the defence that outlived them, restated for what it is: the
  gate strips wrapper programs because hooks on the Bash tool are global, not
  because any particular tool exists.

[Unreleased]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vzhukovs/podman-desktop-kit/releases/tag/v0.1.0
