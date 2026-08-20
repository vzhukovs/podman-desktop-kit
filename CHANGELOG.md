# Changelog

All notable changes to this plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, a MINOR bump may carry a breaking change and PATCH is reserved for
fixes — see [RELEASING.md](RELEASING.md).

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vzhukovs/podman-desktop-kit/releases/tag/v0.1.0
