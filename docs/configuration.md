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

That has a cost worth knowing about. A list `init` copied verbatim and you never
edited stays at the value shipped that day, so a later change to the default
never reaches you — silently, because the pinned value is still perfectly valid.
`doctor` reports it as `config:arrays`. Delete the key to follow the default
again, or extend it deliberately.

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

### What each key does

| Key | Effect |
|---|---|
| `repo.upstream`, `repo.fork` | Checked against the git remotes by `init` and `doctor` |
| `repo.upstream_remote`, `repo.fork_remote` | Which remote names carry them |
| `repo.path` | Optional. Work on this repository regardless of the working directory |
| `state.root` | Where `$PDKIT_HOME` lives, unless the environment says otherwise |
| `branches.single`, `branches.sliced` | Branch name templates; `{issue}`, `{index}`, `{slug}` |
| `slicing.layer_order` | Merge order for slices, and the layer each package is filed under. A package no entry claims is reported by `doctor` rather than filed under the nearest match |
| `slicing.strategy` | `prefer-independent` by default. A stack is fragile — after #1 merges, #2 needs its base switched and its threads point at moved lines |
| `slicing.max_files_per_slice` | A warning threshold, not a refusal. Size is a conversation |
| `slicing.verify.worktree` | `reuse` keeps one tree per issue, so `node_modules` survives between runs; `ephemeral` rebuilds it every time and pays a full install per slice |
| `slicing.verify.install` | `on-lockfile-change` (default), `always`, or `never`. The marker recording which lockfile is installed lives inside `node_modules`, so wiping one wipes the other |
| `worktrees.root` | Where trees go. Beside the fork, never inside it: a checkout under the repository shows up in `git status` and eventually in a pull request |
| `worktrees.copy_files` | Copied into every new tree, and again after each verification reset — `git clean` takes them |
| `quickfix.max_changed_lines`, `quickfix.max_files` | Thresholds above which a quickfix escalates back to triage |
| `gates.push_ttl` | How fast consent goes stale. Which states a token may be issued from is not configurable — see `state.GATE_ELIGIBLE` |
| `validation.e2e` | `prefer`, `required` or `off`. The per-issue decision is made at planning, in the plan's `e2e coverage` field |
| `validation.e2e_stability_runs` | Consecutive green runs a new e2e test needs. The series is tied to a digest of the spec, so editing the test afterwards fails preflight rather than passing on stale runs |
| `validation.require_evidence` | When false, `validation-evidence` skips. It exists for a repository where the application cannot be driven at all, not as a way past a step you would rather not demonstrate |
| `validation.app.binary` | A packaged application to drive. Empty by default: `PODMAN_DESKTOP_BINARY` comes next, then `node_modules/.bin/electron .` — the development build, which is what upstream's own e2e drives |
| `validation.app.debug_port` | Where CDP listens. `validate launch` refuses a port something else already answers on rather than fighting it |
| `validation.app.startup_timeout` | How long to wait for `/json/version`. A process that dies before then is reported at once, not after the timeout |

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

**Playwright attaches to an application pdkit started.** Configure the server
with `--cdp-endpoint`; `pdkit validate launch` spawns the build with
`--remote-debugging-port`, waits for `/json/version` and prints the endpoint.
That is the shape upstream's own runner uses
(`tests/playwright/src/runner/chrome-dev-tools-protocol-runner.ts`), which is
also the answer to whether an Electron podman-desktop can be driven at all: it
has been, in their CI, all along.

"No Playwright" and "nothing to point Playwright at" are different problems.
`doctor` reports the second separately, as `validate:app` — a perfectly
configured server still has nothing to drive if the tree was never built.

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
never reach rtk at all — see "What actually protects receipts" below.

### What it saves, measured

Worth knowing before you spend an evening on it. Measured on rtk 0.44.0 against
this project's own repositories, in bytes of output:

| Command | raw | via rtk | saved |
|---|---|---|---|
| `git status` (large repo) | 351 | 111 | 68% |
| `ls -la` | 5073 | 1796 | 65% |
| `rg -n <pattern> lib/` | 24040 | 13564 | 44% |
| `git diff HEAD~1 HEAD` | 2320 | 1901 | 18% |
| `git diff --stat` | 1468 | 1467 | 0% |
| `git log --oneline -20` | 1416 | 1416 | 0% |
| `cat` → `rtk read` | 29902 | 29902 | 0% |

rtk's own counter across that sample: 6.5% overall.

And the ones it does not rewrite at all: `pnpm test`, `pnpm typecheck`,
`npm test`, `node --test`, `node bin/pdkit …`. Check any command yourself with
`rtk hook check "<command>"`.

So the savings are real and they are in navigation — `ls`, `git status`, `rg`.
They are not in test output, which is where the bulk of a long session's bash
traffic tends to be. Percentages, not multiples.

### Setting it up

rtk installs its own hook, globally, and patches `~/.claude/settings.json`.
The plugin does not do this for you, and `/pd:doctor` only reports what it
finds:

```bash
rtk init -g          # installs ~/.claude/hooks/rtk-rewrite.sh, prompts before patching
rtk init --show      # what is installed
```

**Do not skip that first line.** rtk installed with no hook answers
`rtk --version` perfectly and rewrites nothing: no compression, no savings, no
error message. `/pd:doctor` reports this as `rtk:hook` and it is the most likely
thing to be wrong.

Then exclude the commands the plugin needs to see unrewritten. **Put them in the
file `rtk config` names on its first line** — that is `~/Library/Application
Support/rtk/config.toml` on macOS, and `~/.config/rtk/config.toml` is *not* read
there:

```bash
rtk config           # first line is the path; the rest is what rtk has in effect
```

```toml
[hooks]
exclude_commands = [
  "git push", "git commit", "git reset", "git rebase", "git cherry-pick",
  "gh pr", "gh issue", "gh api",
]
```

That list is `tools.rtk.never_rewrite` from the plugin config. `/pd:doctor`
compares it against what `rtk config` reports as effective, rather than against
a file at a path the plugin guessed — guessing that path is how every one of
these commands came to be rewritten while the check reported them excluded.

### What actually protects receipts

The exclusion list **narrows the surface; it is not what holds.**

What holds for the gate is that it parses the command it is given, `rtk git push`
included, and `/pd:doctor --gate-selftest` probes exactly that form.

What holds for receipts is the spawn. `lib/evidence.js` starts the process
itself, from Node, so a rewriter that works by hooking the `Bash` tool is never
consulted. `RTK_DISABLED=1` is also set on every capture, but do not rely on it:
rtk 0.44.0 ignores it on every path there is — direct invocation, `rtk hook
claude`, and `rtk hook check` all behave identically with it and without. It is
kept as a second lock and because a future version would read it.
