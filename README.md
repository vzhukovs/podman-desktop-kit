# Podman Desktop Kit

A Claude Code plugin for working upstream issues in
[podman-desktop](https://github.com/podman-desktop/podman-desktop): triage an
issue, plan it, implement it, slice the result into atomic pull requests, and
carry those pull requests through review.

It is built around one fact — **you do not own the repository you are opening
pull requests against** — and most of what follows is a consequence of that.

> **Status: 0.1.0, a proof of concept.** Two routes have gone end to end to a
> published upstream pull request, and most of the workflow was driven through
> `pdkit` in a terminal rather than through `/pd:*` in a session — so twenty of
> the twenty-one skills have never run.
> [Status and limitations](#status-and-limitations) has the full accounting, with
> evidence per line.

## Why it exists

Working someone else's repository is different from working your own. You cannot
store workflow state in the tree, you cannot open scratch issues, and a sloppy
push is public noise in a project you do not own. The plugin encodes that
asymmetry:

- **State lives outside the repository**, in `$PDKIT_HOME`, keyed by issue
  number. Five worktrees see one state, not five copies of it.
- **Writes to GitHub pass a gate.** `git push` and `gh pr create` are denied by a
  hook unless a short-lived consent token exists for that exact branch. Writes to
  the issue tracker are denied outright — a human posts those.
- **"Done" means attached command output**, not a claim. Task completion is
  blocked without a receipt, and `pdkit` runs the command itself, so there is no
  parameter through which a summary could stand in for a run.
- **One change set becomes N atomic PRs.** Slicing is verified mechanically: a
  slice is independent only if it builds, lints, and tests standalone from
  `main`.

## Install

**One clone, two remotes.** Upstream is never checked out separately — diffs
against `main` come from `upstream/main` in the same clone.

```bash
# fork podman-desktop on GitHub first, then
git clone git@github.com:<you>/podman-desktop.git
cd podman-desktop
git remote add upstream https://github.com/podman-desktop/podman-desktop.git
```

Then add the plugin:

```
/plugin marketplace add vzhukovs/podman-desktop-kit
/plugin install pd@podman-desktop-kit
```

Or, to try it without installing:

```bash
claude --plugin-dir /path/to/podman-desktop-kit
```

### First run

```bash
pdkit init                      # state directory, config, package map
pdkit doctor                    # what is missing and what degrades without it
pdkit doctor --gate-selftest    # the only check that answers "is the gate on"
```

`init` reads your fork's name from the `origin` remote and writes it into
`$PDKIT_HOME/config.yaml` — there is nothing to configure by hand before running
it, and nothing to type that the clone does not already know.

Run the self-test after installing and after any upgrade. Every unit test in the
suite stays green while a plugin whose manifest did not load gates nothing at
all, so it is the one check that cannot be replaced by the test suite.

Upgrading later:

```
/plugin marketplace update podman-desktop-kit
/plugin update pd@podman-desktop-kit
/reload-plugins
```

See [RELEASING.md](RELEASING.md) for what a release contains and how versions are
decided.

## Commands

All orchestrating skills are manual only — nothing starts on its own.

| Command | What it does |
|---|---|
| `/pd:doctor` | environment report |
| `/pd:sync` | fork and worktree status |
| `/pd:triage [<issue>]` | classify the issue, draft requirements, pick a route. Without a number: shortlist the backlog by what can actually be started |
| `/pd:plan <issue>` | scout the code, then produce a plan with executable done-criteria |
| `/pd:plan-review <issue>` | adversarial review of the plan, before any code |
| `/pd:exec <issue> [task]` | implement, one task per worker, receipts required |
| `/pd:validate <issue>` | drive the built app, collect evidence, propose an e2e test |
| `/pd:audit <issue>` | diff against plan, fresh context |
| `/pd:slice <issue>` | turn the change set into a verified graph of atomic PRs |
| `/pd:preflight <issue\|slice>` | deterministic gates (tests, lint, SPDX, commits, schemas, …) |
| `/pd:pr <issue> [slice]` | branches, PR bodies, and the only place that writes to GitHub |
| `/pd:pr-status` | dashboard across open PRs |
| `/pd:pr-sync <pr>` | triage review threads, fix, reply, resolve |
| `/pd:resume <issue>` | come back after a break: drift analysis, rebase, amend |
| `/pd:review-pr <pr>` | review someone else's PR along four parallel axes |
| `/pd:quickfix <issue>` | small fix without the planning ceremony |
| `/pd:close <issue>` | harvest knowledge, clean up worktrees |
| `/pd:knowledge` | revise the shipped knowledge base |

Three more skills trigger by meaning rather than by slash: `package-map`,
`upstream-rules`, `worktree-kit`.

Everything they do rests on `pdkit`, a zero-dependency CLI the plugin puts on
`PATH`. `pdkit --help` lists it; you can drive the whole workflow from a terminal
without a Claude Code session, which is how most of it was tested.

## Status and limitations

Stated in full, because "the plugin is tested" should not be read more widely
than it is. [`docs/specification.md`](docs/specification.md) section 13 keeps this
list, and it has a rule: a line leaves the second table by the same thing that
puts one there — a journal entry, or an artefact you can point at.

**Verified against live upstream:**

| What | Evidence |
|---|---|
| The `quickfix` route end to end | issue #18248 → [PR #18561](https://github.com/podman-desktop/podman-desktop/pull/18561), the whole journal from `triaged` to `pr-open` |
| The `standard` route end to end | issue #17221 → [PR #18562](https://github.com/podman-desktop/podman-desktop/pull/18562), including plan approval, receipts, validation, slicing and materialisation |
| Validation with Playwright and a codified e2e test | four green runs in a row, tied to a digest of the spec |
| Reviewing other people's pull requests | two reports, `REQUEST_CHANGES` and `APPROVE_WITH_NITS` |
| The gate firing as a hook rather than as a function | a `denied` journal entry from a handler the host launched |
| Slicing from a published pull request, and the archaeology behind `redo` | dry runs against upstream PRs, no writes |
| The plugin loading, and a skill running as `/pd:*` | `claude --plugin-dir . -p "/pd:doctor"` against the fork returns the full report, so the manifest loads and `bin/` reaches `PATH` |

**Never executed, in order of risk:**

| What | Why it matters |
|---|---|
| **Twenty of the twenty-one skills**, and installing from a marketplace rather than a directory | Skill bodies are prose, which is the half of this plugin nothing covers; and a catalogue install is a different code path from `--plugin-dir` |
| **Four of the six hook events**, and agent dispatch by name | `pre-bash` has one genuine firing and `pre-write` is exercised through the manifest. The rest have only ever been spawned by a self-test, which proves the handler works and not that the host calls it |
| **Cutting into several slices, stacking, and `cascade`** | The densest machinery in the plugin. The only live graph was one slice |
| **`pr-sync` end to end**, including the two GraphQL mutations | They need somebody else's review thread; synthetic material would be self-confirmation |
| **`close --finish` and the transition to `merged`** | The rollup that distinguishes a three-slice issue from a one-slice one has never fired |
| **`resume` against a real conflict** | No semantic conflict has occurred yet — not for want of trying, but for want of material |

None of it blocks use. Each closes with the next issue of the right kind.

## Requirements

| Required | Why |
|---|---|
| Node.js >= 22 | `pdkit` is zero-dependency ESM and uses the built-in test runner |
| `git` | branch, worktree, and history primitives |
| [`gh`](https://cli.github.com/) | issues, pull requests, and review threads |
| `pnpm` | the package manager podman-desktop uses |

Optional MCP servers, all detected by `/pd:doctor`, all degrading gracefully when
absent:

| Server | Used by | Without it |
|---|---|---|
| Playwright | `/pd:validate` | validation produces a human checklist instead of evidence, and does not mark PASS |
| context7 | planning and review, for questions about someone else's library | the answer comes from the model's own knowledge of that library's versions, which goes out of date without saying so |

The plugin ships no `.mcp.json` on purpose: a plugin-level MCP declaration would
load for everyone, and these are meant to be optional. Configure them yourself;
see [`docs/configuration.md`](docs/configuration.md).

Playwright is the one with a setup detail worth stating here. `pdkit validate
launch` starts the application with remote debugging on and prints the endpoint;
the server attaches to it, which is how podman-desktop's own e2e suite drives the
app. One command, once per machine:

```bash
claude mcp add playwright -s user -- \
  npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222
```

`-s user` matters: the default scope is keyed by the directory you ran it in, and
every issue worktree is a different directory. `/pd:doctor` reports the endpoint
it found, not merely that a server exists.

## Documentation

| Document | What it answers |
|---|---|
| [`docs/workflows.md`](docs/workflows.md) | every use case, with the commands and the decision points |
| [`docs/specification.md`](docs/specification.md) | the design: what each piece guarantees, and why the guarantees stop where they do |
| [`docs/architecture.md`](docs/architecture.md) | the same in five minutes |
| [`docs/configuration.md`](docs/configuration.md) | the three config layers and what every key decides |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | how to add a command, a skill, an agent or a check — and how to test it |
| [`RELEASING.md`](RELEASING.md) | versioning, the release runbook, and how colleagues get updates |
| [`CHANGELOG.md`](CHANGELOG.md) | what each release contains |

## Layout

```text
bin/pdkit          deterministic CLI, added to PATH by the plugin
lib/               its implementation: state machine, slicing, gates, preflight,
                   validation, reviews of other people's pull requests
skills/            21 skills — the workflow surface
agents/            14 agents — scouts, implementers, auditors, reviewers
hooks/hooks.json   six entries; the rules live in lib/hooks/
knowledge/         upstream constitution, package map, known traps
templates/         plan, task, receipt, validation, slices, PR body, review report
test/              node --test, zero dependencies
docs/              the documents above
```

## Licence

Apache-2.0. See [LICENSE](LICENSE).
