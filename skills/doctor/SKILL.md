---
name: doctor
description: "Check the pdkit environment: required tools, optional MCP servers, hook wiring, and gate self-test."
disable-model-invocation: true
model: sonnet
---

Report what is present, what is missing, and what degrades as a result. Never
report a capability as available without checking it.

```
pdkit doctor                  # required tools, config layers, $PDKIT_HOME, hooks, MCP
pdkit doctor --gate-selftest  # plus: drive the real hooks the manifest registers
pdkit doctor --repo <path>    # act on a repository other than the current one
```

## Reading the report

Three levels — `required`, `optional`, `later` — and four results. The
distinction that matters is between the last two:

| | Meaning |
|---|---|
| ✔ | checked and satisfied |
| ! | a warning: it works, and something is worse than it could be |
| ✘ | broken. Only `required` failures make the exit code non-zero |
| · | not checked, and the line says why |

A warning is not a failure and must not be reported as one. A doctor that exits
non-zero on every optional gap stops being run, and a check nobody runs is worse
than no check.

## The self-test

`--gate-selftest` is not part of the routine run: it spawns the hook once per
probe and takes a few seconds. Run it **after installing, after upgrading, and
after touching anything under `lib/hooks/`**.

It is the only check that answers "is the protection actually on". Every unit
test in the suite stays green while a plugin with a broken manifest gates
nothing at all, so this one drives real commands through the binary the manifest
names: seventeen for the push gate, two for the ownership hook.

If it reports a miss, nothing else in the report matters until it is fixed.

## Warnings that are decisions rather than breakage

Do not offer to "fix" these — say what they mean and let the user decide:

- **`package-map:layers`** — `packages/api`, `packages/webview-api` and
  `storybook` belong to no layer. That decides merge order for slices, and the
  decision belongs to stage 3.
- **`rtk:readonly`** — rtk is installed and its `exclude_commands` does not
  cover everything `tools.rtk.never_rewrite` lists. The gate does not depend on
  it; it narrows the surface. `docs/configuration.md` has the TOML.
- **`mcp:playwright`** — absent means `/pd:validate` produces a checklist
  instead of a run and never sets PASS. Configure it with `--cdp-endpoint`:
  pdkit starts the application, the server attaches to it.
- **`validate:app`** — a different problem with a different fix. The server can
  be configured perfectly and validation still have nothing to drive, because
  the working tree was never built.
- **`config:arrays`** — a list in your `config.yaml` has fallen behind the
  shipped default. Lists replace rather than merge, so one copied by `init` and
  never edited stays at the value shipped that day; delete the key to follow the
  default again, or extend it deliberately.
- **`ponytail:hooks`** — a global ponytail hook reaches every agent, including
  the implementer, which is where its disposition argues with the plan.

## When something is red

Read the detail line: every failure here is written to say what to do, not just
what is wrong. `home` failing means `pdkit init` has not run. `config:merge`
failing names the file and the line. `gh-auth` failing means `gh auth login`.

Report the findings to the user rather than repairing the environment. The one
exception is a stale package map, where `pdkit init` is the whole fix and is
safe to offer.
