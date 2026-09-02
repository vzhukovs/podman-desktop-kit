# Cheat sheet

How to drive the plugin: what to run, in what order, what each step needs before
it will run, and what to do when something refuses you.

| For the long answer | Read |
|---|---|
| every scenario, in full | [`docs/workflows.md`](docs/workflows.md) |
| what a step guarantees, and why it stops there | [`docs/specification.md`](docs/specification.md) |
| config keys and what each decides | [`docs/configuration.md`](docs/configuration.md) |
| installing, and what is proven against a live repository | [`README.md`](README.md) |

---

## Before you start

```bash
pdkit init                      # state directory, config, package map
pdkit doctor                    # what is missing, and what degrades without it
pdkit doctor --gate-selftest    # the only check that answers "is the gate on"
```

Four things must already be true. `doctor` tells you which one is not:

- `gh` installed and authenticated
- one clone, two remotes — `origin` is **your fork**, `upstream` is podman-desktop
- the repository installed and built once (`pnpm install`, `pnpm build`)
- `pdkit init` run, so `$PDKIT_HOME` and the package map exist

Run `--gate-selftest` after installing and after every upgrade. A plugin whose
manifest failed to load gates nothing while every unit test stays green, so it is
the one check the test suite cannot replace.

---

## The cycle

```
/pd:triage <n>       → route + drafted requirements
/pd:plan <n>         → reconnaissance, open questions, plan
/pd:plan-review <n>  → adversarial review              [you approve the plan]
/pd:exec <n>         → implementation, a receipt per task
/pd:validate <n>     → evidence from the running application
/pd:audit <n>        → diff against plan, fresh context
/pd:slice <n>        → graph of pull requests          [you approve the graph]
/pd:preflight <n>    → the deterministic gates
/pd:pr <n>           → branch, body, pull request      [you confirm the push]
/pd:pr-sync <pr>     → review threads, when they arrive
/pd:close <n>        → once every pull request merged
```

Three decisions are yours and are never inferred: the plan, the slice graph, and
each push. Everything between them is the plugin's.

---

## Pick your route

Triage chooses it and records it. `pdkit state <n>` says which you are on.

**standard** — the cycle above. The default for a bug or a feature.

**quickfix** — the diff fits in one sentence, so planning is overhead.

```
/pd:triage <n>    → route: quickfix
/pd:quickfix <n>
/pd:preflight <n>
/pd:pr <n>
```

If it outgrows the thresholds, `pdkit issue escalate <n>` sends it back to
triage. Do not reverse that order: requirements derived from a diff you have
already written describe what you built, not what was needed.

**multi-slice** — the standard cycle, then `/pd:pr` once per slice, in merge
order, finishing each before starting the next.

**redo** — work that was tried before and reverted. `pdkit issue history <n>` is
required before triage may leave; it finds the previous pull request, what
reverted it, and what reviewers said.

**answered** — the bug is real and the cause is not in this repository. The
deliverable is a published comment: a reproduction, a detector command and a
workaround. Reached from `triaged` or `planned`, and it is **not** terminal —
the reporter still has to confirm.

---

## Every `/pd:*` command

| Command | Run it when | Needs first | You get |
|---|---|---|---|
| `/pd:doctor` | before anything, or when something misbehaves | — | tools, config, `$PDKIT_HOME`, hooks, MCP |
| `/pd:sync` | "where am I" | — | fork vs upstream, every worktree. Read-only |
| `/pd:triage <n>` | a new issue — or no number, to pick one | — | route, drafted requirements → `triaged` |
| `/pd:plan <n>` | the route is standard | `triaged` | scouts, `research.md`, `plan.md`, task files → `planned` |
| `/pd:plan-review <n>` | a plan exists | `planned` | must-change findings; repeat until clean → **you approve** → `plan-approved` |
| `/pd:exec <n> [task]` | the plan is approved | `plan-approved` | code, one worker per task, a receipt each → `implemented` |
| `/pd:validate <n>` | the code is written | `implemented` | evidence from the running app → `validated` |
| `/pd:audit <n>` | validation is done | `validated` | the diff against the plan, in fresh context → `audited` |
| `/pd:slice <n>` | the audit is clean | `audited` | a verified slice graph → `sliced` → **you approve** → `slices-approved` |
| `/pd:preflight <n>` | before every push | the slice branch cut | twenty-one checks, in two passes → `preflight-green` |
| `/pd:pr <n> [slice]` | preflight is green | `preflight-green` and a body | push and pull request → `pr-open`. **You confirm, per branch** |
| `/pd:pr-status` | any time | — | CI, threads and idleness across open PRs. Read-only |
| `/pd:pr-sync <pr>` | a reviewer answered | an open pull request | thread triage, the fixes, draft replies |
| `/pd:resume <n>` | back after a break | — | drift, rebase, plan amendment |
| `/pd:close <n>` | every PR of the issue merged | all of them merged | knowledge harvest, worktree cleanup → `merged` |
| `/pd:quickfix <n>` | triage chose that route | `triaged`, route `quickfix` | the fix, without a plan → `quickfix` |
| `/pd:review-pr <pr>` | reviewing someone else's PR | — | four parallel axes and a verdict. Outside the lifecycle |
| `/pd:reset <n>` | the cycle went wrong early | — | forgets one issue → `new`. Touches no other, and nothing upstream |
| `/pd:knowledge` | periodically, not per issue | — | a revision of the shipped knowledge base |

Three more skills trigger by meaning rather than by slash — ask in words and they
load: **package-map** (which package owns this file), **upstream-rules** (the
non-negotiables), **worktree-kit** (parallel checkouts). Twenty-two in total.

Nothing starts on its own. Every orchestrating skill is manual only.

---

## `pdkit` by hand

The whole workflow runs from a terminal without a session. These are the ones
worth typing; `pdkit --help` has the rest.

**Where am I**

```bash
pdkit state <n>                    # state, route, requirements, what is next
pdkit slice show --issue <n>       # the graph, and what has been verified
pdkit pr list                      # every registered PR: CI, review, how idle
pdkit defer list --issue <n>       # what was set aside and never settled
pdkit journal --issue <n> --since 7d
pdkit journal --event denied       # what the gate refused, and when
```

**Read the issue**

```bash
pdkit issue list --label bug --limit 20    # the backlog, ordered by what can be started
pdkit issue fetch <n>                      # the issue, its body and every comment
pdkit issue history <n>                    # what was tried before, and what reverted it
pdkit packages --of <path>                 # which package and layer owns a file
```

**While working**

```bash
pdkit task start --issue <n> --task T1     # what this tree is executing; the write hook reads it
pdkit receipt write --issue <n> --task T1  # runs "Done when" and records what it printed
pdkit task attempts --issue <n>            # failed captures; three blocks the task
pdkit task stop
pdkit plan check <n>                       # the mechanical half of plan review
```

**Verify**

```bash
pdkit preflight <n> [--slice <i>]          # minutes: it runs the real test, lint and typecheck
pdkit slice verify --issue <n> --all       # builds each slice alone, from main
pdkit validate steps --issue <n>           # what is waiting, and what is done
pdkit drift <n>                            # what landed upstream under this work
pdkit audit <n> --base main                # facts, no verdict
```

**Publish**

```bash
pdkit slice materialize --issue <n> --slice <i> --subject "fix(main): …"
pdkit gate open --issue <n> --branch <b>
pdkit pr create --issue <n> --branch <b> --title <t> --body <file>
pdkit pr refresh <k>                       # read GitHub into the local record
pdkit pr ci <k>                            # the CI verdict, measured against other open PRs
```

**Wrap up**

```bash
pdkit close <n>                            # the facts; changes nothing
pdkit close <n> --finish                   # → merged, and cleans up worktrees
pdkit worktree remove --issue <n>
```

---

## Publishing: the gate

The order is fixed and not symmetric.

```bash
pdkit state <n> --to preflight-green       # earned from a real preflight, never asserted
pdkit gate open --issue <n> --branch <b>
git push origin <b>
pdkit pr create --issue <n> --branch <b> --title <t> --body <file>
```

Four things worth knowing before you need them:

- **One token covers both writes**, once each. The push spends half, the pull
  request spends the rest.
- **A token is for one branch.** Confirming slice #1 does not confirm slice #2.
- **Ten minutes.** Consent cannot be banked.
- **A push may come before the pull request and never after.** New commits on a
  branch already under review are their own publication and need their own token.

A stacked slice opens against its predecessor's branch — but a pull request's
base has to be a branch of the repository it opens against, and your slice
branches live in your fork. So from a fork a stack cannot be expressed: either
merge the slice below first, or open with `--base main` and say in the body that
the diff carries the other slice until it lands.

---

## When it refuses you

**A refusal is answered by doing the thing, never by spelling the command
differently.** The parser was written for that second attempt.

| It says | It means | Do this |
|---|---|---|
| `No consent token for this branch` | a push needs consent that was read, not assumed | `/pd:pr <n>` — it shows the body and the branch, then issues one |
| `git push --force is never allowed` | force loses somebody's commits silently | `--force-with-lease`, and only on your own branch |
| `Opening a pull request requires a consent token` | same gate, second half | `pdkit gate open --issue <n> --branch <b>` first |
| `Writing to an open pull request requires a consent token for that pull request` | editing a live PR is publishing again | `pdkit gate open --issue <n> --pr <k> --kind reply` |
| `Commenting on an upstream issue is a human action` | it is not our tracker | draft it, show it, let a human post it |
| `Creating or changing an upstream issue is a write to someone else’s tracker` | same, and never gated open | `pdkit defer new` drafts it; you publish |
| `gh api with a mutating method requires a consent token` | the API is not a way around the rules above | open the right token, or do not |
| `git add -A and git add . stage whatever happens to be in the tree` | you would ship what you did not look at | list the paths |
| `git rebase -i does not survive the Husky commit-msg hook` | it appends `Signed-off-by`, then rejects the duplicate | `git reset --soft <base> && git commit` |
| `--no-verify skips the hooks` | those hooks add the sign-off and check the message | fix the commit instead |
| `unknown flag --x` | this command does not read it | the refusal lists what it does take |
| `state --to preflight-green` refused | no green preflight is recorded for this commit | run preflight — never a different way to set the state |
| a write was blocked outside your task | the plan gave that file to another task | `pdkit task start` on the right task, or amend the plan |
| `task is blocked` after three attempts | the third try was going to repeat the second | `pdkit task unblock --task T1 --reason "<what is different>"` |

If a refusal looks genuinely wrong, `pdkit doctor --gate-selftest` answers
whether the gate is working at all. That is a bug worth reporting; a differently
spelled command is not a fix.

---

## What preflight will ask of you

Twenty-one checks. Every one blocks except the two marked `warn`.

| Check | | What satisfies it |
|---|---|---|
| `working-tree` | | nothing uncommitted — the other checks are meaningless without it |
| `tests` | | the test script of each package the diff touches |
| `lint` | | `pnpm lint:check` |
| `typecheck` | | scoped to the packages the diff touches |
| `spdx` | | the house header on every **added** file |
| `conventional-commits` | | a type commitlint accepts, with a package scope |
| `signed-off-by` | | exactly one trailer per commit |
| `schemas` | | `pnpm generate:schemas` produces no diff |
| `extension-api` | | the obligations that come with touching the public API |
| `api-surface` | | added exports are not accidental public surface |
| `slice-standalone` | | the slice built alone, green, and the branch still matches it |
| `branch-name` | | `DESKTOP-<issue>/[<index>-]<slug>` |
| `quickfix-size` | `warn` | the diff still fits the quickfix thresholds |
| `pr-body-template` | | the body has every section the template declares, footer and test checkbox included |
| `steps-to-check` | | ≥3 numbered steps in the body, each with an expected result |
| `r-coverage` | | every frozen R-ID appears in the body |
| `e2e-stability` | | a new Playwright spec passed three times in a row, on its current contents |
| `e2e-environment` | | Notes for reviewers says what the test needs and where it will not run |
| `validation-evidence` | | every validation step has an artefact, or the body explains |
| `debug-leftovers` | `warn` | no `console.log`, `.only`, `.skip`, `@ts-ignore`, bare `any` in added lines |
| `ci-blind-spots` | | build, packaging or platform behaviour CI cannot judge is named in the body |

**It runs twice, and the second pass is not ceremony.** Four checks read the pull
request body, so on the first pass they judge nothing. Draft the body, then:

```bash
pdkit preflight <n> --body-only --body <file>
```

Until they have actually seen a body, `pdkit state <n> --to preflight-green` will
refuse.

Two things to expect: preflight takes minutes, because it runs the repository's
real scripts. And a slice needs its branch cut first — `pdkit slice materialize`
comes before `pdkit preflight --slice <i>`.

---

## Where your files are

Everything lives outside the repository, so service files can never reach a diff.
`$PDKIT_HOME` defaults to `~/.pdkit/podman-desktop`.

```text
config.yaml         your layer: fork slug, thresholds, script names
journal             append-only, every issue, every event
package-map.json    which package and layer owns which path
gates/              live consent tokens
reviews/<k>.md      reviews of other people's pull requests
issues/<n>/
  issue.md          triage: the issue as read, and the drafted R-set
  research.md       what the scouts found
  plan.md           the plan, its file-ownership map and done-criteria
  tasks/T1.md       one per task: what it owns, and when it is done
  receipts/T1.md    what the "Done when" command actually printed
  validation/       captures: runs, screenshots, the e2e series
  verify/S1.md      each slice built alone, and what came back
  slices.md         the graph, merge order, and what each PR body must carry
  amendments/A1.md  a change to an approved plan, and who approved it
  deferrals/D1.md   set aside, with a draft of the issue that would settle it
  pr-bodies/        what was published, as published
  audit.md          the diff against the plan
```

Read the journal rather than guessing what happened: `pdkit journal --issue <n>`
for one issue, `--event denied` for everything the gate refused.

---

## Rules that never bend

These are upstream's, not the plugin's. Preflight checks all five.

- **SPDX header** on every added file, in the repository's house format
- **Conventional commit with a package scope** — `fix(main): …`, not `fix: …`
- **Exactly one `Signed-off-by`** per commit; the Husky hook adds it
- **`pnpm generate:schemas`** whenever a configuration or preference schema moves
- **Squash with `git reset --soft <base> && git commit`** — never `rebase -i`,
  which the commit-msg hook does not survive

---

## Stuck?

| Situation | Reach for |
|---|---|
| triage read the issue as something it is not | `/pd:reset <n>` — forgets this issue only |
| a task has failed three times | `pdkit task unblock --issue <n> --task T1 --reason "<why this try differs>"` |
| the work predates the plugin | `pdkit issue adopt <n> --reason "<what is true>"` |
| the reviewer rejected the **approach**, not the diff | `pdkit issue rework <n> --reason "<what was refused>"` |
| a quickfix outgrew its thresholds | `pdkit issue escalate <n>` |
| something must be set aside | `pdkit defer new --issue <n> --what "<it>"` — drafts the follow-up issue |
| an approved plan has to change | `pdkit amendment new --issue <n> --values <f>`, then `approve` |
| a token was issued and should not have been | `pdkit gate revoke` |
| upstream moved under an open branch | `/pd:resume <n>` — drift, rebase, amendment |
| a worktree is in the way | `pdkit worktree remove --issue <n>` |

---

<sub>Part of [podman-desktop-kit](README.md). If a command here disagrees with
`pdkit --help`, the CLI is right and this file is a bug.</sub>
