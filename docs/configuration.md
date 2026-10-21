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
uses them as enum members next to `auto` (`mcp.playwright: auto | on | off`).

## `$PDKIT_HOME`

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

### Creating it

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

### What each key does

| Key | Effect |
|---|---|
| `repo.upstream` | Checked against the git remotes by `init` and `doctor` |
| `repo.fork` | The same, but ships empty and is filled by `init` from the `fork_remote` URL. Set it by hand only to override what the clone says |
| `repo.upstream_remote`, `repo.fork_remote` | Which remote names carry them |
| `repo.path` | Optional. Work on this repository regardless of the working directory |
| `state.root` | Where `$PDKIT_HOME` lives, unless the environment says otherwise |
| `branches.single`, `branches.sliced` | Branch name templates; `{issue}`, `{index}`, `{slug}` |
| `slicing.layer_order` | Merge order for slices, and the layer each package is filed under. A package no entry claims is reported by `doctor` rather than filed under the nearest match |
| `slicing.strategy` | `prefer-independent` by default. A stack is fragile — after #1 merges, #2 needs its base switched and its threads point at moved lines |
| `slicing.max_files_per_slice` | A warning threshold, not a refusal. Size is a conversation |
| `slicing.verify.worktree` | `reuse` keeps one tree per issue, so `node_modules` survives between runs; `ephemeral` rebuilds it every time and pays a full install per slice |
| `slicing.verify.install` | `on-lockfile-change` (default), `always`, or `never`. The marker recording which lockfile is installed lives inside `node_modules`, so wiping one wipes the other |
| `slicing.verify.prepare` | Build scripts run after every clean, before anything is checked. **The list to look at when every slice comes back inconclusive.** The tree is reset to what git holds on each run, so a package resolving through a `dist/` that is not committed is simply absent there — and a typecheck that consumes it without building it reports hundreds of errors in files no slice touched. podman-desktop needs `build:core-api` and `build:ui`, both found that way, one live run apart. Names the repository does not define are skipped, so the list costs nothing where it does not apply |
| `worktrees.root` | Where trees go. Beside the fork, never inside it: a checkout under the repository shows up in `git status` and eventually in a pull request |
| `editor.path` | The IDE `pdkit editor` opens a worktree in. Empty by default. **Read from `$PDKIT_HOME/config.yaml` only**: it names a program pdkit runs, so a repository's `.pdkit.yaml` that sets it, or that moves `state.root` (and with it the `config.yaml` read), is refused — a pull request under review decides what its tree holds. An absolute path: a bare name such as `code` is refused, since Windows searches the working directory first. A macOS `.app` goes through `open -a`; on Windows only an `.exe` — not `code.cmd`, which runs through `cmd.exe` (use `Code.exe`); anything else is run with the tree as its only argument, without a shell, from the home directory. A program every user can write is refused. Single-quote Windows paths: a backslash inside double quotes is an escape. Unset, `pdkit editor` exits 1 and prints the lines to add |
| `worktrees.copy_files` | Copied into every new tree, and again after each verification reset — `git clean` takes them |
| `triage.fetch_comments` | How many comments `issue fetch` prints, newest first; the rest are counted and `--full` prints them. The body is always printed whole and has no setting |
| `quickfix.max_changed_lines`, `quickfix.max_files` | Thresholds above which a quickfix escalates back to triage |
| `gates.push_ttl` | How fast consent goes stale. Which states a token may be issued from is not configurable — see `state.GATE_ELIGIBLE` |
| `validation.e2e` | `prefer`, `required` or `off`. The per-issue decision is made at planning, in the plan's `e2e coverage` field |
| `validation.e2e_stability_runs` | Consecutive green runs a new e2e test needs. The series is tied to a digest of the spec, so editing the test afterwards fails preflight rather than passing on stale runs |
| `validation.require_evidence` | When false, `validation-evidence` skips. It exists for a repository where the application cannot be driven at all, not as a way past a step you would rather not demonstrate |
| `validation.app.binary` | A packaged application to drive. Empty by default: `PODMAN_DESKTOP_BINARY` comes next, then `node_modules/.bin/electron .` — the development build, which is what upstream's own e2e drives. **Read from `$PDKIT_HOME/config.yaml` only**, with `validation.app.args`, for the reason `editor.path` is: a `.pdkit.yaml` that sets either, or moves `state.root`, is refused. It and `PODMAN_DESKTOP_BINARY` must be absolute, an `.exe` on Windows, and not writable by every user |
| `validation.app.debug_port` | Where CDP listens. `validate launch` refuses a port something else already answers on rather than fighting it |
| `validation.app.startup_timeout` | How long to wait for `/json/version`. A process that dies before then is reported at once, not after the timeout |
| `preflight.scripts.*` | Overrides for script-name resolution. **Empty by default**, and it should stay that way: names are resolved from the repository's own `package.json`, which is the right source. Filling one in is worth doing exactly when the resolver got it wrong — which is a reason to fix the resolver |
| `exec.max_attempts` | How many failed captures of `Done when` block a task. Three by default; zero switches blocking off entirely. It can only weaken the rule, never tighten it — the count itself comes from the captures, not from anyone's account of them |
| `budget.turns.*` | A soft ceiling per phase, in turns: `triage`, `plan`, `exec_per_task`, `validate`, `audit`, `slice`, `pr`, `pr_sync`. Nothing refuses at it, and nothing could — no command sees how many turns a session has taken. The `SessionStart` summary prints the one for the phase it opens, and the skill names it when it suggests stopping and restarting. Context is re-read whole on every call, so a phase twice as long costs about four times as much |
| `review.stale_after_days` | When an open pull request is reported as idle |
| `review.bots_collapsed` | Accounts collapsed to one line in `pr threads`. Collapsed, never dropped |
| `review.bot_escalate` | Words that expand a collapsed bot back to full text. One direction only: a match raises a thread and never lowers one |
| `journal.reanchor_scope` | How much of the journal `SessionStart` injects. `issue` by default, because the whole file starts eating context within a month |
| `languages.*` | The language each artefact is written in. The review report is the one worth setting: it is read by you, not by upstream |

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
works is worse than no lever. Opus is kept where no machine re-checks the
verdict: `triage`, `plan`, `plan-review`, `pr-sync` and the agents
`pd-auditor`, `pd-plan-critic`, `pd-review-synth`. The rest is Sonnet.
`pr-sync` came back to Opus in 0.9.0: a machine checks that a review fix
compiles and passes, not which of a reviewer's alternatives to take, nor
whether a reply answers what was asked. Its resolvers stay on Sonnet — they
carry out a decision the person has already approved.

A skill's `model:` and `effort:` hold only until the end of the turn it was
invoked in (see CONTRIBUTING.md). After the first reply from you or from a
background agent, the session's own model and effort level take over. Two
settings outside this repository therefore decide most of what a phase costs,
and they are yours to change, not the plugin's:

- **The model.** Start each phase in its own session (`pdkit next <n>` prints
  the command) and pick the model there: `/model opus` before `triage`, `plan`,
  `plan-review` and `pr-sync`; `/model sonnet` before the rest.

  `pdkit init` also writes `"model"` into the fork's
  `.claude/settings.local.json`, so a fresh `claude` there starts on the model
  most orchestrating skills declare (today `sonnet`) instead of your global one.
  The value is counted from the skills' `model:` frontmatter, not set by the
  plugin, and project settings win over `~/.claude/settings.json`. Only the
  local file is written: `.claude/settings.json` belongs to podman-desktop and
  is tracked by git. Existing keys are kept; a `model` already there is left
  alone unless you pass `--force`. `pdkit doctor` warns (`settings:model`) when
  the written value no longer matches the frontmatter — a skill moved to
  another model after init ran — or when there is none.
- **The effort level.** A global `"effortLevel": "xhigh"` in
  `~/.claude/settings.json` applies to every turn the skill's own `effort:` no
  longer covers — including `pdkit state <n>` and the other mechanical turns of
  `exec`, `preflight`, `slice` and `pr`. Reasoning tokens are paid as
  output, and output is the dearest token there is. Recommended: leave
  `effortLevel` unset or at `medium`, and raise it with `/effort high` in the
  sessions for `triage`, `plan`, `plan-review` and `pr-sync`. `pdkit init` does not write
  `effortLevel` into the fork's settings: nothing confirms Claude Code reads it
  at project level, and an unknown key is accepted without a word. Set the
  level per session with `/effort`, or `claude --effort` at launch.
  `CLAUDE_CODE_EFFORT_LEVEL` overrides even the skill's `effort:`, so do not set
  it globally either.

## MCP servers

The plugin ships **no** `.mcp.json`, and that is the point: a plugin-level MCP
declaration loads for everyone who enables the plugin, which would make optional
servers mandatory. Configure them yourself.

| Server | Used by | Absent |
|---|---|---|
| Playwright | `/pd:validate` | a human checklist instead of evidence, and no PASS is recorded |
| context7 | questions about someone else's library, in planning and in review | the answer comes from the model's own knowledge of that library's versions, which goes out of date without saying so |

Which agents can see a server's tools is controlled by `tools:` in
`agents/*.md`, since plugin agents cannot declare MCP servers themselves.

### Playwright: the one command to run by hand

The plugin cannot do this for you — no `.mcp.json` ships with it, deliberately,
because a plugin-level declaration loads for everyone. Run it once per machine:

```bash
claude mcp add playwright -s user -- \
  npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222
```

**`-s user` is the part worth getting right.** Without it `claude mcp add` uses
local scope, which is keyed by the exact directory you ran it in. Every issue
worktree is a different directory, and so is the fork root versus its parent —
so a server added locally is invisible from the session that needs it, while
`claude mcp list` in the directory you added it from shows it perfectly.

**The port is a constant on purpose.** It matches `validation.app.debug_port`,
and `pdkit validate launch` refuses to start when something else already answers
there rather than quietly picking another port — which is what allows the
endpoint to be written down once.

**Pointing it at nothing is safe.** The server connects lazily: it starts,
registers its tools and waits, so it survives every session in which you never
launch the application. It fails only when a tool is called with nothing
running.

`/pd:doctor` checks the wiring, not just the name — a server without
`--cdp-endpoint`, or one aimed at a different port, is reported as a warning
with the command to fix it.

**Playwright attaches to an application pdkit started.** `pdkit validate launch`
spawns the build with `--remote-debugging-port`, waits for `/json/version` and
prints the endpoint. That is the shape upstream's own runner uses
(`tests/playwright/src/runner/chrome-dev-tools-protocol-runner.ts`), which is
also the answer to whether an Electron podman-desktop can be driven at all: it
has been, in their CI, all along. Verified end to end on 2026-08-02 against the
development build — `browser_snapshot` came back with the real accessibility
tree.

"No Playwright" and "nothing to point Playwright at" are different problems.
`doctor` reports the second separately, as `validate:app` — a perfectly
configured server still has nothing to drive if the tree was never built.

## Hooks other tools install, and why they cannot get past the gate

Hooks on the `Bash` tool are **global**: one installed for an unrelated project
sees the commands you run here too, and can rewrite them. That is why
`lib/hooks/command-parse.js` strips wrapper programs — `sudo`, `env`, `nice`,
`nohup` and the rest — before any rule is applied, and why
`/pd:doctor --gate-selftest` probes that exact shape. The question the parser
answers is never "did somebody mean to wrap it" but "what is going to run".

If you install anything that hooks `Bash`, run the self-test afterwards.

**Receipts are unaffected either way.** `lib/evidence.js` spawns the command
itself from Node, so no hook on the `Bash` tool is consulted and nothing sits
between the command and the output that lands in the receipt.

## Retired keys

`pdkit init` copies the shipped config whole, so a key the plugin stops reading
survives in your own file looking exactly like a setting you chose.
`/pd:doctor` reports any it finds under `config:gates`, naming the key and what
to do. The fix is always the same: delete it.
