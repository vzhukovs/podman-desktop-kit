# Podman Desktop Kit

A Claude Code plugin for working upstream issues in
[podman-desktop](https://github.com/podman-desktop/podman-desktop): triage an
issue, plan it, implement it, slice the result into atomic pull requests, and
carry those PRs through review.

> **Status: skeleton.** The file layout and command surface are in place; the
> `pdkit` implementation is not. See
> [`specs/podman-desktop-kit-architecture.md`](specs/podman-desktop-kit-architecture.md)
> for the design and section 12 for the delivery order.

## Why this exists

Working someone else's repository is different from working your own. You cannot
store workflow state in the tree, you cannot open scratch issues, and a sloppy
push is public noise in a project you do not own. This plugin encodes that
asymmetry:

- **State lives outside the repository**, in `$PDKIT_HOME`, keyed by issue
  number. Five worktrees see one state, not five copies of it.
- **Writes to GitHub pass a gate.** `git push` and `gh pr create` are denied by a
  hook unless a short-lived consent token exists for that exact branch.
- **"Done" means attached command output**, not a claim. Task completion is
  blocked without a receipt.
- **One change set becomes N atomic PRs.** Slicing is verified mechanically: a
  slice is independent only if it builds, lints, and tests standalone from
  `main`.

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
| context7 | dependency-bump route | changelog lookups fall back to grep |
| ponytail | `pd-plan-critic`, `pd-review-architecture` | those two agents use the built-in over-engineering checklist |

The plugin ships no `.mcp.json` on purpose: a plugin-level MCP declaration would
load for everyone, and these are meant to be optional. Configure them yourself;
see [`docs/configuration.md`](docs/configuration.md).

## Install

```bash
# from a local checkout
claude --plugin-dir /path/to/podman-desktop-kit

# or as a marketplace
/plugin marketplace add vzhukovs/podman-desktop-kit
/plugin install pd@podman-desktop-kit
```

Then run `/pd:doctor` to check your environment.

## Commands

All orchestrating skills are manual only — nothing starts on its own.

| Command | What it does |
|---|---|
| `/pd:doctor` | environment report |
| `/pd:sync` | fork and worktree status |
| `/pd:triage <issue>` | classify the issue, draft requirements, pick a route |
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

## Layout

```text
bin/pdkit          deterministic CLI, added to PATH by the plugin
lib/               its implementation: state machine, slicing, gates, preflight
skills/            21 skills — the workflow surface
agents/            14 agents — scouts, implementers, auditors, reviewers
hooks/hooks.json   six entries; the rules live in lib/hooks/
knowledge/         upstream constitution, package map, known traps
templates/         plan, task, receipt, slices, PR body, review report
specs/             architecture spec, frozen versions, implementation plans
```

## License

Apache-2.0. See [LICENSE](LICENSE).
