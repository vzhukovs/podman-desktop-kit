# Contributing to podman-desktop-kit

This is a plugin for working on **somebody else's** repository, and most of its
design follows from that. Before changing anything, it is worth reading
[`docs/specification/`](docs/specification/README.md) — at least
[section 2.2](docs/specification/02-plugin-structure.md#22-state-outside-the-repository), which
lists the five invariants a change must not break, and [section 6](docs/specification/06-hooks.md), which explains
why some rules are hooks rather than instructions. For the short version,
[`docs/architecture/`](docs/architecture/README.md) covers the same ground in
seven parts.

Every document under `docs/` is split one file per section, part or scenario,
and section numbers are stable: a comment in `lib/` that cites "section 7" means
[`docs/specification/07-preflight.md`](docs/specification/07-preflight.md). Keep
it that way — a new section is a new numbered file, linked from its directory's
`README.md` and from the previous and next files' footers, not a heading
appended to a neighbour.

## Environment

| Required | Why |
|---|---|
| Node.js >= 22 | `pdkit` is zero-dependency ESM and uses the built-in test runner |
| `git` | branch, worktree, and history primitives |
| [`gh`](https://cli.github.com/), authenticated | issues, pull requests, review threads |
| `pnpm` | only for exercising the plugin against a real podman-desktop fork |

```bash
git clone git@github.com:vzhukovs/podman-desktop-kit.git
cd podman-desktop-kit
npm test                       # no install step: there are no dependencies
claude --plugin-dir .          # load your working copy as a plugin
```

There is no build. `lib/` is what runs.

## The one rule that decides where code goes

**Anything that must be *true* belongs in `lib/` or `lib/hooks/`, where it can be
tested. Anything that requires *judgement* belongs in `skills/` or `agents/`.**

A rule stated only in a prompt is a rule that holds most of the time. That is
usually fine; it is not fine for the rules this plugin exists to hold — that a
push cannot happen without consent, that "done" means captured output, that a
slice was actually built.

The corollary is the shape almost every module here has: **collect facts, reach
no verdict.** `lib/audit.js`, `lib/threads.js`, `lib/review.js`, `lib/backlog.js`
and `lib/archaeology.js` all follow it. If you find yourself adding a `score` or
a `recommendation` field, that is the boundary being crossed.

## Where things live

| You want to change | Touch | Test |
|---|---|---|
| a `pdkit` command | `lib/commands/<command>.js` (its handler and the flags it reads), its `REGISTRY` row and usage text in `lib/cli.js`, and the module that does the work | the module's own `test/<module>.test.js`; `test/invariants.test.js` and `test/flags.test.js` for the table |
| a deterministic rule | the owning module in `lib/` | same |
| a hook's behaviour | `lib/hooks/<handler>.js`; the event map in `lib/hooks/events.js`, the deny rules as data in `lib/hooks/rules.js` | `test/rules.test.js`, `test/dispatch.test.js`, and **`pdkit doctor --gate-selftest`** |
| a preflight check | one file under `lib/preflight/checks/` (exporting `needsBody` if it reads the body), its id added to `CHECK_IDS` in `lib/preflight/index.js` | `test/preflight.test.js`, `test/preflight-body.test.js` if it reads the body |
| an artefact's shape | `templates/*.md`, registered in `TEMPLATES` in `lib/render.js` | `test/render.test.js` |
| what a skill does | `skills/<name>/SKILL.md` | `test/invariants.test.js` checks every `pdkit` command and every `/pd:*` a skill names exists, and that plugin files are reached through `${CLAUDE_PLUGIN_ROOT}/` |
| what an agent does | `agents/pd-<name>.md` | the same `${CLAUDE_PLUGIN_ROOT}/` check |
| the shipped knowledge base | `knowledge/*.md` | `pdkit knowledge check` |
| the documentation | `docs/<area>/`, one file per section, part or scenario; the four root files | `test/invariants.test.js` checks every `/pd:*` named in `docs/` and `README.md` |

### Adding a `pdkit` command

1. Implement it in the module that owns the data. If no module owns it, that is
   the finding — see below.
2. Write its handler as `lib/commands/<command>.js`, exporting `flags` and
   `run(args, flags)`. What two commands need goes in `lib/commands/support.js`,
   never in `lib/cli.js`: a command module does not import the dispatcher.
3. Add a row to `REGISTRY` in `lib/cli.js` — the module itself — and write the
   usage line. `COMMANDS` and `COMMAND_FLAGS` are read off the registry, and
   `main` dispatches through it, so there is no second list to keep in step.
   `lib/cli.js` keeps only argv parsing, the registry, `pdkit hook` and exit
   codes.
4. Declare every flag it reads in the module's `flags`. Every command refuses a
   flag it does not declare, and `test/invariants.test.js` fails on a flag a
   handler reads that no row declares, on a row that declares one nothing
   reads, and on a command module reading a flag it does not declare itself.
5. Document the flags in the usage text. A flag that exists in code and not in
   `--help` is a flag nobody uses — that happened to `close --confirmed`.
6. If a person would type it, add it to [`CHEAT_SHEET.md`](CHEAT_SHEET.md). That
   file says the CLI is right when the two disagree, so a missing line there is
   only a gap, but it is the page people read.

### Adding a preflight check

A check exports `id`, `blocking` and `run` (and `needsBody` if it reads the PR
body), and returns `pass`, `skip`, `warn`
or `fail` with a summary and a remedy. Whether it blocks is the check's own
export, not the caller's choice. Add a row to the table in
[section 7](docs/specification/07-preflight.md) and to the preflight table in
[`CHEAT_SHEET.md`](CHEAT_SHEET.md), and correct the count in both.

- **A skip is never a pass.** If the check could not run, say so and say why. A
  check reporting success where it checked nothing devalues the whole gate.
- **If it reads the PR body, export `needsBody = true`** and add its id to
  `BODY_DEPENDENT`, which `test/preflight.test.js` holds equal to the checks
  that export it. Otherwise it stays forever at its first-pass result, which is
  `skip` — and that looks like a check that ran. When the body is what it
  lacks, return `skipForBody` from `lib/preflight/index.js` rather than writing
  the skip by hand: its `waitingFor: 'body'` is what the note after pass one
  counts, and the summary's wording is not.
- **The message must not be wider than the measurement.** Three separate defects
  in this repository were the same shape: a failure that asserted more about the
  input than the check had looked at. Say what you measured.

### Adding a state or a transition

`lib/state.js` is the **only** writer of `state.json` (invariant 1), and
`test/invariants.test.js` enforces that by refusing to let any other module name
the file. If a transition needs a fact from elsewhere, pass the fact in; do not
add a second writer.

Ask whether the new state is terminal, and be suspicious of yes. `answered`
looked terminal and was not: at the moment it is entered, the work is waiting on
somebody, and a terminal state cannot wait.

### Adding a skill or an agent

Orchestrating skills carry `disable-model-invocation: true` — nothing in this
plugin starts on its own. Phrase-triggered skills (`package-map`,
`upstream-rules`, `worktree-kit`) omit it deliberately.

The model is set by `model:` in frontmatter and nowhere else. There is no config
key for it, because a skill's own model can only be set in frontmatter, and a
lever that controls the subagents but not the skill is worse than no lever.

Moving a skill or an agent down to Sonnet comes with one sentence in the
CHANGELOG saying what in that phase a machine decides rather than the model.
Without it the move is a bet, and nobody will remember why it was made.

**Known limitation: a skill's `model:` holds for one turn.** Claude Code applies
it until the end of the turn the skill was invoked in, and a turn ends at any
incoming user-role message — a person's reply, and also the hand-back of a
background subagent. After that the session's own model resumes (observed on
Claude Code 2.1.273 through 2.1.301). So a skill that
waits for a person or for a background agent (`exec`, `validate`, `preflight`,
`slice`, `pr`, `pr-sync`) runs most of its phase on whatever the session is set
to. An agent's `model:` has no such limit: every call runs on it. Skill `effort:`
is documented with the same "while the skill is active" wording and should be
assumed to end at the same place. Do not work around this with a config key; the
remedy is `/model` at the start of the phase's session.

## Testing

```bash
npm test                                       # everything, ~45 s
node --test test/slice.test.js                 # one file
node --test --test-name-pattern "digest"       # one case, by name
```

Tests are `node --test`, zero dependencies, one file per module whose contract
holds something up. They run against the real `templates/` and `defaults/`
directories rather than fixtures, so a placeholder renamed in a template without
its caller being updated fails here.

**What a test in this repository is for.** The suite has never caught the
interesting bugs — every finding listed at the bottom of the changelog came from
running the thing against live upstream. What the suite does is stop those
findings coming back, and hold the invariants that have no runtime symptom. Write
the test that would have failed, and say in a comment what it is protecting.

Two checks the suite cannot replace, both required before you send a change:

```bash
pdkit doctor --gate-selftest --repo <a real podman-desktop fork>
```

This drives every forbidden command through the hook **the manifest registers**,
launching it the way Claude Code does. Every unit test stays green while a plugin
whose manifest did not load gates nothing at all. Run it after any change under
`lib/hooks/`, to `hooks/hooks.json`, or to `bin/pdkit`.

```bash
claude plugin validate . --strict
```

Catches a misspelled manifest field before anybody installs it.

## Licence headers

Every `.js` file and every YAML file carries the podman-desktop house header —
the Apache block with the copyright line and the SPDX identifier **inside** it,
not a bare `// SPDX-License-Identifier` line. `test/invariants.test.js` states the
block in full and checks every module against it.

This is not pedantry about our own files: `knowledge/upstream-rules.md` tells
contributors that upstream rejects the bare form, and `lib/preflight/checks/spdx.js`
fails a pull request that ships one. A tool that does not follow the rule it
enforces is a tool a reviewer discounts.

`bin/pdkit` carries the header **after** the shebang. The other order leaves a
file the kernel will not execute.

## Commits and pull requests

- **Conventional commits**: `type(scope): subject`. The scope is optional but
  worth writing — it tells a reviewer which area they are being asked about.
- **One `Signed-off-by` trailer per commit.** If you need to squash, use
  `git reset --soft <base> && git commit`, never `git rebase -i`.
- **Say why, not what.** The diff already says what. The commit messages in this
  repository are long because the reasoning is the part that does not survive in
  code, and the same applies to a pull request body.
- **Update `CHANGELOG.md`** under `## [Unreleased]` when the change is something a
  user would notice. `test/release.test.js` keeps that section present. If the
  user has to do anything about it, say what under `### Upgrading` — see
  [RELEASING.md](RELEASING.md).
- **Keep the status honest.** A change that makes something run for the first
  time against live upstream moves a row in
  [section 13](docs/specification/13-status.md), with the journal entry or
  artefact that proves it, and the summary in the README with it.
- Run `npm test` and, for anything touching hooks, the gate self-test. Say in the
  pull request what you ran.

## When you find that nothing owns something

This has happened once per stage, always somewhere new: an entity existed in the
design with no module responsible for it. The symptom is always the same — a
question you cannot answer without inventing a second place to store the answer.

The right move is a module that owns the record, with a single writer. The wrong
moves, both tried: a second writer for `state.json`, and a new state file for one
integer. When the fact is already in the append-only journal, derive it instead —
that is what `lib/attempts.js` does.
