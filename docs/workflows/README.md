# Workflows

Every use case the plugin covers, grouped by what you are trying to do. Each one
names the commands and the decision points that stay yours.

Each use case is a file of its own and can be opened directly. A file carries its
scenario number in its name and its title, so "scenario 9" is
[`09-approach-rejected.md`](09-approach-rejected.md). Every scenario has a
**Sessions and models** table: for each step, whether it needs a new session,
where to open it, which `/model` to type first, and which subagents it starts —
the columns are explained once, in
[Which session, which model](reference/sessions.md#which-session-which-model).
Every file ends with links to the previous and next scenario and to the part of
[`specification/`](../specification/README.md) that holds the reasoning.

**What works today:** every scenario below has machinery behind it and is covered
by tests. **What has been proven against a live repository is narrower**, and the
difference is worth knowing before trusting a step — [section 13 of
`specification/`](../specification/13-status.md) keeps the full accounting, with evidence
per row. In short: the `quickfix` and `standard` routes have each gone end to end
to a published upstream pull request, once as a two-slice graph into two of them,
and one issue has been through the whole machine to `merged` with a reviewer and
a rebase in the middle. Much of that was driven through `pdkit` in a terminal —
so eleven of the twenty-four skills below have never been invoked as `/pd:*`.

## Before anything

```
pdkit doctor                  # required tools, config, hook wiring
pdkit doctor --gate-selftest  # drives every forbidden command through the real hook
```

Run the second one after installing, after upgrading, and after touching anything
under `lib/hooks/`. It is the only check that answers "is the gate actually on" —
every unit test in the suite stays green while a plugin with a broken manifest
gates nothing at all.

## Models, at a glance

A skill's `model:` holds for its first turn; the session's model runs the rest
of the phase and survives `/clear`. So each phase starts with what you type:

```
/clear
/model <model>        only where the line below switches
/effort <level>
/pd:<skill> <n>
```

and in one cycle the model switches here:

```
cd <fork> && claude          ──► sonnet, the fork's default

/model opus    before /pd:triage       holds through /pd:plan and /pd:plan-review
/model sonnet  before /pd:exec         holds through validate, audit, slice, preflight, pr, pr-status
/model opus    before /pd:pr-sync      holds through every review round
/model sonnet  before /pd:resume, /pd:slice, /pd:pr or /pd:close after a review round

/effort high   /pd:triage, /pd:plan, /pd:plan-review, /pd:audit, /pd:pr-sync
/effort medium every other phase
```

`/pd:review-pr` and `/pd:knowledge` run on opus too. `pdkit next <n>` prints the
`/model` line above the command, and the hook says when the session is on the
wrong one. Start `claude` in the fork: the hook moves the session into the
issue's tree — [Where a session works](reference/trees.md). Every command, with
its session, model, effort and subagents:
[Which session, which model](reference/sessions.md#which-session-which-model).

## Part I — Choosing and starting work

| § | Scenario | Sessions |
|---|---|---|
| 0 | [Picking what to work on](00-picking-what-to-work-on.md) | main checkout · opus |
| 1 | [A bug fix](01-bug-fix.md) | main checkout · opus through planning; issue tree · sonnet from `/pd:exec` on |
| 2 | [A one-line fix](02-one-line-fix.md) | main checkout · opus for triage; sonnet after |
| 3 | [A feature, cut into several pull requests](03-feature-in-several-prs.md) | issue tree · sonnet, one session per slice |

## Part II — Proving it works

| § | Scenario | Sessions |
|---|---|---|
| 4 | [Validating against the running application](04-validating.md) | issue tree · sonnet, Playwright connected |
| 5 | [Work that was already tried and reverted](05-tried-and-reverted.md) | main checkout · opus |
| 6 | [An issue that ends in an answer](06-ends-in-an-answer.md) | sonnet for the reproduction; the rest in a terminal |

## Part III — Living with an open pull request

| § | Scenario | Sessions |
|---|---|---|
| 7 | [A pull request that has gone stale](07-stale-pr.md) | issue tree · opus, one session per review round |
| 7a | [Feedback that arrives after the merge](07a-feedback-after-merge.md) | terminal |
| 8 | [Coming back after a break](08-coming-back.md) | issue tree · sonnet, opus for `/pd:pr-sync` |
| 9 | [The reviewer rejected the approach, not the diff](09-approach-rejected.md) | terminal, then planning again · opus |
| 10 | [A pull request replaced by another](10-pr-replaced.md) | terminal |
| 11 | [Upstream asks you to split an open pull request](11-split-open-pr.md) | issue tree · sonnet |
| 11a | [Upstream asks you to join open pull requests](11a-join-open-prs.md) | issue tree · sonnet |
| 12 | [Work that predates the plugin](12-predates-the-plugin.md) | terminal, then `/pd:pr-sync` · opus |
| 13 | [Reviewing someone else's pull request](13-reviewing-others-pr.md) | main checkout · opus |
| 14 | [Two issues at once](14-two-issues.md) | one set of sessions per tree |
| 15 | [A task that has failed three times](15-task-failed-three-times.md) | terminal, then issue tree · sonnet |
| 16 | [Starting one issue over](16-starting-over.md) | terminal, then main checkout · opus |

## Part IV — Reference

| Page | What it answers |
|---|---|
| [What preflight actually runs](reference/preflight.md) | the three results, why `working-tree` comes first, the two passes |
| [The push gate](reference/push-gate.md) | the consent token, `pdkit publish`, what is refused with and without one |
| [The ownership hook](reference/ownership.md) | writes outside a task's `Owns` set, and the two deliberate allowances |
| [Receipts](reference/receipts.md) | what finishes a task, and what is printed about the capture |
| [Calibrating the thresholds](reference/thresholds.md) | `pdkit stats` against the four configured numbers |
| [One session per phase](reference/sessions.md) | why a session per phase, **which session and which model for every command**, the turn budget |
| [Measuring what a cycle costs](reference/cost.md) | `pdkit cost`, cost units, and the caveats it prints |
| [Decision points that stay yours](reference/decision-points.md) | the five places the plugin waits, and the three it refuses |
| [Revising what the plugin thinks it knows](reference/knowledge.md) | `/pd:knowledge` and `pdkit knowledge check` |
| [Where the state lives](reference/state.md) | `$PDKIT_HOME`, `state.json` and the append-only journal |
| [Where a session works](reference/trees.md) | the fork and the issue trees, how the hook moves a session, the commands that refuse in the wrong tree, and **what to do when something looks wrong** |

## Where to look

| If you want to… | Read |
|---|---|
| choose the next issue | [0 · Picking what to work on](00-picking-what-to-work-on.md) |
| take an issue from triage to a pull request | [1 · A bug fix](01-bug-fix.md) |
| know which model to switch to before a command | [Which session, which model](reference/sessions.md#which-session-which-model) |
| know whether a step needs a new session | [Which session, which model](reference/sessions.md#which-session-which-model), [One session per phase](reference/sessions.md) |
| skip planning for a small fix | [2 · A one-line fix](02-one-line-fix.md) |
| publish one change as several pull requests | [3 · A feature, cut into several pull requests](03-feature-in-several-prs.md) |
| answer a reviewer | [7 · A pull request that has gone stale](07-stale-pr.md) |
| pick up work after days away | [8 · Coming back after a break](08-coming-back.md) |
| go back to the start of a phase | [9 · Going back to the start of a phase](09-approach-rejected.md#going-back-to-the-start-of-a-phase) |
| review a pull request that is not yours | [13 · Reviewing someone else's pull request](13-reviewing-others-pr.md) |
| throw an issue's work away and start again | [16 · Starting one issue over](16-starting-over.md) |
| know why `git push` was refused | [The push gate](reference/push-gate.md) |
| know why the session was told to move, or a command said `this tree is not DESKTOP-<n>'s` | [Where a session works](reference/trees.md) |
| read the decision table and `pdkit pr diff` in a review round | [7 · The three stops](07-stale-pr.md#the-three-stops) |
| tell whether something has gone wrong | [Something looks wrong](reference/trees.md#something-looks-wrong) |

## Other documents

| Document | What it answers |
|---|---|
| [`specification/`](../specification/README.md) | the design: what each piece guarantees, and why the guarantees stop where they do |
| [`architecture/`](../architecture/README.md) | the same design in five minutes, one part per file |
| [`configuration.md`](../configuration.md) | the three config layers and what every key decides |
