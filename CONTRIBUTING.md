# Contributing to podman-desktop-kit

This is a plugin for working on **somebody else's** repository, and most of its
design follows from that. Before changing anything, it is worth reading
[`docs/specification.md`](docs/specification.md) — at least section 2.2, which
lists the five invariants a change must not break, and section 6, which explains
why some rules are hooks rather than instructions.

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
| a `pdkit` command | `lib/cli.js` (dispatch + usage) and the module that does the work | the module's own `test/<module>.test.js` |
| a deterministic rule | the owning module in `lib/` | same |
| a hook's behaviour | `lib/hooks/<handler>.js`; the deny rules are data in `lib/hooks/rules.js` | `test/rules.test.js`, `test/dispatch.test.js`, and **`pdkit doctor --gate-selftest`** |
| a preflight check | one file under `lib/preflight/checks/`, registered in `lib/preflight/index.js` | `test/preflight.test.js` |
| an artefact's shape | `templates/*.md`, registered in `lib/render.js` | `test/render.test.js` |
| what a skill does | `skills/<name>/SKILL.md` | `test/invariants.test.js` checks every `pdkit` command a skill names exists |
| what an agent does | `agents/pd-<name>.md` | — |
| the shipped knowledge base | `knowledge/*.md` | `pdkit knowledge check` |

### Adding a `pdkit` command

1. Implement it in the module that owns the data. If no module owns it, that is
   the finding — see below.
2. Add it to `COMMANDS` and to the `switch` in `lib/cli.js`, and write the usage
   line. `test/invariants.test.js` asserts the dispatcher and the exported list
   agree, in both directions.
3. Document the flags in the usage text. A flag that exists in code and not in
   `--help` is a flag nobody uses — that happened to `close --confirmed`.

### Adding a preflight check

A check returns `pass`, `skip` or `fail` with a summary and a remedy.

- **A skip is never a pass.** If the check could not run, say so and say why. A
  check reporting success where it checked nothing devalues the whole gate.
- **If it reads the PR body, list it in `BODY_DEPENDENT`.** Otherwise it stays
  forever at its first-pass result, which is `skip` — and that looks like a check
  that ran.
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
  user would notice. `test/release.test.js` keeps that section present.
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
