# Configuration

## Layers

```
defaults/config.yaml        shipped with the plugin
  ↓ overridden by
$PDKIT_HOME/config.yaml     your settings
  ↓ overridden by
<repo>/.pdkit.yaml          per-repository
```

Put `.pdkit.yaml` in `.git/info/exclude`, **not** `.gitignore`. The fork's
`.gitignore` is upstream's file; editing it puts a stray line in every pull
request you open.

Maps merge key by key, so overriding `slicing.max_files_per_slice` leaves
`slicing.strategy` alone. **Lists are replaced whole**, never merged: a
`never_rewrite` or `layer_order` assembled from two halves is a list nobody
wrote, and both decide whether a command runs and in what order slices merge.

### The YAML subset

`lib/yaml.js` reads nested maps, block and inline sequences, scalars, quotes
and comments. It refuses anchors, multiline scalars (`|`, `>`), tags and
multi-document files with the line number. This is deliberate: a reader that
skipped a construct it did not understand would hand you a config that looks
loaded and is missing a key, and the loss would surface later as a wrong
decision somewhere unrelated.

One departure from YAML 1.1: `on` and `off` stay strings, because the config
uses them as enum members next to `auto` (`tools.rtk.enabled: auto | on | off`).

## `$PDKIT_HOME`

Defaults to `~/.pdkit/podman-desktop`. Holds config, the package map, gate
tokens, per-issue state and artefacts, the journal, and review reports.

Resolution order:

1. the `PDKIT_HOME` environment variable
2. `state.root` in `<repo>/.pdkit.yaml`
3. `state.root` in `defaults/config.yaml`

`$PDKIT_HOME/config.yaml` deliberately has no say in where `$PDKIT_HOME` is — a
file cannot be consulted about its own location.

Keeping it in its own private git repository is worthwhile — `pdkit` commits
after each state transition, so losing the directory loses the reasoning behind
every decision. It must be a **separate** repository, never the fork.

### Creating it

```bash
cd /path/to/your/podman-desktop/fork
pdkit init          # creates the directory, copies the config, builds the map
pdkit doctor        # says what is missing and what degrades because of it
```

`init` refuses a repository whose remotes do not match `repo.upstream` and
`repo.fork` unless you pass `--force`. Initializing against the wrong clone
writes a package map for a workspace nothing else will act on, and every later
command inherits it.

The config is **copied** from `defaults/config.yaml` rather than generated, so
the comments explaining each decision come with it. An existing file is kept;
`--force` overwrites it.

### What each key does

| Key | Effect |
|---|---|
| `repo.upstream`, `repo.fork` | Checked against the git remotes by `init` and `doctor` |
| `repo.upstream_remote`, `repo.fork_remote` | Which remote names carry them |
| `repo.path` | Optional. Work on this repository regardless of the working directory |
| `state.root` | Where `$PDKIT_HOME` lives, unless the environment says otherwise |
| `branches.single`, `branches.sliced` | Branch name templates; `{issue}`, `{index}`, `{slug}` |
| `slicing.layer_order` | Merge order for slices, and the layer each package is filed under. A package no entry claims is reported by `doctor` rather than filed under the nearest match |
| `quickfix.max_changed_lines`, `quickfix.max_files` | Thresholds above which a quickfix escalates back to triage |
| `gates.push_ttl`, `gates.require_states` | When a push gate may be issued at all |

### The package map

`init` generates `package-map.json` from `pnpm-workspace.yaml`, so it cannot
drift from the workspace. Regenerate it whenever the workspace file changes —
`doctor` warns when the map is older.

```bash
pdkit packages                                   # everything, grouped by layer
pdkit packages --of packages/main/src/index.ts   # which package owns a path
```

## Model selection

Not in this file. Models are set by `model:` in `skills/*/SKILL.md` and
`agents/*.md`.

This is deliberate: a skill's own model can only be set in its frontmatter, so a
config key would control the subagents and not the skill — a lever that half
works is worse than no lever. To cut cost, edit the frontmatter of `plan`,
`slice` and `audit`, and leave the rest on Sonnet.

## MCP servers

The plugin ships **no** `.mcp.json`, and that is the point: a plugin-level MCP
declaration loads for everyone who enables the plugin, which would make optional
servers mandatory. Configure them yourself.

| Server | Used by | Absent |
|---|---|---|
| Playwright | `/pd:validate` | a human checklist instead of evidence, and no PASS is recorded |
| context7 | dependency bumps | changelog lookups fall back to grep |
| ponytail | `pd-plan-critic`, `pd-review-architecture` | the checklist in `knowledge/review-expectations.md` |

Which agents can see a server's tools is controlled by `tools:` in
`agents/*.md`, since plugin agents cannot declare MCP servers themselves.

**Do not install ponytail as a `SessionStart` hook.** A hook reaches every
agent and bypasses `tools:` scoping entirely, including `pd-implementer`, which
must follow the plan literally rather than minimize it. `/pd:doctor` warns when
it finds such a hook.

## rtk

If you use rtk, order matters: **set up the gate first, then enable rtk.** rtk
rewrites commands before execution, and the gate decides from the parsed
command. `lib/hooks/command-parse.js` canonicalizes wrapped forms, and
`test/command-parse.test.js` covers them — but verify with
`/pd:doctor --gate-selftest` before trusting the combination.

Keep `tools.rtk.readonly_only: true`. Commands whose output becomes a receipt
run with rtk disabled: a compressed test log is a claim, not evidence, and
receipts exist precisely to be more than claims.

### Setting it up

rtk installs its own hook, globally, and patches `~/.claude/settings.json`.
The plugin does not do this for you, and `/pd:doctor` only reports what it
finds:

```bash
rtk init -g          # installs ~/.claude/hooks/rtk-rewrite.sh, prompts before patching
rtk init --show      # what is installed
```

Then exclude the commands the plugin needs to see unrewritten, in
`~/.config/rtk/config.toml`:

```toml
[hooks]
exclude_commands = [
  "git push", "git commit", "git reset", "git rebase", "git cherry-pick",
  "gh pr", "gh issue", "gh api",
]
```

That list is `tools.rtk.never_rewrite` from the plugin config, and
`/pd:doctor` warns about any entry missing from the TOML. It matches the file
as text rather than parsing it — enough for a warning, and a second parser in
a zero-dependency project would not be.

Two things worth being clear about. The exclusion list **narrows the surface;
it is not what holds.** What holds is that the gate parses the command it is
given, `rtk git push` included, and `/pd:doctor --gate-selftest` probes exactly
that form. And receipts bypass rtk through `RTK_DISABLED=1`, set by
`lib/evidence.js` on every capture — the variable name is rtk's own, confirmed
against its documentation, because a bypass with a misspelled variable does
nothing and does it silently.
