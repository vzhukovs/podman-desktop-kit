# Changelog

All notable changes to this plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Plugin skeleton: manifest, marketplace entry, `bin/pdkit` entry point, and the
  full `lib/` module layout described in section 2 of the architecture spec.
- 21 skills (18 orchestrating, 3 phrase-triggered) and 14 agents, frontmatter
  only. Bodies land in later stages.
- Hook registration: six entries on `bin/pdkit`, with all decision logic in
  `lib/hooks/`.
- **Stage 0 of section 12.** `pdkit init`, `doctor`, `state`, `ids`, `journal`
  and `packages` work end to end:
  - `lib/yaml.js` — reader for the documented YAML subset; refuses anything
    outside it with a line number instead of degrading quietly.
  - `lib/config.js` — three-layer configuration, maps merged per key and lists
    replaced whole.
  - `lib/repo.js` — package map generated from `pnpm-workspace.yaml`, and
    repository resolution that reports a remote mismatch instead of guessing.
  - `lib/journal.js` — append-only journal in the format of section 2.3, sliced
    by month.
  - `lib/state.js` — the issue state machine on disk, written temp-then-rename;
    the only writer of `state.json`.
  - `lib/ids.js` — R-IDs frozen on plan approval, task and slice numbers, and
    branch names checked against the pattern preflight will use.
  - `lib/doctor.js` — real environment checks; nothing is reported as available
    without being exercised, and every optional gap says what degrades.

- **Stage 1 of section 12 — the single-PR backbone.** Scenarios 1 and 2 run end
  to end, from an issue to an open pull request.
  - **The push gate.** `lib/hooks/command-parse.js` decomposes a Bash command
    into everything it will actually execute: operators, substitutions,
    subshells, leading assignments, quoted argv[0], programs named by path, and
    wrapper programs such as `rtk`. `lib/gate.js` issues consent tokens — one
    branch, ten minutes, spent on first use — and `lib/hooks/dispatch.js`
    decides. Nothing reaches GitHub without one.
  - `pre-bash` fails closed. Every other hook event allows the call when its
    handler cannot load; this one refuses, because there "cannot run" means the
    gate is off rather than a feature being incomplete.
  - **Preflight**, eighteen checks with a machine-readable report. Script names
    are resolved from the repository's own `package.json` rather than baked in.
    A missing script is a skip that says so, a check that throws is a failure,
    and checks belonging to later stages report which stage rather than passing.
  - `lib/upstream.js` — SPDX in the repository's house format, conventional
    commit validation that separates blocking problems from advisory notes, and
    the API-surface grep that codifies the `RunOptions` trap.
  - `lib/gh.js` — issue and linked-PR reads that name upstream explicitly, and
    `createPullRequest`, which verifies and spends the consent token itself
    because the Bash hook cannot see a child process.
  - `pdkit issue`, `branch`, `render`, `preflight`, `gate` and `pr`, plus
    `doctor --gate-selftest`, which drives every forbidden command through the
    hook the manifest registers.
  - Bodies for the seven stage 1 skills: `sync`, `triage`, `plan`, `exec`,
    `preflight`, `pr`, `quickfix`.

- **Stage 2 of section 12 — quality.** Drift from the plan stops reaching a
  pull request.
  - `lib/active.js` — which task is running in which working tree. The piece
    the model was missing: `state.json` knew that T1 owns three files, and
    nothing could tell that T1 is what runs *here*. Keyed on the tree, because
    five worktrees share one `$PDKIT_HOME` and two of them can be on the same
    issue at different slices.
  - `lib/globs.js` — path matching for `Owns`. Refuses what it cannot express
    exactly (`src/**.ts`) instead of approximating it, since the difference is
    how deep a permission reaches.
  - **The ownership hook.** Writes outside the active task's files are refused,
    with the refusal naming the whole owned set. Two allowances are deliberate
    and tested: no active task constrains nothing, and a task whose ownership
    was never synced allows the write while naming the command that fixes it.
  - **Receipts as a gate.** `pdkit receipt write` runs the command from
    `Done when` itself; there is no parameter for output text, so "summarise
    the run convincingly" is not a path that exists. A digest over the captured
    block catches a receipt edited afterwards. `validateReceipt` answers "is
    this a real capture" and deliberately not "did the run succeed" — a red
    receipt is valid, and it is the one worth having most.
  - `lib/artefacts.js` — reads `plan.md` and `tasks/T*.md` back, and checks
    what a grep can check: tasks sharing files, `Done when` as prose,
    requirements with no task, `[NEEDS DECISION]` left in.
  - `lib/audit.js` — the facts `pd-auditor` works from, including every file
    changed outside every task's ownership. No verdict field, and `pdkit audit`
    always exits zero: a collector that graded its own findings would be the
    second opinion the audit is meant to be getting.
  - `session-start` re-anchors to the active task and revokes outstanding
    consent tokens; `pre-compact` writes the active task to the journal. With
    no active task, SessionStart prints nothing at all.
  - `pdkit task`, `receipt`, `plan check`, `audit`, `render --check`, and
    `doctor` self-testing the ownership hook through the manifest.
  - Bodies for `plan-review` and `audit`, both ordered machine first.

- **Stage 3 of section 12 — slicing.** One change set becomes N atomic pull
  requests, each one built before it is offered.
  - `lib/slice.js` — the graph and the criterion. A slice is a **base plus a
    set of files**, not a set of commits: verification is step one of the
    /pd:pr flow, before any branch exists, so what gets built is the diff
    restricted to those files. The same diff is what materializing applies
    back, and what `--from-pr` will substitute for a published one.
  - **The refusals.** `pdkit slice set` rejects, by name, two slices sharing a
    file, a changed file in no slice, a base that is not a slice or forms a
    cycle, a public API change mixed into another layer or merging after it,
    and an R-ID that reaches no slice. Spanning layers and exceeding
    `max_files_per_slice` warn instead — those are conversations, not defects.
  - **The criterion.** `pdkit slice verify` builds a slice alone on `main` in a
    worktree and runs the repository's own typecheck, lint and scoped tests.
    Green means it branches from `main`; red means it needs a stack, and the
    red run is the evidence for the stack rather than something to hide.
  - **The verdict is produced, never supplied.** `slices.json` is written only
    by `lib/slice.js`, the run is attached as a receipt under `verify/S<i>.md`
    and validated by the same function receipts use, and `slices.md` is
    rendered from the graph. There is no parameter through which an agent could
    write "standalone: ✅" — the argument that closed receipts in stage 2.
  - **Freshness.** The digest of the verified diff is stored and recomputed by
    preflight, which fails rather than passes on a mismatch. On a materialized
    branch that is also proof the branch is what was verified.
  - `pdkit slice materialize` cuts the branch from the slice's base, applies
    the slice and makes one commit, leaving the working branch untouched. It
    refuses before `slices-approved`.
  - `pdkit slice cascade` rebases what is stacked on a changed slice and
    verifies each one again from its branch. Anything that stopped being green
    is reported and journalled, not rebased into a lie.
  - `lib/worktree.js` — create, list, remove, and prepare the verification
    tree. `worktrees.*` had been in the config since stage 0 with nothing
    reading it. Removal refuses while a tree holds an unmerged branch;
    preparation cleans `-fdx` with one exception, `node_modules`, and the
    marker recording which lockfile is installed lives inside it so the claim
    and the thing it claims about share a fate.
  - `pdkit slice suggest`, `set`, `show`, `verify`, `render`, `materialize`,
    `cascade`, and `pdkit worktree create|list|remove`.
  - Bodies for `slice` and `worktree-kit`; `/pd:pr` runs its whole sequence
    once per slice, confirmation included.

- **Stage 4 of section 12 — the pull request lifecycle.** A pull request stops
  being something the plugin forgets the moment it is opened.
  - `lib/pr.js` — pull requests as entities with identifiers. `prs.json`, one
    writer, rendered to `prs/<k>.md`. Before this the number of an opened pull
    request survived only inside a state-transition reason, so nothing could
    answer which PR belonged to which slice, which slice a review thread was
    about, or what to re-check after a fix.
  - **Merge is a fact about a pull request, not about an issue.** `merged` is
    terminal in the state machine and upstream merges slices one at a time;
    recording the first merged slice on the issue would have locked it before
    the second could reach `preflight-green`. `pdkit close --finish` moves the
    issue, and only when every pull request has landed. A maintainer-closed PR
    counts as unfinished — that is the entry to the redo route, not the exit.
  - **A red job is measured, not interpreted.** Four outcomes: `fail` (red here,
    green on other people's open PRs), `inconclusive` (red on theirs too — a
    warning, since blocking on what the change did not do teaches people to
    route around the gate), `flake` (the same job, the same commit, two
    answers), `pending` (with its age, because a check IN_PROGRESS since June is
    a finding). The baseline is the peer population rather than the base branch:
    podman-desktop runs `pr-check` on `pull_request`, so `main` never runs those
    jobs and a base comparison would call every red inconclusive.
  - `lib/threads.js` — `lib/audit.js` applied to review feedback. Bot or human,
    thread to file to slice to task to requirement, and a thread whose file
    belongs to no slice flagged rather than dropped. Nothing is classified.
    Escalation words match in one direction only: they expand a collapsed bot
    back to full text and never collapse anything.
  - **Review threads are not where the feedback is.** `gh.discussion` reads
    review submissions and top-level comments as well, because on the pull
    request this stage was built against both open threads are a bot's while
    the reason it is blocked is a four-line `CHANGES_REQUESTED` body.
  - `lib/drift.js` — what landed upstream under each slice since it branched,
    measured from that slice's own branch point, with commits that touched
    lines the plan cites reported separately. Hunks are read with
    `--unified=0`: with context lines a one-line change claims six, and every
    commit in the file would look semantic.
  - `pdkit pr register|list|show|refresh|ci|threads|render|reply|merged|closed`,
    `pdkit drift`, `pdkit amendment new`, `pdkit close`, and
    `pdkit slice suggest --from-pr` (scenario 13, open item I).
  - Bodies for `pr-status`, `pr-sync`, `resume` and `close`.

- **Stage 5 of section 12 — evidence, reviews of other people's work, and the
  revision of what the plugin thinks it knows.**
  - `lib/validation.js` — validation as an entity with an owner. `validated`
    was the one state an issue could only enter by hand, because nothing
    answered "was this validated, and by what evidence". `validation.json`, one
    writer, rendered to `validation.md`.
  - **PASS is an attached artefact, not a claim.** `validate attach` has no
    `--status`: a captured run produces pass or fail through `lib/evidence.js`,
    a screenshot produces `observed` only once it has been hashed and
    described, and a step with neither is `unverified`. The promise is
    deliberately narrower than the one slice verification makes — no code here
    can confirm that what appeared on screen was right, so PASS means an
    artefact was captured and nothing more.
  - **The application is brought up the way upstream brings it up.** `validate
    launch` spawns the build with `--remote-debugging-port`, waits for
    `/json/version` and prints the endpoint Playwright MCP attaches to. That is
    what `tests/playwright/src/runner/chrome-dev-tools-protocol-runner.ts` does,
    which also answers the one question section 12 held open as needing a proof
    of concept: podman-desktop has been driven over CDP in its own CI all along.
    No packaging required — `node_modules/.bin/electron .` runs the development
    build.
  - **The run of the codified test is what PASS rests on.** A checklist is
    verified once, by one person, today; a test is verified by CI on every pull
    request that follows. `pdkit e2e stability` runs it three times in a row and
    stops at the first red, and the series is tied to a digest of the spec.
  - **`unverified` does not stop the pipeline, and does not vanish either.**
    Without Playwright there would be no way out of `implemented`, and a gate
    that expensive gets routed around. The nineteenth preflight check,
    `validation-evidence`, refuses a pull request body that does not name the
    undemonstrated steps under `Notes for reviewers` — an unverified step nobody
    mentions reads exactly like a verified one.
  - `lib/review.js` — `lib/audit.js` applied to someone else's pull request.
    Files by layer, exported symbols that reach the public API, schemas changed
    with nothing generated beside them, added files without a licence header,
    and the threads reviewers already opened so four axes do not repeat a point
    from last week. No verdict, and **no mention of commit scope**: upstream
    does not require it, and spending an author's attention on a rule their
    project does not have is how a review loses the standing to raise the ones
    it does.
  - `lib/knowledge.js` — the mechanical half of revising `knowledge/`. Dead
    paths, `file:line` citations that point past the end of a file, entries that
    stopped following the shape their own file declares, and a layer chain that
    has drifted from `slicing.layer_order`.
  - `pdkit validate steps|launch|stop|attach|codify|run|finish`,
    `pdkit e2e stability`, `pdkit review fetch|render`,
    `pdkit knowledge check|export`.
  - Bodies for `validate`, `review-pr` and `knowledge`. The USAGE footer no
    longer says anything is unimplemented.

- **Scenario 6 of section 10 — the way into the cycle.** Every stage so far
  began at `/pd:triage <issue>`, with a number somebody had already chosen.
  Scenario 6 asks the other question, and it was the one entry in that table
  with no route in code.
  - `lib/backlog.js` — facts about a set of candidate issues, in the shape of
    `lib/audit.js`: what is mechanical about "can this be started" is collected
    once, and nothing is decided. Pull requests referencing the issue, who it is
    assigned to, whether a maintainer answered, whether a bug report carries a
    reproduction rather than an empty `_No response_`, which upstream template
    the body follows, and how long since a human touched it.
  - `pdkit issue list [--label a,b] [--limit n]` — one GraphQL request for the
    whole batch, roughly a second for twenty issues. Not a per-issue loop:
    `gh issue list --json comments` returns empty arrays, so the obvious shape
    would have cost twenty round trips and still needed the second call.
  - **The order is over facts, not a recommendation.** Blocked last, more
    signals first, least idle next, issue number to break ties so two runs print
    the same list. There is no `score` field: whether a requirement is clear
    enough to plan against is not in the table, and it is the thing that
    decides.
  - Section 0 of the `triage` skill: without a number, shortlist. It reads the
    top few bodies rather than all of them, says what is blocked instead of
    dropping it, and writes nothing — no files, no state transitions.

- **A task stops being retried after it has failed enough times** (open item G,
  the idea is flow-next's). Every failed capture of `Done when` is counted, and
  at `exec.max_attempts` — three by default — the task is blocked.
  - `lib/attempts.js` derives the count from the journal rather than storing
    it. Storing would mean either a second writer for `state.json`, which
    invariant 1 forbids, or a new state file for one integer; the journal is
    append-only by construction and already records what happened.
  - What increments it is a capture with a non-zero exit and nothing else — the
    same input that decides everything else about completion. There is no
    parameter an agent could use to claim a fresh start.
  - Three places refuse a blocked task, because there are three ways past it:
    the completion hook (with a different message from a plain red receipt),
    `pdkit task start`, and the session summary — a restart is exactly where the
    three failures fall out of context and a fourth attempt begins.
  - `pdkit task attempts` reads it back; `pdkit task unblock --reason` restarts
    the count. The reason is required and never defaulted: it is the only record
    of why anyone expected the next attempt to differ.
- **`pdkit stats` measures the population the guessed thresholds are about**
  (open item L, and the fourth PoC question). Distributions of files changed,
  lines changed, time to merge and how long open pull requests stay quiet, with
  each configured value stated against what upstream actually merged. It
  recommends nothing and writes nothing.
  - The first run says the quickfix bounds are not the narrow case they were
    meant to be: 71% of merged pull requests change three files or fewer, and
    40% fit in twenty lines. Time to merge is p90 two days, which makes a
    fourteen-day stale window generous — 20 of 78 open pull requests are past
    it.
  - The sampling window is printed beside the numbers. `gh pr list` orders by
    creation date, so a hundred merged pull requests are eleven days of work
    rather than a hundred merges, and the ones missing are the slow ones — which
    is the tail the stale threshold is about.

- **The `redo` route exists** (section 10, scenario 10). It was the last of the
  five routes with no machinery: triage recognised a reverted attempt and then
  said it was not implemented before stage 4, which shipped in July.
  - `lib/archaeology.js` collects what is mechanical about a previous attempt —
    which pull request landed it, when, what it touched, what reverted it, how
    long it lived in the base branch, what reviewers said at the time, what has
    merged in those files since, and what could not be established.
  - **The ordering scenario 10 puts in bold is now held by the machine.** On the
    redo route an issue cannot leave `triaged` until `archaeology.json` exists,
    and that file is written only from a real lookup. The guarantee is narrow on
    purpose, in the wording of invariant 5: it means the previous attempt was
    looked up, not that its lesson was learned.
  - `pd-archaeologist` grew a body: the four questions in order, and the
    instruction to quote reviewers rather than paraphrase them into agreement.
  - Route vocabulary is one list again. `state.js` knew two values,
    `preflight/index.js` declared four and section 4 asked for five, so
    `multi-slice` and `redo` could not be recorded at all. `pdkit state <n> --to
    triaged --route <r>` now records what triage decided; `invalid` is
    deliberately not a route, because the machine already spells it `abandoned`.

- **A twentieth preflight check, `quickfix-size`,** which measures what the
  quickfix thresholds were always about and never blocks. Production lines and
  test lines are counted separately: on the first live run the fix was two lines
  and its test sixty-two, so a blocking check would have escalated a correct
  one-line change into full planning for being properly tested.

### Changed

- **Preflight's base is a ref, not a branch name.** `repo.base_branch` names a
  branch, and on a fork the local branch of that name is a copy of the base as
  fresh as the last pull. First live run: a local `main` 491 commits behind
  turned a two-file diff into an 805-file one, and preflight reported four
  blocking failures about other people's work — a licence header on a file we
  never touched, 87 commits with the wrong sign-off, eight public API symbols.
  Nothing looked wrong. The base now resolves to the upstream remote-tracking
  ref when it exists, and the report prints which ref it read, at what sha and
  from what date: that ref goes stale too, and a measurement has to say what it
  saw.
- **The quickfix route can reach the gate.** `preflight-green` is reachable from
  `quickfix` and not from `triaged`, and no skill said to enter the `quickfix`
  state — so both preflight passes went green and the gate could not be opened
  at all. The quickfix skill now moves the issue, and says why.
- **`steps-to-check` reports what it measured.** It matches a phrasing rather
  than the presence of an expectation, and "it reads `ls -l /etc`" is an
  expected result it was rejecting. The vocabulary is wider, and the failure now
  says which forms count instead of claiming the step states no result.

- **A cross-reference from another repository is no longer a linked pull
  request.** `pdkit issue fetch 18381` reported `#17 MERGED feat(podman-desktop):
  add Enterprise Support Page prototype` — a pull request in a stranger's
  prototype repository. Triage reads an open linked PR as "the work exists, stop"
  and a merged one as grounds for archaeology, so this was the same expensive
  false positive that moved dedup off text search and onto the timeline, arriving
  by a different route. The timeline is still the authority on what references an
  issue; it is not an authority on where the reference lives.
- **Idle time is measured from human activity rather than `updatedAt`.** The
  stale bot moves the timestamp, so GitHub's own recency ordering puts abandoned
  issues at the top of a backlog listing. Bots are recognised by account type —
  GraphQL returns the stale bot as `github-actions`, without the `[bot]` suffix
  `threads.isBot` matches on.
- **The issue author is not the project answering**, even when they are a
  member. Otherwise the "a maintainer replied" signal is one a reporter can
  raise for themselves.

- **A consent token now knows what it is consent for, which closed a hole.**
  `dispatch.js` fell back to the current branch for commands with no branch of
  their own, so the token issued to push slice #1 also authorised `gh pr
  review`, `gh issue comment` and any `gh api` mutation — one confirmation,
  given for publishing code, silently covering writes nobody was asked about.
  Tokens are now keyed `push:<branch>` or `reply:pr-<k>`, and keys of different
  kinds cannot be found for one another. Writes to the issue tracker are refused
  outright: no state authorises them, and the route that produces issue text
  says a human posts it.
- **`gates.require_states` is deleted** (open item B). Which states a token may
  be issued from lives in `state.GATE_ELIGIBLE`, keyed by kind. The only thing
  the config key could do was widen a list, and a widened push list is a token
  issued before preflight. `pdkit doctor` warns while it is still present.
- A reply token is not spent on first use. The unit of consent for replies is
  the batch of drafts a human read in one go; spending on the first of eight
  would refuse the seven they just approved.
- `state.counters` gained `amendment`, so `A1` comes from a counter rather than
  from whoever is writing the amendment.
- `review.bots_collapsed` lists the accounts that actually comment on
  podman-desktop pull requests. codecov posts a coverage table under a plain
  login, and it was being quoted in full underneath the human objection.
- **The first run of `pdkit knowledge check` found real drift, in a config
  rather than in prose.** `slicing.layer_order` in `$PDKIT_HOME/config.yaml` was
  still the copy `pdkit init` wrote at stage 0, so the three layers stage 3
  added to the merge order had never taken effect on that machine. Lists replace
  rather than merge — deliberately — and the cost is that an unedited copy
  freezes at the value shipped that day. `pdkit doctor` now reports it as
  `config:arrays`, and `knowledge/package-map.md` states the current chain.
- `pdkit doctor` gained `validate:app`: "no Playwright" and "nothing to point
  Playwright at" are different problems, and the second is invisible until
  validation starts and has nothing to drive.
- `pdkit doctor` reloaded its config once the home directory is known. Every
  check after `checkConfig` had been reading a config missing its middle layer.
- `knowledge/review-expectations.md` gained the `## What to add here` section
  every other file in the base has. Without it nothing stated what belonged
  there, which is how a base grows entries nobody agreed to.
- `fetchPullRequestHead` moved from `lib/slice.js` to `lib/repo.js`. Reviewing
  someone else's pull request needs the same primitive `--from-pr` uses, and
  writing a second one would have been a second answer to a settled question.
- `render.write` takes a `root`, for the one artefact that belongs to no issue:
  a review of someone else's pull request lands in `$PDKIT_HOME/reviews/`.
- `pdkit doctor` checks GraphQL reachability, not only that `gh` is logged in.
  Everything this stage reads about a review is GraphQL-only, and a token
  without the scope fails mid-sync with half the feedback read.

- **`lib/evidence.js` set `RTK_DISABLE`, which is not a variable rtk reads.**
  The name is `RTK_DISABLED`. With rtk enabled, every receipt and every
  preflight proof would have been captured through it — compressed output,
  indistinguishable in the file from the real thing. The test missed it by
  comparing the module against a constant the module declares itself; it now
  asserts from inside the child process.
- `templates/plan.md` takes a `{{tasks}}` placeholder instead of a hardcoded T1
  block. It could not render a plan with two tasks before.
- `templates/receipt.md` records the capture's completeness and its digest.
- `skills/exec` no longer says receipts are discipline rather than enforcement.
- `pdkit doctor` checks rtk for real, replacing the placeholder that deferred
  it: whether it is installed, and whether its `exclude_commands` covers
  `tools.rtk.never_rewrite`.
- `knowledge/upstream-rules.md` verified against podman-desktop at `b0e77bc`.
  The SPDX header is the Red Hat Apache block, not a bare identifier line, and
  the commit scope is optional rather than required — the earlier text would
  have taught preflight to enforce both incorrectly.
- Architecture spec bumped to 0.3, and the 0.2 snapshot frozen. The command
  names in section 7 did not exist in podman-desktop (`pnpm lint:check`, not
  `pnpm lint`); the PR body now nests inside the four headings of the upstream
  template; `gates.require_states` no longer allows issuing a token from a
  state that precedes preflight; and section 4 documents the two preflight
  passes that the body-reading checks require.
- **`preflight` reads the slice, not just the issue.** The base comes from the
  graph — a stacked slice diffed from `main` hands every file check the
  previous slice's work as though it were this one's — and `r-coverage` asks
  for the slice's R-IDs. Demanding the whole frozen set failed the first slice
  of three for not covering requirements belonging to the third; its own remedy
  line described that situation without being able to recognise it.
- **`slice-standalone` stops being a stub.** It re-checks what a stored result
  cannot say about itself: that the digest still matches, and that the attached
  run is still a valid capture.
- **`pr-open` may return to `preflight-green`.** An issue with three slices
  passes through that state three times, and the gate is issued per branch from
  `preflight-green` alone; widening `GATE_ELIGIBLE` instead would have opened a
  way around preflight itself.
- **`repo.changedPaths` can turn rename detection off,** and slicing turns it
  off. A rename names two paths and the function kept one, which would carry
  the new file into a slice and leave the old one behind.
- `templates/slices.md` can hold more than one slice. The table row and the
  rationale block were hardcoded for slice #1, so the artefact this whole stage
  produces could not be rendered for a graph of three — the same defect stage 2
  found in `templates/plan.md`.
- `slicing.layer_order` covers every package in the fork. `packages/api`,
  `packages/webview-api` and `storybook` used to fall through to `other`, which
  meant their merge order was decided by nothing.
- `pdkit doctor` checks the worktree root and whether git still believes in the
  trees it lists, and names the config file that decides `slicing.layer_order`
  — `init` copies the whole defaults file, so a list the plugin has since
  extended goes on being shadowed by that copy.
- Architecture spec bumped to 0.5, with the 0.4 snapshot frozen.

- `templates/pr-body.md` rebuilt on the upstream template's four sections.
- Deny rules gained their `when` predicates. As shipped in the skeleton, six of
  the eight matched only a program and subcommand — the force-push rule refused
  every `git push`, `no-verify` every `git commit`, and the `gh` rules gated
  reads.

### Notes

- Stages 4 and 5 remain stubs: no PR lifecycle, no Playwright validation. The
  skills for those say so instead of improvising.
- Stage 2 is **implemented in code and not confirmed in practice**, on the same
  terms as stage 1. Its readiness signal in section 12 is "the auditor caught a
  divergence the implementer did not notice", and that is settled by the single
  live run deferred until after stage 5 — not by the test suite.
- Auto-blocking a task after N attempts is still not implemented;
  `templates/task.md` no longer promises it.
- Stage 3 was exercised against the fork end to end: three slices across three
  layers, all verified green (two standalone from `main`, one stacked), three
  branches materialized carrying only their own files, preflight green on a
  slice branch, and a review fix cascaded through the stack. **No pull request
  was opened.** The readiness signal in section 12 — "one change set cut into 3
  PRs, each standalone green" — is closed as far as branches and verifications
  go; publishing waits with the live run deferred until after stage 5.
- Measured while doing it: installing into a fresh worktree from a warm pnpm
  store takes about fifteen seconds, not the minutes assumed when the reuse
  policy was chosen. What dominates is the repository-wide `lint:check` at
  roughly 100 seconds per slice.
- `pdkit slice --from-pr` (scenario 13) is not implemented. The slicer's input
  is abstracted down to a diff, so the remaining work is migrating review
  threads into the new pull requests, which needs the same GraphQL layer as
  `pr-sync`.
- `Reverts cleanly` is a textual check — the patch comes off. Whether the build
  survives a revert costs another full run per slice and is not claimed.
