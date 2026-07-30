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

### Changed

- `knowledge/upstream-rules.md` verified against podman-desktop at `b0e77bc`.
  The SPDX header is the Red Hat Apache block, not a bare identifier line, and
  the commit scope is optional rather than required — the earlier text would
  have taught preflight to enforce both incorrectly.

### Notes

- The workflow itself is still inert: `/pd:*` skills are stubs, no hook handler
  decides anything yet, and nothing writes to GitHub. Those land with stage 1.
