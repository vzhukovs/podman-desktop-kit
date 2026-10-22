# Changelog

All notable changes to this plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, a MINOR bump may carry a breaking change and PATCH is reserved for
fixes — see [RELEASING.md](RELEASING.md).

## [Unreleased]

### Fixed

- **Agents now find `maintainer-rules.md` and the other knowledge files.** Every
  agent and skill named them as `knowledge/<file>.md`, a path relative to the
  plugin, while subagents run in the podman-desktop checkout. On DESKTOP-19818
  `pd-implementer` found nothing there and wrote two tasks without the
  maintainer's rules; the plan critic only reached the file by searching the
  home directory. The references are now `${CLAUDE_PLUGIN_ROOT}/knowledge/…`,
  which Claude Code substitutes when it loads the agent, and a test fails on any
  reference without the prefix.
- **The same for templates, skills and agents named in each other's text.**
  `pd-review-synth` reads its verdict table from `skills/review-pr/SKILL.md`,
  `pd-slicer` follows `skills/slice/SKILL.md`, `pd-archaeologist` fills
  `templates/archaeology.md`, and `/pd:plan` and `/pd:triage` fill
  `templates/plan.md` and `templates/issue.md`. They are all reached from
  `${CLAUDE_PLUGIN_ROOT}` now, and the test covers `knowledge/`, `templates/`,
  `skills/` and `agents/`.
- **`/pd:close` and `/pd:knowledge` say where an approved entry goes.** The
  installed copy is replaced on every update, so an entry is a commit to the
  plugin's repository, not an edit under `${CLAUDE_PLUGIN_ROOT}`.
- **An implementer that cannot read the rules stops.** `pd-implementer` reports
  the path it tried instead of carrying on, and `/pd:exec` does not commit a
  task whose worker said it could not read a file it was told to read.

## [0.10.1] - 2026-10-22

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Nothing changes in what you do. Only the dry run of `pdkit rollback` on
Windows looks different.

### Fixed

- **`pdkit rollback` names artefacts with forward slashes on Windows too.**
  The dry run listed `amendments\A3.md` there. The restore itself was right,
  since both sides of the comparison came from the same function. CI's
  Windows job caught it on 0.10.0, along with a test that expected a POSIX
  path from `issue draft-blocker`.

## [0.10.0] - 2026-10-22

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Nothing to change in your config.
- `/pd:exec`, `/pd:slice`, `/pd:pr-sync` and `/pd:resume` now start with
  `pdkit checkpoint`. Checkpoints live under `$PDKIT_HOME/checkpoints/`, and
  nothing existing moves.
- `pdkit amendment approve` refuses an amendment that leaves a requirement
  with no task, where it used to accept it.
- A `pdkit review render` values file needs `counts`, and `shouldFix` is
  ignored.

MINOR rather than PATCH because an approval that used to pass can now be
refused, and every changing phase gained a first step.

### Added

- **An issue can wait on another: `pdkit issue block`, `unblock`, `blocks` and
  `draft-blocker`.** A reviewer asks for "a PR before this one". When that
  earlier change touches files this issue's slices already own, one issue
  cannot hold both, because a slice is the diff restricted to its files.
  DESKTOP-18833 found that out after a scenario the plugin never had.
  - `draft-blocker` writes the upstream issue draft into `blockers/`. Opening
    it stays yours: `gh issue create` is denied at the hook.
  - `block` records the wait in the journal, so it outlives any state, the
    same way deferrals do.
  - `next`, `state` and `pr list` say what the issue waits on, and how the
    wait ends: `unblock`, then `/pd:resume`.
  - `blocks --check` reads each blocker's state from GitHub and lifts nothing,
    because closed is not always merged.
- **`/pd:pr-sync` has a sixth outcome, `block`, and no invented ones.** When a
  reviewer wants something landed first, the session compares that change's
  files with the slices before offering anything:
  - no file in common: a new slice of this issue, through an amendment;
  - a file in common: `block`. It drafts the upstream issue, records the wait
    once the person has opened it, and hands over the exact `/pd:triage`
    message for a new session, with the existing branch named as prior work.

  The rows that wait are marked `blocked by`, and the rest of the round moves.
  Every option shown to the person now names the pdkit command that carries
  it out. One with no command behind it is marked as unsupported and never
  recommended. A refusal from `amendment approve`, `slice set` or `task start`
  goes back to the person. It is never routed around by deleting task headings
  or dropping files. `/pd:resume` checks what the issue waits on before
  rebasing, and `/pd:exec`, `/pd:slice` and `pd-slicer` say the same about
  refusals.
- **`pdkit checkpoint` and `pdkit rollback`: a phase can be undone by
  command.** `/pd:exec`, `/pd:slice`, `/pd:pr-sync` and `/pd:resume` take a
  checkpoint first. It copies the issue's artefacts and records its state and
  `DESKTOP-<n>/…` branch heads.
  - `rollback` shows what would come back and what stays, then with
    `--confirm` restores all three. The present branch tips are kept under
    `refs/pdkit-backup/`, and the present artefacts are archived, never
    deleted.
  - It is refused when the phase moved the issue to another state. The state
    record is restored through `lib/state.js`, which is still its only writer,
    and a transition is not undone by rewriting.
  - Branches created during the phase, anything published, and the journal
    stay.

  On DESKTOP-18833 the only way back from an unsupported scenario was the
  model's memory of what it had changed.
- **A refused `slice set` says where to go, not only that nothing was
  stored.** A file in two slices points to a separate issue and
  `issue block`. A requirement no slice carries points to an amendment. Both
  say not to edit the proposal until it passes.
- **`knowledge/maintainer-rules.md`: the rules upstream's review agent applies
  to every pull request.** podman-desktop/podman-desktop#19798 adds a
  `review-podman-desktop` skill built from about 1200 of benoitf's review
  comments. Its rule set (tests, Svelte 5, TypeScript, DI, imports, PR hygiene)
  and its calibration of what actually blocks are copied verbatim, pinned to
  `43ab21a3`. That pull request was still open at the time.
  - `pd-implementer` reads the sections for the files it owns before it writes
    anything.
  - `pd-plan-critic` checks a plan against the rules a plan can break.
  - `pd-slicer` cuts the way section 1 asks: one concern per PR, prerequisite
    refactors first, pure moves, and test fixes apart from the implementation.

- **`/pd:review-pr` reviews by the same rules as upstream's review agent, and
  keeps its own judgement.** The four axes apply `maintainer-rules.md` and
  label every finding `issue:`, `nit:` or `question:` with the section it
  rests on. They no longer see the threads already on the pull request. An
  axis that has read what someone else said ends up echoing it or arguing with
  it. `pd-review-synth` gets the threads after the judgement and marks a
  finding a reviewer already raised as `(already raised by @login)`. It does
  not drop that finding, and it does not import threads the axes did not
  reproduce. The synthesis applies the maintainer's calibration, and the
  verdict now follows mechanically from the findings.

- **A `maintainer-rules` preflight check warns on the greppable part of those
  rules.** It looks only at added lines, and each pattern only in the files its
  rule is about:
  - in unit specs: `vi.spyOn`, `Object.defineProperty(window)`,
    `clearAllMocks`, `afterEach`;
  - in package sources: `as unknown as`, `eslint-disable`, synchronous
    fs/exec calls, `../` imports, built-ins without `node:`;
  - in `packages/main`: `export function`;
  - in Svelte: `<style>` and `$:`;
  - a hardcoded "Podman Desktop", a hex colour in the colour registry, and a
    copyright year other than this one.

  Each hit names its section. It never blocks: a grep cannot see context, and
  the point is that the implementer hears it before the maintainer does.

- **`/pd:pr-sync` finds what the maintainer will say before they say it.**
  Step 1 runs `preflight --only maintainer-rules` over the whole pull request,
  not only the last round, because upstream's review agent reads all of it.
  On the first round of an adopted issue it also runs a self-review: the
  `/pd:review-pr` axes on the local, rebased diff. That work never passed a
  plan critic or a slicer. The findings join the step 4 table as `self (§n)`
  rows, decided by the person like any other row. They get their own commit
  and no reply. A section 1 finding is proposed as `defer`, because splitting
  an open pull request is a decision, not a fix. A `maintainer-rules` hit at
  step 8 that was not in the table goes back to step 4. The rendered
  `reviews/<k>.md` marks the self-review as done.

### Changed

- **`/pd:resume` resolves a mechanical conflict without tidying around it.**
  No reordered imports and no reformatting beyond the conflict. Either one
  reaches the pull request as a change its title does not explain.
- **The review report has a `Counts` line and no `Should fix before merge`
  section.** With `issue:` / `nit:` / `question:` labels, every finding
  already has a section, and "should fix" was a fourth label nobody could
  define. Values files that still pass `shouldFix` are ignored. Values files
  that do not pass `counts` fail to render.
- **`knowledge/upstream-rules.md` gains two maintainer-review rules.** A new
  file's licence header carries the current year only. Existing tests and the
  implementation they test are not changed in the same PR.
- **The `conventional-commits` note on a missing scope now says the
  maintainer's review asks for one.** commitlint still does not require it, so
  the check still passes.

### Fixed

- **`pdkit amendment approve` refuses an amendment that leaves a requirement
  with no task.** On DESKTOP-18833, A3 added R18 and R19. It lost its task
  headings to get past the file-ownership refusal and was then approved, with
  nothing behind the two requirements. `slice set` found the hole hours later.
  Approval now measures against `plan.md` the requirements the amendment adds,
  and the ones it orphans by withdrawing a task. If any is satisfied by no live
  task, the amendment stays proposed. A requirement that was already uncovered
  is not counted, since it is not this amendment's doing.

## [0.9.6] - 2026-10-21

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Nothing changes in what you do. If `pdkit pr diff` listed files outside the
slice that the pull request never touched, run it again.

### Fixed

- **`pdkit pr diff` no longer counts upstream's files as outside the slice.**
  The "outside slice #k after the push" list was measured from the local
  `main`. On DESKTOP-18833 that branch was 43 commits behind, so the list named
  more than two hundred files that upstream had touched, none of them carried
  by the pull request. That list is shown right before the push question in
  `/pd:pr-sync`. The base now goes through the same resolver as preflight. A
  stacked pull request still measures from its slice branch.

## [0.9.5] - 2026-10-21

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

After a `/pd:resume`, continue with `/pd:pr-sync <pr#>` in a new session. That
is where the rebased branch is pushed now. If `main` is checked out somewhere
with uncommitted changes, `/pd:resume` leaves it alone and says so.

### Changed

- **`/pd:resume` no longer pushes. It hands the rebased branch to
  `/pd:pr-sync`, as the specification always said.** Its step 5 told the model
  to run `state --to preflight-green`, `gate open` and
  `git push --force-with-lease` itself. That step was not in the specification
  and skipped `pdkit pr diff`. On a pull request that was already open, it also
  stopped at the body-dependent preflight checks, which is what happened on
  DESKTOP-18833. The push now happens in `/pd:pr-sync` step 9, through
  `pdkit publish --pr`. The specification's rule that `--force-with-lease` is
  permitted in one place has moved to the `pr-sync` section, which is where
  that push happens. `docs/workflows.md` §8 now gives the same route as the
  specification: `resume` → `pr-sync`.
- **`/pd:resume` brings the local `main` up to date.** The specification's step
  1 says to fetch upstream and update `main`, and only the fetch was being
  done. `main` is fast-forwarded to `upstream/main`. Where `main` is checked out
  nowhere, this goes through `git fetch . upstream/main:main`. Where it is
  checked out in a clean tree, it goes through `git -C <tree> merge --ff-only`.
  A dirty tree, or a `main` with commits of its own, is skipped and reported.

## [0.9.4] - 2026-10-21

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Nothing changes in what you do. If preflight reported `slice-standalone` as
stale right after a rebase and re-verifying did not clear it, run
`pdkit slice verify` and `pdkit preflight` once more. You no longer need to
fast-forward the local `main` first.

### Fixed

- **A local `main` that has fallen behind upstream no longer makes a slice
  verification stale.** `pdkit slice verify`, `materialize`, `cascade`, `slice
  facts` and `pdkit drift` diffed against the local `main`, while preflight
  diffed against `upstream/main`. Once a branch was rebased onto upstream and
  upstream had touched the slice's files, the two digests never matched, and
  `slice-standalone` stayed red however many times the slice was re-verified.
  The only way out was fast-forwarding `main` by hand in another checkout.
  Every one of them now resolves the base the way preflight does. A stacked
  slice still bases on its parent's local branch. Drift no longer reports
  commits that the branch already contains. Found on DESKTOP-18833.

## [0.9.3] - 2026-10-21

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Nothing changes in what you do. If a `/pd:resume` stopped at step 1 asking you
to run `/pd:sync`, run `/pd:resume` again in a new session: its drift report
was measured against whatever `upstream/main` was last fetched.

### Fixed

- **`/pd:resume` fetches instead of calling `/pd:sync`.** Step 1 was a bare
  `/pd:sync`, which the model tried to invoke through the Skill tool. That
  command is reserved for the person, so the call was refused, nothing was
  fetched, and `pdkit drift` — which reads the local `upstream/main` and
  fetches nothing itself — measured against a stale ref. The step now runs
  `git fetch upstream --prune` and `git fetch origin --prune` directly.

## [0.9.2] - 2026-10-21

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Nothing changes in what you do. A body that preflight used to refuse now
passes; nothing that passed before is refused.

### Fixed

- **A ticked test checkbox no longer fails `pr-body-template`.** The check
  matched the template's `- [ ] Tests are covering the bug fix or the new
  feature` verbatim, so `- [x]` read as the line missing and only an
  unfinished body passed — the body preflight saw and the body published
  differed. Checkboxes are now compared unticked; a body without the line
  still fails.
- **The two preflight passes count in either order.** Running
  `--body-only --body <file>` first and the full pass second left `pdkit
  publish` refusing with "has only ever run without the pull request body":
  the full pass skips the body-dependent checks for want of a body, and those
  skips replaced the verdicts the body pass had recorded. A skip without the
  body no longer replaces a result that had it.

## [0.9.1] - 2026-10-21

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Nothing changes in what you do. The new line appears only when the model the
session is on and the model the phase is routed to differ.

### Added

- **A reminder when the session is on another model than the phase.** On any
  `/pd:<skill>`, the prompt hook compares the skill's `model:` with the model
  the session is on and, when they differ, shows you one line — "/pd:exec runs
  on sonnet, and this session is on opus — type /model sonnet now". It is shown
  to you (as `systemMessage`), not to the model, because only you can type
  `/model`. Hooks are not given the model, so it is read from the transcript:
  the last answer or the last `/model`, and right after `/clear` — when the
  transcript is new and the model has carried over — from the previous
  transcript of the same `claude` process (`CLAUDE_PID`). With nothing to read
  it falls back to the fork's default and says so; with no default either it
  stays quiet. Haiku skills are skipped.

## [0.9.0] - 2026-10-21

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Nothing to change in your config. `/pd:pr-sync` now stops once more than it
did — after reading the review, before any code changes — and runs on Opus:
`/model opus` and `/effort high` in the session you start it in.

MINOR rather than PATCH because a phase gained a stop it did not have.

### Changed

- **`/pd:pr-sync` asks before it changes code.** After reading the review it
  shows one table — every open item, the decision, how, and the files it would
  touch — and waits. Rows where the reviewer offered alternatives, where a fix
  would touch or create a file outside the slice, or where the plan changes are
  marked ⚠ and left to you. Only then do the resolvers run, each given its
  approved row, and a resolver that finds it needs another file or approach
  stops and reports instead of choosing. On #19750 the session chose, on its
  own, to move the fix into two new files outside the slice, and the first sign
  of it was the push.
- **The push in `/pd:pr-sync` is asked about with the diff on screen.**
- **`/pd:pr-sync` runs on Opus again, at `effort: high`.** 0.5.0 moved it to
  Sonnet on the grounds that a machine checks its verdict. A machine checks
  that a fix compiles and passes; it does not check which of a reviewer's
  alternatives to take, or whether a reply answers what was asked. The
  resolvers stay on Sonnet: they carry out a decision already approved.

### Added

- **`pdkit pr diff <k> [--stat]`** — what a push would change on an open pull
  request: its head as GitHub has it against the local branch, ahead and behind
  (a rewrite is said to be one), and every file the pull request would then
  carry outside its slice. The head is fetched from the fork when missing.
- **`pdkit pr threads` maps the files a review body cites.** Every
  `path:line` in a review or comment comes back under `cites`, with its slice
  or **unmapped**, and such an item counts as unmapped like a thread on that
  file. A review that never opened a thread used to map to nothing at all.

### Fixed

- On Windows every path git printed (`C:/Users/…`) is now in the platform's
  form (`C:\Users\…`), so a refusal no longer names the issue's tree one way
  and the current tree the other. CI is green on all three platforms again,
  for the first time since 0.6.0.

## [0.8.0] - 2026-10-20

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

If the fork's own checkout stands on a `DESKTOP-<n>/…` branch, move the branch
out before working on that issue:

```
git -C <fork> switch main
pdkit worktree create --issue <n> --branch DESKTOP-<n>/<branch>
```

Every command that takes the issue number prints exactly these lines when it
refuses, so there is nothing to look up.

MINOR rather than PATCH because commands that used to run in the main checkout
on an issue's branch now refuse there.

### Changed

- **The main checkout is nobody's tree.** It is the template worktrees are made
  from and stays on the base branch. An issue branch found there is reported as
  held by the main checkout, and the commands that are held to an issue's tree
  — `preflight`, `audit`, `validate`, `e2e stability`, `slice suggest|set|
  materialize|cascade` — refuse with one command to paste: switch the checkout
  back, create the worktree on that branch, rerun the command there.
  `pdkit editor` and `pdkit open tree` say the same.
- **The prompt hook moves the session instead of pointing.** A `/pd:` command
  typed outside the issue's tree now tells Claude to call `EnterWorktree` with
  the issue's tree before anything else, and lists the commands that create the
  tree first when it does not exist, to be shown to you before they run. A
  hook cannot change a session's directory, and that directory is where
  subagents work: started in the main checkout, `pr-sync`'s thread resolvers
  committed there. After `EnterWorktree`, subagents started afterwards work in
  the issue's tree — checked by hand with a general-purpose agent and
  `pd-scout`.
- **SessionStart in the main checkout on an issue branch** gives the same
  instruction instead of the issue's summary, which used to call the checkout
  the issue's tree.

### Fixed

- An issue branch held by the main checkout was reported as "checked out
  nowhere", and the `worktree create` offered for it failed with git's
  "already checked out".
- On DESKTOP-18915 `slice materialize`, run from the main checkout, left the
  pull request's branch there, and the next session's `pr-sync` committed the
  review fixes beside the issue's worktree. The branch name made the checkout
  look like the issue's tree, so no guard fired.

## [0.7.0] - 2026-10-20

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

A `validation.app.binary` or `validation.app.args` kept in `.pdkit.yaml` moves
to `$PDKIT_HOME/config.yaml`; a relative `PODMAN_DESKTOP_BINARY` becomes
absolute. `pdkit doctor` names either.

MINOR rather than PATCH because a value that used to be read stops being read:
only for those two keys, and only where they lived in `.pdkit.yaml`.

### Security

`validation.app.binary` is held to the rules 0.6.1 set for `editor.path`.
Validation runs the tree's own code by design, so a repository choosing the
binary gains less than it did choosing the IDE — but the binary could live
anywhere, and `validation.app.args` reached Electron, where
`--remote-debugging-address=0.0.0.0` hands the debug port to the network.

- `validation.app.binary` and `validation.app.args` are read from
  `$PDKIT_HOME/config.yaml` only. A `.pdkit.yaml` that sets either, or that
  moves `state.root` to a config of its own, makes `validate launch` refuse
  before anything is built, and `doctor` says so.
- The configured binary and `PODMAN_DESKTOP_BINARY` must be absolute paths —
  the launch runs from the working tree, where Windows looks for a bare name
  first — an `.exe` on Windows, and not writable by every user.
- The checks are shared with `pdkit editor`: `checkedProgram` in
  `lib/reveal.js`, and `trustedValue` in `lib/config.js` for which layers a
  key that names a program is read from.

## [0.6.1] - 2026-10-20

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Nothing changes in what you do. To use `/pd:editor`, set `editor.path` in
`$PDKIT_HOME/config.yaml` to the absolute path of your IDE — `pdkit editor`
prints the lines for your platform when it is unset.

### Added

- **`pdkit editor [<issue>]` and `/pd:editor`** open the issue's worktree in the
  IDE set as `editor.path` — a `.app` on macOS, an `.exe` on Windows, a launcher
  on Linux, always by absolute path. Without a number, the issue of the branch
  the tree is on. `editor.path` ships empty; unset, the command exits 1 and
  prints the config file and the lines to add for the platform it runs on.
- **`pdkit open home|issue|tree [<issue>]` and `/pd:open`** open `$PDKIT_HOME`,
  `issues/<n>` in it, or the issue's worktree in the file manager: `open` on
  macOS, `explorer.exe` on Windows, `xdg-open` on Linux. Exits 1 when nothing
  opened — headless Linux included — and prints the path either way.

### Security

Both commands start programs, and are built so that nothing a repository
contains gets to choose which:

- `editor.path` is read from `$PDKIT_HOME/config.yaml` only. A `.pdkit.yaml`
  that sets it, or that moves `state.root`, is refused with an explanation.
- On macOS, `open` on an application-bundle directory runs it — `open -a Finder`
  too, both checked by hand. A directory is canonicalised and refused if it is
  a bundle, by name or by `Contents/Info.plist`.
- Absolute paths only, for the IDE and for every platform tool: Explorer by
  `%SystemRoot%`, `/usr/bin/open`, `xdg-open` from absolute `PATH` entries
  only. Started without a shell, from the home directory. No `.cmd` or `.bat`
  (cmd.exe re-parses arguments, CVE-2024-27980), no network paths on Windows
  (an NTLM hash sent to the host), no IDE writable by every user.
- An issue number is digits only: `12abc` used to read as 12.
- Output is stripped of control characters, ANSI escapes and bidi overrides,
  and capped; git's own wording, which quotes branch names, is not passed on.
- `/pd:editor` and `/pd:open` never splice their arguments into a shell: they
  are matched against fixed shapes, then one fixed command runs, and the skill
  reads its output as data.

## [0.6.0] - 2026-10-19

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Then **`pdkit doctor --gate-selftest`**, once: this release registers a new
hook (`UserPromptSubmit`) in the manifest.

What changes in what you do:

- **Commands given an issue number refuse to run in another issue's tree.**
  `preflight`, `slice suggest|set|materialize|cascade`, `audit`,
  `validate launch|run|codify|attach --run` and `e2e stability` used to run on
  whatever tree the shell was in; now they stop before anything runs and print
  `cd <tree> && pdkit …`. A main checkout left on another issue's branch is the
  usual cause. `main`, or any branch that names no issue, still goes through.
- **`pdkit amendment approve` exits non-zero** when the amendment did not reach
  the record or plan.md, and names what is missing; `pdkit amendment sync`
  finishes it. An amendment whose `Requirements affected` table cannot be
  applied is refused and stays `proposed`.
- **Approving an amendment edits plan.md and `tasks/`.** Do not write an
  amendment's tasks by hand; approve renders them and withdraws the ones they
  replace.

### Fixed

- `agent-done` is no longer filed under the issue of whatever branch the tree
  happens to stand on. Without an active task, when another issue in progress
  was moved after the branch's one, the run is recorded with no issue and the
  reason in its detail (`not filed under 18967: the tree is on …, and 18915
  moved since`). On DESKTOP-18915 every subagent of an afternoon in a main
  checkout left on 18967's branch was counted for 18967, and `pdkit cost`,
  which attributes calls to the nearest journal entry, moved that work's cost
  there too. Entries already written stay as they are: the journal is
  append-only. The test is `state.movedSince`, shared with the SessionStart
  summary.
- The SessionStart summary no longer presents the branch of the tree as what the
  session is for. When another issue in progress was moved after the tree's one
  (state.json `updatedAt`), it says so — the tree's path and branch, and each of
  those issues with where its work is, by the same resolver commands are held to
  — and names no `run` command, model, budget or journal. Every DESKTOP-18915
  session after plan-approved opened in a main checkout left on 18967's branch,
  was told `run: /pd:pr-status`, and took `/pd:preflight 18915` for a typo.
  With a task running, a branch that names another issue than the task's is
  printed too, and the command is withheld the same way. Issues moved before
  the tree's one are not listed.
- Commands given an issue number hold to that issue's tree instead of whichever
  tree the shell is in. One resolver, `forIssue` in lib/worktree.js, finds the
  issue's work in order of trust — a registered worktree, then a local
  `DESKTOP-<n>/…` branch checked out nowhere, then the cwd — and a tree that
  belongs to another issue is refused before anything runs, with the command to
  run instead (`cd <tree> && pdkit …`). On DESKTOP-18915 the main checkout stood
  on 18967's branch: `slice suggest` handed the slicer 18967's diff as 18915's,
  and `preflight 18915` ran tests, lint and typecheck on 18967's tree before
  branch-name noticed. Held: `preflight`, `slice suggest|set|materialize|cascade`,
  `audit`, `validate launch|run|codify|attach --run`, `e2e stability`. A tree
  where nothing names the issue and the branch names no issue either — `main`,
  the start of the work — still goes through.
- `pdkit slice suggest|set` take `--ref <branch>` to read a diff without
  checking it out, and `--worktree <path|name>` to read another tree. A `--ref`
  that is another issue's branch is refused, here and in `pdkit audit`.
- `slice suggest --json` reports `branch` and `tree` beside `refName`, and the
  stored graph keeps `source.branch`. `refName: "HEAD"` alone gave the slicer
  nothing to compare with the issue number.
- `pdkit drift` finds an issue's local branch through the same helper, so only
  branches matching `DESKTOP-<n>/[<i>-]<slug>` count, the unsliced one first.
- An approved amendment now reaches the tasks, not only the requirements. The
  `### T<k>` blocks under `Slices affected` are read by the parser plan.md goes
  through, and approve renders `tasks/T<k>.md` from them, adds the blocks to
  plan.md's `## Tasks` and re-runs `task sync`. `### T5 (replaces T2 and T3):`
  marks T2 and T3 withdrawn — in their files (`- Status: withdrawn by A1
  (replaced by T5)`) and in the record — and drops their Owns, so a file is never
  claimed twice. On DESKTOP-18915 T5 and T6 were written by hand in the execution
  session and T2–T4 stayed live: the audit asked for their receipts and
  `owns.T2` kept a file A1 says nobody touches. A task heading that does not
  parse, a task reusing a live ID, or one claiming a file a live task owns keeps
  the amendment `proposed`. An existing task file is never overwritten.
- A withdrawn task is refused by the pre-write hook (for every file, including
  the ones it used to own), by `pdkit task start` and by `pdkit receipt write`,
  each naming the amendment and what replaced it. `pdkit audit` lists it as
  withdrawn with its amendment and does not count its missing receipt; a file
  only a withdrawn task owned counts as changed outside every task's ownership.
- `plan check` and `parsePlan` read `### T<k> (replaces …): title` headings,
  and leave a replaced task out of the checks. On 18915 the hand-copied T5 and
  T6 were invisible and plan check reported R7 as having no task.
- `pdkit amendment approve` applies the amendment to the plan, not only to the
  word in its own header. The `Requirements affected` table is parsed (several
  R-IDs to a cell; `added | withdrawn | unchanged | superseded by R<k> |
  replaced by R<k>`, anything else refused with its line) and applied to the
  frozen requirement set — the one exception to the freeze, reachable only
  through an approved amendment on disk and journalled as
  `requirements-amended` with the set before and after. plan.md's
  `- Requirements:` line is rewritten to the live set. On DESKTOP-18915 A1 was
  approved and both had to be mended by hand. The table is checked before the
  status is written, so an unapplicable amendment stays `proposed`.

### Added

- `pdkit amendment sync <A> --issue <n>` finishes an approved amendment that did
  not reach the record or plan.md (approve now says which, and exits non-zero).
  Nothing is applied twice; a record already mended by hand is recognised and
  marked as applied.
- `templates/plan-amendment.md` renders any number of requirement rows from a
  `rows` array in the values file. The one-row `rid`/`change`/`detail` keys
  still work.
- A `UserPromptSubmit` hook, `pdkit hook prompt-submit`. On `/pd:<skill> <n>`
  typed in a tree that is another issue's, it adds to the context where issue
  `<n>`'s work is — its worktree, or its branch checked out nowhere — beside
  this tree's path and branch, and that the number is not a typo. The number
  is read as an issue or a pull request by the skill's `argument-hint`; a pull
  request is followed to its issue through prs.json, and one not registered
  (`/pd:review-pr`) is left alone. It never blocks and writes nothing; any
  other prompt returns before git or `$PDKIT_HOME` is touched. SessionStart
  fires on `/clear`, before the prompt, so this is the first point at which the
  issue a session is for is known. The lookup of a pull request's issue moved
  from lib/cli.js to `pr.issueOf`, shared by `pdkit pr` and the hook.

## [0.5.2] - 2026-10-18

### Added

- `pdkit init` writes `"model"` into the fork's `.claude/settings.local.json`,
  so a fresh `claude` in the fork starts on the model most orchestrating skills
  declare — `sonnet` today, counted from their `model:` frontmatter rather than
  set anywhere new. The session model survives `/clear`, so this is the default
  every phase falls back to once a skill's one-turn `model:` lapses, and a
  review round started the next morning no longer goes to opus unasked. Only
  the local file is touched — `.claude/settings.json` is podman-desktop's own
  and tracked; other keys are merged, not overwritten; a `model` already there
  is kept unless `--force`; invalid JSON is refused, not replaced.
  `effortLevel` is not written: nothing confirms it is read at project level.
- `pdkit doctor` checks `settings:model` (optional): the fork's written model
  against the frontmatter count. A mismatch or a missing key warns, with the
  command that fixes it.

### Changed

- The audit skill runs on sonnet instead of opus. Since 815fa8a the phase's
  main thread judges nothing: it runs `pdkit audit`, dispatches pd-auditor,
  reads the short form, writes audit.md and moves the state. The verdict is
  pd-auditor's, made in its own context on its own `model: opus`. The session
  model survives `/clear`, so audit was the one opus island in the sonnet tail,
  and a forgotten switch after it carried opus into slice, pr and every
  pr-sync round. The cycle now has a single model switch, after plan-review.

## [0.5.1] - 2026-10-18

### Changed

- `pdkit next` prints `/model <model>` above the skill command, and the
  SessionStart summary adds a `model` line before `run`. A skill's `model:`
  frontmatter holds only until its turn ends — any user message ends it, a
  background subagent's hand-back included — so exec, validate, slice, pr and
  pr-sync drifted back to the session's model mid-phase. The model is read from
  that same frontmatter, not set anywhere new; the line is advice, and nothing
  checks that the session follows it.

## [0.5.0] - 2026-10-17

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Then **`pdkit doctor --gate-selftest`**, once. This release changes the hooks
(the receipt gate moves from `TaskCompleted` to `SubagentStop`) and the gate
itself (it now stands aside outside podman-desktop, and sees a subcommand behind
`git -C` / `gh -R`). The gate is registered by the manifest and executed by the
host, so an upgrade that broke that wiring leaves every test green and the
plugin gating nothing. After that, run any subagent and check that
`pdkit journal --event agent-done` prints a line.

**The cycle is now walked in several sessions, not one, and that is the point
of this release, not a regression in convenience.** Every phase ends by asking
you to close the session and open a new one for the next phase: one per slice
through `preflight` and `pr`, one per review round. `pdkit next <n>` prints what
to type in the new session, and the `SessionStart` summary tells it where the
issue stands. The reason is in the measurement behind this release
(`specs/2026-10-16-token-cost-analysis.md`): Claude Code re-reads the whole
context on every call, so a session costs the square of its length. On the
dearest cycle measured, **82 % of the cost was cache reads: re-reading context
the session had already accumulated**, not prompts, tools or model output. The
most expensive phases were `pr` and `pr-sync` (33–60 % of a cycle), only because
they came last in a long session. Nothing a phase needs is lost at the boundary:
`issue.md`, `plan.md`, `tasks/`, `receipts/` and the journal were always on disk,
and the next session reads them from there. No state, transition or gate
condition changed to make this work.

Also changed in what you do:

- **`/pd:pr` step 8 is `pdkit publish`**, one command in place of four. The four
  still work alone, for finishing a publication that stopped partway.
- **`pdkit issue fetch` prints the newest 15 comments**, plus a count of the
  rest. `--full` prints all of them. The body is still printed whole.
- **`pdkit cost`** and **`pdkit next`** are new.
- **The gate no longer refuses `git push` in other repositories.** This widens
  what it allows, as described under Changed. Deny rules still hold everywhere.

Nothing in `$PDKIT_HOME` has to be moved or edited, and an issue in flight is
unaffected. The state machine, the journal, the configuration loader and the
attempts record are byte-for-byte those of 0.4.0. The two new configuration keys
(`budget.turns`, `triage.fetch_comments`) come from the shipped defaults when
your `config.yaml` lacks them. `pdkit cost --snapshot` writes into a new
`cost/` directory and touches nothing else.

### Measured cost: before and after

`pdkit cost --compare 2026-10-16`, run on the release day:

```
route standard            before        after      delta
  per task                 13.3 M            —
  per changed line          160 k            —
  per merged PR             150 M            —
  avg context               274 k            —
  sessions per issue         1.50            —
  opus share                 62 %            —
  agent runs per task        1.40            —

  unattributed share         12 %         12 %
```

**There is no "after" yet.** No issue has started since the baseline snapshot,
so the analysis's projection (a cycle 6–9 times cheaper, `avg context` below
150 k) is neither confirmed nor refuted by this release. It is an expectation,
not a result. The first issue that goes through 0.5.0 will provide the after
figures, and they will be added here whatever they show.

### Added

- **`pdkit publish`: `/pd:pr` step 8 as one command.** The journal held 152
  push refusals against 22 open pull requests — about seven per real push — and
  the gate was right every time: what failed was running four commands in the
  right order. `pdkit publish --issue <n> --branch <b> --title <t> --body <file>
  [--slice <i>] [--base <b>]` runs `state --to preflight-green`, `gate open`,
  `git push` and `pr create` in that order and stops at the first refusal.
  - Nothing about consent moves. It asks nothing; step 6 — the person reading
    the body and the branch — comes before it, as before. preflight-green is
    reached by the same transition, from what preflight wrote. One token covers
    the push and the pull request, once each. There is no flag that skips,
    forces or extends anything.
  - It spends the push half of the token itself, before pushing, as the hook
    does: the push is started from Node, so the hook never sees it.
  - A stacked slice's base is taken from the graph and checked upstream
    **before** the push, so a base the fork-to-upstream pull request cannot use
    is refused with nothing public.
  - Stopping between the push and the pull request is said in so many words:
    the branch is public, the token has its pull-request half left until
    when, and the `pdkit pr create` to finish with.
  - Run again after a failed push, with the issue already `preflight-green`,
    it re-reads the preflight record for the commit now checked out instead of
    setting the state twice; a commit preflight never saw is refused.
  - `--pr <k>` publishes to an open pull request (`/pd:pr-sync` step 8):
    `push --force-with-lease`, then back to `pr-open`.
  - The four commands still work alone, for whoever is standing in the middle
    of a publication that stopped partway. `pdkit doctor --gate-selftest` now
    also checks that the hook lets `pdkit publish` through.

- **`pdkit cost`: what an issue cost in tokens, against how much work it was.**
  Reads Claude Code's transcripts (`~/.claude/projects/<slug>/`, or
  `--transcripts`), attributes each API call to the issue of the nearest earlier
  journal entry within six hours, splits it by phase at the state transitions,
  and divides by tasks, slices, requirements, changed lines, merged pull
  requests and agent runs. Issues are grouped by `route` and never compared
  across routes. The scale is cost units (input + 0.1 cache-read + 1.25
  cache-write + 5 output, x5 on Opus: list-price ratios, not dollars). Dollars
  are printed beside them for orientation only.
  `--issue <n>`, `--since <date>`, `--json`; `--snapshot` writes
  `$PDKIT_HOME/cost/<date>.json`, and `--compare <date>` puts that snapshot
  beside the issues journalled since. Like `pdkit stats`, it recommends
  nothing.
  - The unattributed share is always printed, as are the caveats on
    attribution, on changed lines (lockfiles and generated output count), and
    on comparing routes.
  - **One call is counted once.** Claude Code writes one response as one line
    per content block, each carrying the same `message.usage`; summing lines
    counted most calls two or three times. Calls are keyed by `message.id`, and
    the number of repeated lines dropped is printed. On four months of real
    transcripts this halved the parent-session figures of the first, line-summing
    analysis.
  - **Subagents are counted.** Their calls are in
    `<session>/subagents/agent-<id>.jsonl`, not in the session file, and were
    missing from the first analysis. They are read, kept apart by file rather
    than by `isSidechain`, and give an agent-run count that does not depend on
    the `agent-done` journal entry. The journal count is printed beside it.
  - Missing transcripts are a `skip` with the reason, not a row of zeros.

### Changed

- **The consent gate guards podman-desktop, not every repository on the
  machine.** Bash hooks are global, so `git push` was refused in any repository
  with the plugin loaded — its own checkout included — and the only way past
  was a `/pd:pr` flow built for podman-desktop. A gated command now runs without
  a token where `lib/hooks/scope.js` can prove it acts elsewhere: no remote of
  the working tree is `repo.upstream`, `repo.fork` or named `podman-desktop`,
  the line names neither, and nothing in it moves where it runs (`cd`, `git -C`,
  `--git-dir`, `--work-tree`, `GIT_DIR`, `GIT_WORK_TREE`, `GH_REPO`). Anything
  that cannot be proven — a config that does not load, a directory that is not
  a repository — keeps the gate on. Deny rules (force push, `--no-verify`,
  `add -A`, `rebase -i`, tracker writes) still hold everywhere, and every
  command the gate stands aside for is journalled as `allowed-outside`.
  `pdkit doctor --gate-selftest` now probes in throwaway repositories, one of
  each kind, so it reports the same wherever it is run from.
- **`pdkit audit` says who did each task.** Per task, `worker pd-implementer ×n`,
  `no pd-implementer (ran: …)`, `no subagent`, or `not recorded`, read from the
  `agent-done` entries the SubagentStop hook ties to the active task — never
  from what an agent said. The summary lists the tasks no implementer ran for,
  as a count of the whole. A task whose every start came before the journal's
  first `agent-done` is `not recorded`, because the hook was registered on an
  event subagents never raise until 0.4.0, and "no implementer" over that
  silence would be a claim nobody measured. A fact, not a gate: nothing is
  refused on it.
- **The diff is read by the auditor and the slicer, not by the session that
  dispatches them.** `/pd:audit` and `/pd:slice` read `git diff main...HEAD`
  and the `slice suggest` file map in the parent context, where on a large
  issue they stayed for the rest of the session. Both skills now hand the agent
  the issue number and nothing else, and `pd-auditor` and `pd-slicer` answer in
  a fixed form of at most 40 lines — the shape `pd-scout` already used, with a
  `file:line` on every finding and no fixes. The auditor's answer is what goes
  into `audit.md`. `/pd:exec` also says why a task goes to `pd-implementer`
  rather than being done in the session: 82 tasks were started against 29
  implementer runs, and a subagent returned about 250 tokens to its parent where
  the same work done in place stays in context until the cycle ends.
- **The cycle is now walked in several sessions, not one.** Each orchestrating
  skill — `triage`, `plan`, `plan-review`, `exec`, `validate`, `audit`, `slice`,
  `preflight`, `pr`, `pr-sync`, `close`, `quickfix`, `resume` — ends its
  `## Next` by saying the next phase starts in a new session, and why: context is
  re-read whole on every call, so a session costs the square of its length, and
  the dearest one measured (676 calls, 878 k tokens of context, never compacted)
  spent 90 % of its input re-reading what it had accumulated. For you this means
  closing the session when a phase ends and opening another, one per slice
  through `preflight` and `pr`, one per review round. Nothing the next phase reads
  is lost: it is on disk, as it always was. No state, transition or gate changed.
- **`pdkit next <n>`** prints one line: what to run next for the issue. For the
  start of a fresh session, where it is cheaper to type than to remember. A
  terminal state is said in words rather than printed as an empty line.
- **The `SessionStart` summary appears between phases, not only inside exec.**
  It used to need a running task, which exists only between `task start` and
  `task stop` — so at every phase boundary but those, the session that was meant
  to be cheap to open opened on nothing. With no task running, the issue is now
  read off the tree's `DESKTOP-<n>/…` branch. A tree on any other branch, an
  issue with no record and a terminal one still get no output.
- **`budget.turns` in `defaults/config.yaml`**: a soft ceiling per phase, in turns
  (`triage` 40, `plan` 60, `exec_per_task` 80, `validate` 80, `audit` 40,
  `slice` 60, `pr` 50, `pr_sync` 60). The `SessionStart` summary prints the one
  for the phase it opens, and the eight skills those phases belong to say what to
  write to disk and to ask for a restart when a phase runs well past it. Nothing
  enforces it, and nothing could: no command can see how many turns a session has
  taken, and the model cannot count its own precisely. The skills say so.
- **Five phases moved from Opus to Sonnet**, each because what decides there is a
  machine, not the model:
  - `slice` and `pd-slicer`: file independence is refused by `pdkit slice set`
    and symbol dependence settled by the exit code of `pdkit slice verify`; the
    cut that is left is approved by a person at `slices-approved`.
  - `pr`: steps 1–5 are branch, squash and two preflight passes whose green the
    gate is issued from, and step 6 hands the body to a person to read.
  - `pr-sync`: the threads arrive already mapped to slice, task and requirement
    by `pdkit pr threads`, a fix counts only once preflight is green again, and
    an amendment waits for a person.
  - `resume`: `pdkit drift` marks the commits that touched lines the plan
    cites, and `slice verify --standalone` plus preflight re-verify every slice
    from scratch after the rebase. Each conflict is still classified by
    `pd-conflict-analyst`, on Opus.

  `triage`, `plan`, `plan-review`, `audit`, `pd-auditor`, `pd-plan-critic`,
  `pd-review-synth` and `pd-conflict-analyst` stay on Opus: nothing re-checks
  their verdict mechanically. For the conflict analyst that is the semantic
  conflict which merges cleanly: the build is green, and the code no longer does
  what the plan intended.
  A skill's `model:` holds only until the end of the turn it was invoked in, so
  for a skill this moves the first turn, and the rest of the phase runs on the
  session's model — see CONTRIBUTING.md. For an agent it moves every call.
- **`effort:` in every orchestrating skill**: `high` for `triage`, `plan`,
  `plan-review` and `audit`, `medium` for the rest. It overrides the session
  level, including a global `"effortLevel": "xhigh"`, while the skill is active.
  `CLAUDE_CODE_EFFORT_LEVEL` still wins over it. Phrase-triggered skills carry
  none, so they never change the level of the phase they fire inside.

### Fixed

- **A denied command no longer rides along behind a gated one.** The gate
  looked at the first rule a line tripped and no further, so in
  `git push && gh issue comment 1 -b x` a valid token for the push let the
  comment run too, though tracker writes are denied always. A deny anywhere in
  the line now refuses the line, before any token is asked about.
- **An option before the subcommand no longer hides a push from the gate.**
  Every rule matches on an argument prefix, and `git -C <dir> push` has `-C`
  where the prefix expects `push`: the line matched no rule and ran with no
  token. `git -c key=value push`, `git --git-dir=… push` and
  `gh -R owner/repo pr create` were the same hole, and so was every deny rule
  behind one of them — `git -C x push --force`, `git -C x commit --no-verify`.
  The parser now moves git's and gh's leading options into a separate
  `globals` list, values included, so the rules see the subcommand.
- **`pdkit issue fetch` prints the newest comments, not all of them.** Forty
  comments on a podman-desktop issue is ordinary, and every one went into the
  session that opens the dearest phase of the cycle. It now prints the newest
  `triage.fetch_comments` (15) and a line counting the earlier ones, and
  `--full` prints them all. The newest rather than the oldest, because a
  discussion converges on its answer. The body is untouched: still printed
  whole, with no setting that would cut it. `--json` is unchanged.

- **`pdkit receipt write`, `pdkit validate run` and `pdkit e2e stability` no
  longer print the run.** They wrote the whole capture to stdout, which put it in
  the session's context until the session ended: receipts on disk reach 454 KB,
  73 of them came to 2.55 MB, and `e2e stability` printed three Playwright runs
  in a row (180 + 172 + 168 KB on DESKTOP-18967). Each now prints what
  `pdkit slice verify` already did — the path to the file — with the exit code,
  duration and digest, and on a non-zero exit the last 40 lines
  (`FAILURE_TAIL_LINES`), because a failing assertion is printed at the end of a
  run. The capture and the receipt are unchanged and still whole; only what is
  printed about them is shorter. `e2e stability --json` reports each run's path
  and digest instead of the last run's output.

- **The receipt gate and the `agent-done` count never ran: the hook was
  registered on the wrong event.** It sat on `TaskCompleted`, which Claude Code
  raises when a TaskUpdate marks a task-list item complete or an agent-team
  teammate finishes, never when an Agent-tool subagent returns. A live probe
  against Claude Code 2.1.301 showed a subagent's return raising `SubagentStop`
  and nothing on `TaskCompleted`. The journal agreed: four months of use, 79
  subagent dispatches, zero `agent-done`, zero `task-receipt … accepted`. So one
  of the three things `docs/architecture.md` calls enforced was enforcing nothing.
  - The handler is now registered on `SubagentStop` (`pdkit hook subagent-stop`),
    with no matcher, so every agent type is counted. `TaskCompleted` is no longer
    registered, because the plugin uses neither of the things it fires for.
  - `agent-done` now names the agent type the host reports, as in
    `agent task a57e6dd1…; pd:pd-scout`. The id comes from `agent_id`, because
    `SubagentStop` sends no `task_id`.
  - Exit 2 on `SubagentStop` keeps the subagent running with the refusal as its
    next instruction. That is right for "capture a receipt" and "fix the work".
    At the attempts ceiling it would force the fourth try the ceiling exists to
    prevent. So the blocked refusal is delivered once, and when the host asks
    again (`stop_hook_active`) the subagent is let go with the same message.
  - **Only `pd:pd-implementer` is held to the receipt.** Before, any subagent
    that finished while a task was active was asked for that task's receipt.
    That was harmless while the gate never ran. On `SubagentStop` a refusal
    keeps the agent running, so a scout or an auditor launched during
    `/pd:exec` would have been held until it wrote a receipt for work that was
    never its job. Other agents are still counted. A payload with no
    `agent_type` is gated rather than let through.
  - **A run that cannot capture is let go instead of held forever.** `pdkit
    receipt write` can fail before it captures anything: no task file, or a
    `Done when` that is prose. That records no attempt, so the attempts ceiling
    never arrives, and every stop was refused with the same instruction. The
    hook now counts the run's stops since the task's last capture, from the
    `agent-done` and attempt entries already in the journal. On the third, the
    refusal says the next stop is let go. The fourth is allowed as `stalled`.
    That is not acceptance: no `task-receipt … accepted` is written, and the
    audit still reports the receipt as missing.
  - **`pdkit doctor` warns when the journal has no `agent-done` for 30 days.**
    `hooks` only proved that the manifest names a handler that exists. It could
    not prove that the host ever sends the event, and it stayed green throughout.
    This is a warning, not a failure, because a fresh install has no history.
  - After upgrading, run any subagent and check that `pdkit journal --event
    agent-done` prints a line.

## [0.4.0] - 2026-09-22

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Then **`pdkit doctor --gate-selftest`**, once — this release changes a hook, and
the gate is registered by the manifest and executed by the host, so an upgrade
that broke that wiring leaves every test green and the plugin gating nothing.

Nothing in `$PDKIT_HOME` has to be moved or edited, and an issue in flight is
unaffected: no state transition changed, and `issue.md` files written by earlier
versions are read as they stand — the new `## Prior context` section appears in
the ones written from now on.

Two things are worth knowing before the next cycle:

- **`/pd:triage` now keeps what you type after the first line.** The issue
  number or URL goes on the first line as before; anything below it is recorded
  verbatim as prior context — related work already merged, an approach to repeat
  or to avoid, a trap the last attempt hit. It was previously available only in
  the chat message that started the triage, and died with the session.
- **The journal gains `agent-done`, one entry per subagent completion.** It is
  the denominator for cost: an issue with seven tasks and two slices is supposed
  to be dearer than a one-task fix, and until now nothing told those apart from
  a cheap issue and a wasteful one. Counting starts with this release — the
  entries are written as the agents finish, and cannot be reconstructed for work
  that ran before it.

### Added

- **The journal counts the agents that ran.** Nothing recorded how much
  machinery an issue took, and that is the number which survives comparison
  between issues when a bare cost does not: an issue with seven tasks and two
  slices is supposed to be dearer than a one-task fix, and without a count the
  two are indistinguishable from a cheap issue and a wasteful one.
  - **Measured, not reported.** The `TaskCompleted` hook already fired on every
    subagent completion and returned early when no task was active — so the
    scouts, the plan critic, the auditor, the slicer and the reviewers all
    passed through in silence. It now writes `agent-done` first and decides
    afterwards: an agent that finishes has run, whatever the handler then makes
    of its claim, and counting only the accepted completions would make the
    record cheapest exactly where the work went worst. A count the session wrote
    about itself would be one it could forget to write.
  - **It does not say which agent it was.** The payload carries Claude Code's
    own task identifier and the working directory; the agent's name is not in
    what the hook is given, and a field invented to hold it would make the entry
    claim more than was measured.
  - **The issue comes from the active task pointer, or from the branch, or from
    nowhere.** `DESKTOP-<issue>/<slug>` is a name this plugin wrote, so reading
    it is not a guess — and an agent that ran in a checkout on somebody else's
    branch is recorded with no issue rather than attributed to one. In the file
    nothing may rewrite, a wrong attribution is worse than none.
  - **It stays out of the re-anchoring summary.** `SessionStart` injects the
    last eight entries of an issue, and one `/pd:exec` with five implementers
    would have filled that window with "an agent finished" — pushing out the
    receipt, the approval and the freeze, which are what somebody returning to
    the work needs. The entries stay in the journal, where the counting reads
    them; what they do not get is the context budget.
  - Read it with `pdkit journal --issue <n> --event agent-done`; `--event` was
    already a flag on that command.

- **The context a person has when they start an issue now has somewhere to
  live.** Related work already merged, an approach to repeat or to avoid, a trap
  the last attempt hit, a pull request worth reading before the code — none of
  it is in the issue text, and until now the only place to say it was the chat
  message that started the triage. That message dies with the session, so
  `/pd:plan` three days later never saw it, which is the argument this whole
  plugin makes about keeping state on disk.
  - **The rule is a line boundary, so nothing has to parse it.** The first line
    of `/pd:triage <n>` is the invocation; everything after it in the same
    message is prior context, and it lands in a new `## Prior context` section
    of `issue.md`.
  - **Verbatim, not summarised.** A summary is the plugin's reading of what
    somebody told it, and a wrong reading does not stay where it was made — it
    reaches the plan, the tasks and the audit as a record everything downstream
    trusts. The section is read back before the file is written, the way the
    `[inferred]` requirements already are.
  - **`[operator]`** joins `[issue]`, `[paraphrase]`, `[inferred]` and
    `[review]` as a requirement's source. A requirement stated by whoever
    started the triage is not `[issue]` — that tag means a maintainer can be
    pointed at the line that says it — and it is not `[inferred]` either,
    because the plugin concluded nothing.
  - **Nothing given is written down as nothing given.** The template declares
    the placeholder, so `render()` refuses without it — `render(issue): nothing
    given for {{priorContext}}` — and `none given` is what most triages will
    say. An empty section reads as forgotten rather than as absent, which is the
    same reason a PR body says "n/a — no UI change".
  - What survives a second triage is the journal: `pdkit state <n> --to triaged
    --reason "…"` says whether context came with the command, and neither
    `issue rework` nor `reset` may delete a journal entry.

## [0.3.0] - 2026-09-22

### Upgrading

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

Then **`pdkit doctor --gate-selftest`**, once — the gate is registered by the
manifest and executed by the host, so an upgrade that broke that wiring leaves
every test green and the plugin gating nothing.

Nothing in `$PDKIT_HOME` has to be moved or edited, and an issue in flight is
unaffected: no state transition changed, and `pdkit pr render` fills the new
`## Requirements` section of `prs/<k>.md` the next time it runs.

One thing to know if you script around preflight: **`r-coverage` is gone**, so a
run reports one fewer check and the R-IDs it demanded are no longer expected in
the pull request body. What it protected is unchanged — `pdkit slice set` still
refuses a graph in which a frozen requirement reaches no slice.

### Changed

- **The pull request body says less, and the steps say as much as ever.** On
  [podman-desktop#19317](https://github.com/podman-desktop/podman-desktop/pull/19317)
  a reviewer wrote: "The PR description, is unnecessary long and verbose, IMHO
  we don't need that much verbosity, this makes it harder to review because of
  the content to read. We should focus on direct important info, the changes per
  file is not needed." Measured across the author's thirty pull requests
  upstream, the break is exactly where this plugin starts writing the body:
  twenty-two written by hand ran 378–2551 characters, eight written through
  `/pd:pr` ran 2069–**14015**. The complaint arrived on one of the smaller
  generated ones, which is the part worth knowing — the reviewer's limit sits
  below this plugin's most modest result, so "shorter next time" was never going
  to be enough.
  - **`How to test this PR?` is not touched, and is the only section with no
    budget.** It is what a reviewer executes rather than reads. Everything else
    was cut around it: 600 characters for what the change does, 300 for where to
    look, 400 for notes, 200 each for the UI evidence and the issue references,
    120 for what is not in this PR — 1820 in total, which is the shape of
    #17472, merged without a word about its length.
  - **What comes out is what a reviewer cannot act on**: the reasoning trail
    that produced the change (that is the plan, and the plan is not published),
    the review history (the pull request conversation has it), and registers of
    residual risk. `Where to look` stays, because naming what may be **skipped**
    is the opposite of listing the changes per file.
  - **`pr-body-size` measures it and does not block.** Same reasoning as
    `quickfix-size`: a gate that stops a correct change over a long paragraph is
    one people learn to route around, and the cost of being wrong is a reviewer
    reading two extra sentences. It bounds the steps section without counting it
    — a number that quietly included the steps would push the one part worth
    expanding in the direction of the thing the check exists to prevent.
  - **The requirement trace moved rather than disappeared.** R-IDs are how this
    plugin tracks its own work and say nothing to somebody holding the issue and
    the diff, so they now render into `$PDKIT_HOME/issues/<n>/prs/<k>.md`, which
    is never published, and `pr.requirementsOf()` is the join that gets them
    there.

### Removed

- **`r-coverage`, the preflight check that required every R-ID to appear in the
  published body.** It was the reason the body carried a coverage table — the
  "changes per file" the reviewer named — and the guarantee behind it was never
  its own: `requirementProblems()` in `lib/slice.js` already refuses to store a
  graph in which a frozen requirement reaches no slice, and "an R-ID that
  reaches no PR is a requirement nobody shipped" is its message, not this one's.
  Outside the quickfix route, where `r-coverage` skipped anyway, a graph is
  always cut — so this check added no guarantee, only a demand on the shape of
  the body. **A blocking check that stops blocking is not a silent change**,
  which is why it is stated here rather than in a diff.

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

[Unreleased]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.10.1...HEAD
[0.10.1]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.9.6...v0.10.0
[0.9.6]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.9.5...v0.9.6
[0.9.5]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/vzhukovs/podman-desktop-kit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vzhukovs/podman-desktop-kit/releases/tag/v0.1.0
