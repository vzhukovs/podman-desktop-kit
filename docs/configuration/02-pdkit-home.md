# `$PDKIT_HOME`

[Configuration](README.md) › 2 of 8

Defaults to `~/.pdkit/podman-desktop`. Holds config, the package map, gate
tokens, per-issue state and artefacts, the journal, review reports, and the
snapshots `pdkit cost --snapshot` writes to `cost/`.

`pdkit cost` also reads outside it: Claude Code's transcripts, under
`$CLAUDE_CONFIG_DIR/projects/` (or `~/.claude/projects/`) in the directory named
after the repository's path. `--transcripts <dir>` overrides that. Without
transcripts the command reports a skip, not zeros.

Resolution order:

1. the `PDKIT_HOME` environment variable
2. `state.root` in `<repo>/.pdkit.yaml`
3. `state.root` in `defaults/config.yaml`

`$PDKIT_HOME/config.yaml` deliberately has no say in where `$PDKIT_HOME` is — a
file cannot be consulted about its own location.

Keeping it in its own private git repository is worthwhile — `pdkit` commits
after each state transition, so losing the directory loses the reasoning behind
every decision. It must be a **separate** repository, never the fork.

## Creating it

```bash
cd /path/to/your/podman-desktop/fork
pdkit init          # creates the directory, copies the config, builds the map
pdkit doctor        # says what is missing and what degrades because of it
```

**One clone, two remotes — not two clones.** The upstream repository is never
checked out separately; diffs against `main` come from `upstream/main` in the
same clone. So the requirement is:

```
origin    git@github.com:<you>/podman-desktop.git       your fork
upstream  https://github.com/podman-desktop/podman-desktop.git
```

**`repo.fork` is not something you type.** It ships empty, because a config file
that ships to everyone cannot know whose fork you cloned, and `init` reads it
from the `origin` remote and writes it into `$PDKIT_HOME/config.yaml`:

```
  fork        : jdoe/podman-desktop (read from the "origin" remote)
```

That file, rather than a `.pdkit.yaml` in the checkout, is deliberate: worktrees
are separate directories and an untracked file in the main checkout is not in
any of them, so a fork configured there would silently revert to the default in
every issue worktree — where the work actually happens.

Two ways this can go wrong, both refused rather than guessed:

- **No `origin`.** Nothing to read; add the remote or set `repo.fork` by hand.
- **`origin` is upstream itself.** You cloned the project rather than a fork.
  Adopting it would aim every push at podman-desktop, and the consent gate would
  be guarding a branch in somebody else's repository.

`init` still refuses a repository whose remotes *disagree* with a fork slug that
is already set, unless you pass `--force`. A key with no value is what init is
for; a key with the wrong value means the map would be built for a workspace
nothing else will act on, and every later command would inherit it.

The config is **copied** from `defaults/config.yaml` rather than generated, so
the comments explaining each decision come with it. An existing file is kept;
`--force` overwrites it.

One consequence of copying the whole file: a default the plugin changes later is
shadowed by your copy, and it looks exactly like a setting you chose. That is
how `slicing.layer_order` stayed at its stage-0 value after the plugin extended
it. Where it matters, `doctor` names the file that decides a key —

```
! package-map:layers  no layer claims @podman-desktop/core-api, … — extend
                      slicing.layer_order in ~/.pdkit/podman-desktop/config.yaml
                      and re-run `pdkit init`
```

— so the fix is to edit that key in your own file, or delete it there and let
the shipped default through.

---

**The design** — [2.2 · State, outside the repository](../specification/02-plugin-structure.md#22-state-outside-the-repository), [architecture · The constraint](../architecture/01-constraint.md), [workflows · Where the state lives](../workflows/reference/state.md)

← [Layers](01-layers.md) · [Contents](README.md) · [What each key does](03-keys.md) →
