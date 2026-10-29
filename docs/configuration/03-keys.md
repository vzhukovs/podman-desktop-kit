# What each key does

[Configuration](README.md) › 3 of 8

Every key of `config.yaml`, grouped by the part of the cycle it decides. Where
a key is set, and which layer wins, is in [Layers](01-layers.md).

## Repository and state

| Key | Effect |
|---|---|
| `repo.upstream` | Checked against the git remotes by `init` and `doctor` |
| `repo.fork` | The same, but ships empty and is filled by `init` from the `fork_remote` URL. Set it by hand only to override what the clone says |
| `repo.upstream_remote`, `repo.fork_remote` | Which remote names carry them |
| `repo.path` | Optional. Work on this repository regardless of the working directory |
| `state.root` | Where `$PDKIT_HOME` lives, unless the environment says otherwise |

## Branches and slicing

| Key | Effect |
|---|---|
| `branches.single`, `branches.sliced` | Branch name templates; `{issue}`, `{index}`, `{slug}` |
| `slicing.layer_order` | Merge order for slices, and the layer each package is filed under. A package no entry claims is reported by `doctor` rather than filed under the nearest match |
| `slicing.strategy` | `prefer-independent` by default. A stack is fragile — after #1 merges, #2 needs its base switched and its threads point at moved lines |
| `slicing.max_files_per_slice` | A warning threshold, not a refusal. Size is a conversation |
| `slicing.verify.worktree` | `reuse` keeps one tree per issue, so `node_modules` survives between runs; `ephemeral` rebuilds it every time and pays a full install per slice |
| `slicing.verify.install` | `on-lockfile-change` (default), `always`, or `never`. The marker recording which lockfile is installed lives inside `node_modules`, so wiping one wipes the other |
| `slicing.verify.prepare` | Build scripts run after every clean, before anything is checked. **The list to look at when every slice comes back inconclusive.** The tree is reset to what git holds on each run, so a package resolving through a `dist/` that is not committed is simply absent there — and a typecheck that consumes it without building it reports hundreds of errors in files no slice touched. podman-desktop needs `build:core-api` and `build:ui`, both found that way, one live run apart. Names the repository does not define are skipped, so the list costs nothing where it does not apply |

## Worktrees and the editor

| Key | Effect |
|---|---|
| `worktrees.root` | Where trees go. Beside the fork, never inside it: a checkout under the repository shows up in `git status` and eventually in a pull request |
| `editor.path` | The IDE `pdkit editor` opens a worktree in. Empty by default. **Read from `$PDKIT_HOME/config.yaml` only**: it names a program pdkit runs, so a repository's `.pdkit.yaml` that sets it, or that moves `state.root` (and with it the `config.yaml` read), is refused — a pull request under review decides what its tree holds. An absolute path: a bare name such as `code` is refused, since Windows searches the working directory first. A macOS `.app` goes through `open -a`; on Windows only an `.exe` — not `code.cmd`, which runs through `cmd.exe` (use `Code.exe`); anything else is run with the tree as its only argument, without a shell, from the home directory. A program every user can write is refused. Single-quote Windows paths: a backslash inside double quotes is an escape. Unset, `pdkit editor` exits 1 and prints the lines to add |
| `worktrees.copy_files` | Copied into every new tree, and again after each verification reset — `git clean` takes them |

## Triage, quickfix and the gate

| Key | Effect |
|---|---|
| `triage.fetch_comments` | How many comments `issue fetch` prints, newest first; the rest are counted and `--full` prints them. The body is always printed whole and has no setting |
| `quickfix.max_changed_lines`, `quickfix.max_files` | Thresholds above which a quickfix escalates back to triage |
| `gates.push_ttl` | How fast consent goes stale. Which states a token may be issued from is not configurable — see `state.GATE_ELIGIBLE` |

## Validation

| Key | Effect |
|---|---|
| `validation.e2e` | `prefer`, `required` or `off`. The per-issue decision is made at planning, in the plan's `e2e coverage` field |
| `validation.e2e_stability_runs` | Consecutive green runs a new e2e test needs. The series is tied to a digest of the spec, so editing the test afterwards fails preflight rather than passing on stale runs |
| `validation.require_evidence` | When false, `validation-evidence` skips. It exists for a repository where the application cannot be driven at all, not as a way past a step you would rather not demonstrate |
| `validation.app.binary` | A packaged application to drive. Empty by default: `PODMAN_DESKTOP_BINARY` comes next, then `node_modules/.bin/electron .` — the development build, which is what upstream's own e2e drives. **Read from `$PDKIT_HOME/config.yaml` only**, with `validation.app.args`, for the reason `editor.path` is: a `.pdkit.yaml` that sets either, or moves `state.root`, is refused. It and `PODMAN_DESKTOP_BINARY` must be absolute, an `.exe` on Windows, and not writable by every user |
| `validation.app.debug_port` | Where CDP listens. `validate launch` refuses a port something else already answers on rather than fighting it |
| `validation.app.startup_timeout` | How long to wait for `/json/version`. A process that dies before then is reported at once, not after the timeout |

## Preflight and execution

| Key | Effect |
|---|---|
| `preflight.scripts.*` | Overrides for script-name resolution. **Empty by default**, and it should stay that way: names are resolved from the repository's own `package.json`, which is the right source. Filling one in is worth doing exactly when the resolver got it wrong — which is a reason to fix the resolver |
| `preflight.typecheck_scope` | `repo` (default) or `packages`. What `typecheck` means in preflight **and** in `pdkit slice verify`: the repository's whole `typecheck`, or the touched packages' own scripts. A type error lands in the package that consumes a change, so `packages` misses exactly the break a slice causes: on DESKTOP-19818 a preload-only slice passed `typecheck:preload` in both gates and failed upstream CI's typecheck in the renderer. On podman-desktop the whole one took 36 s on a warm tree. A narrowed run says so in its summary |
| `exec.max_attempts` | How many failed captures of `Done when` block a task. Three by default; zero switches blocking off entirely. It can only weaken the rule, never tighten it — the count itself comes from the captures, not from anyone's account of them |
| `budget.turns.*` | A soft ceiling per phase, in turns: `triage`, `plan`, `exec_per_task`, `validate`, `audit`, `slice`, `pr`, `pr_sync`. Nothing refuses at it, and nothing could — no command sees how many turns a session has taken. The `SessionStart` summary prints the one for the phase it opens, and the skill names it when it suggests stopping and restarting. Context is re-read whole on every call, so a phase twice as long costs about four times as much |

## Review, journal and languages

| Key | Effect |
|---|---|
| `review.stale_after_days` | When an open pull request is reported as idle |
| `review.bots_collapsed` | Accounts collapsed to one line in `pr threads`. Collapsed, never dropped |
| `review.bot_escalate` | Words that expand a collapsed bot back to full text. One direction only: a match raises a thread and never lowers one |
| `journal.reanchor_scope` | How much of the journal `SessionStart` injects. `issue` by default, because the whole file starts eating context within a month |
| `languages.*` | The language each artefact is written in. The review report is the one worth setting: it is read by you, not by upstream |

---

**The design** — [9 · What the keys decide](../specification/09-configuration.md#what-the-keys-decide)

← [`$PDKIT_HOME`](02-pdkit-home.md) · [Contents](README.md) · [The package map](04-package-map.md) →
