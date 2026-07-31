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

### Changed

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
- `templates/pr-body.md` rebuilt on the upstream template's four sections.
- Deny rules gained their `when` predicates. As shipped in the skeleton, six of
  the eight matched only a program and subcommand — the force-push rule refused
  every `git push`, `no-verify` every `git commit`, and the `gh` rules gated
  reads.

### Notes

- Stages 3 to 5 remain stubs: no slicer, no PR lifecycle, no Playwright
  validation. The skills for those say so instead of improvising.
- Stage 2 is **implemented in code and not confirmed in practice**, on the same
  terms as stage 1. Its readiness signal in section 12 is "the auditor caught a
  divergence the implementer did not notice", and that is settled by the single
  live run deferred until after stage 5 — not by the test suite.
- Auto-blocking a task after N attempts is still not implemented;
  `templates/task.md` no longer promises it.
- `slicing.layer_order` does not cover three packages of the fork
  (`packages/api`, `packages/webview-api`, `storybook`); `pdkit doctor` warns.
  The decision belongs to stage 3, where slice order first matters.
