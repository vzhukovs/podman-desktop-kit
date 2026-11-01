# podman-desktop-kit

A Claude Code plugin (`pd`) for working upstream issues in podman-desktop.
Zero-dependency ESM on Node >= 22, no build: `lib/` is what runs. The plugin
works on **somebody else's** repository, and most rules below follow from that.

Read before changing anything: [`CONTRIBUTING.md`](../CONTRIBUTING.md) (where code
goes, how to add a command, check, state, skill or agent) and
[section 2.2 of the specification](../docs/specification/02-plugin-structure.md#22-state-outside-the-repository)
(the invariants a change must not break). This file does not repeat them; it
lists what has gone wrong more than once.

## Commands

```bash
npm test                                                                  # whole suite
node --import ./test/helpers/isolate-home.js --test test/<module>.test.js # one file
claude plugin validate . --strict                                         # manifest
pdkit doctor --gate-selftest --repo <podman-desktop fork>                 # after lib/hooks/, hooks/hooks.json, bin/pdkit
```

Never run a test without `--import ./test/helpers/isolate-home.js`: without it a
run writes into the live `$PDKIT_HOME` journal.

## Anonymity in everything that ships

Skills, agents, `knowledge/`, `templates/`, `docs/`, the root `*.md` files and
test fixtures are published to everyone who installs the plugin. None of them
may carry:

- real GitHub logins or names — use `maintainer1`, `reviewer2`,
  `contributor3`…, the same placeholder for the same person across a file
  (bot and service accounts may stay where a test is about them);
- real branch names, worktree names or paths, local absolute paths
  (`/Users/...`), or anything else copied from one machine or one session;
- in prompts and knowledge: issue or PR numbers, and the incident behind a rule.

Rephrase, don't redact: state the **situation** and the rule it led to, so the
lesson stays and the reference goes. "A reviewer asked for X on a PR touching Y"
— not who, not which PR. This applies to text drawn from a live run, an issue
or a review thread as much as to text you write.

## SOLID: the structure is deliberate

0.11.4 and 0.11.5 were spent bringing `lib/` to SOLID. Keep it there; do not
reintroduce what was removed.

- **One responsibility per module**, stated in its header comment. A new
  concern is a new module with a single owner, not a branch in an existing one.
- **Extend by adding a row, not editing a chain**: a command is a file in
  `lib/commands/` plus a `REGISTRY` row; an action is a function plus an
  `ACTIONS` row plus a `USAGE` line; a state entry rule is an element of
  `ENTRY_RULES` in `lib/state/entry.js`; a preflight check is a file plus a
  `CHECK_IDS` entry; a template is a file plus a `TEMPLATES` row. No new
  `if (action === ...)` chains.
- **One way in to each external thing**: git only through `lib/git.js`, gh only
  through `lib/gh.js`, each with an `options.exec` seam for tests. `state.json`
  is written only by `lib/state.js`, `slices.json` only by `lib/slice.js`.
- **Facades are the API**: outside its package, nothing imports `lib/slice/*`,
  `lib/validation/*` or `lib/state/*`; a submodule never imports its facade;
  preflight checks never import `lib/preflight/index.js`. A facade's `deps`
  holds only access to the file it owns, never a pure function.
- **Modules return data**; only `lib/cli.js` and `lib/commands/*` write to
  stdout or stderr. `lib/commands/support.js` holds what two commands share and
  no domain logic.
- **No new import cycles.** The three runtime `await import()` cycles in
  `lib/state.js` are documented and the only ones allowed.

`test/invariants.test.js` enforces most of this; a failure there is the design
talking, not a test to adjust. SOLID is not a license to split: size alone is
not a finding, and a long function that is one ordered scenario stays whole.
Do not reopen a split the round-2 review rejected without new facts.

## Other recurring mistakes

- **Collect facts, reach no verdict.** What must be *true* goes in `lib/` with a
  test; what needs *judgement* goes in `skills/` or `agents/`. No `score` or
  `recommendation` fields in `lib/`.
- **Plugin files from prompts go through `${CLAUDE_PLUGIN_ROOT}/`.** Skills and
  subagents run in the podman-desktop checkout, so a bare `knowledge/x.md`
  resolves against the wrong repository.
- **A skip is never a pass**, and a message is never wider than what was
  measured.
- **Comments say why, and must stay true.** When code moves, update or remove
  comments that name the old place.
- **`docs/` is one file per section**, with stable numbers; a new section is a
  new numbered file linked from its `README.md` and its neighbours' footers.
- **American spelling everywhere** — prose, comments, identifiers, test
  names: `license`, `behavior`, `color`, `initialize`, `judgment`. Three
  exceptions are data, not prose, and stay as they are: the `'cancelled'` CI
  verdict (and GitHub's own `CANCELLED`), the `normalised` key in the cost
  report and its snapshots, and `artefact`, which awaits a rename of its own.
- **Every `.js` and YAML file carries the full Apache header** with SPDX inside
  it (after the shebang in `bin/pdkit`).

## Commits and releases

- Conventional commits, `type(scope): subject`; the body says why.
- User-visible change → `CHANGELOG.md` under `## [Unreleased]`.
- Squash with `git reset --soft <base> && git commit`, never `git rebase -i`.
- Release only per [`RELEASING.md`](../RELEASING.md): push the release commit,
  wait for CI to be green on every OS, only then tag and publish.
