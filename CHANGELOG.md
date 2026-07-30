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

### Notes

- Nothing is functional yet. `pdkit` answers `--version`, `doctor`, and
  `hook <event>`; every other command is a stub.
