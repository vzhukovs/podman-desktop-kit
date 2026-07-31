# Workflows

Scenarios, in the order you are likely to hit them. Each names the commands and
the decision points that are yours rather than the plugin's.

**What works today:** scenarios 1 and 2, up to and including an open pull
request. Everything marked *(stage N)* below is registered but still a stub —
the skill says so rather than improvising.

## Before anything

```
pdkit doctor                  # required tools, config, hook wiring
pdkit doctor --gate-selftest  # drives every forbidden command through the real hook
```

Run the second one after installing, after upgrading, and after touching
anything under `lib/hooks/`. It is the only check that answers "is the gate
actually on" — every unit test in the suite stays green while a plugin with a
broken manifest gates nothing at all.

## 1. A bug fix

```
/pd:triage 12345      → route, drafted requirements
/pd:plan 12345        → reconnaissance, open questions, plan     [you approve]
/pd:plan-review 12345 → adversarial review of the plan                (stage 2)
/pd:exec 12345        → implementation, one task per worker, receipts
/pd:validate 12345    → evidence from the running application         (stage 5)
/pd:audit 12345       → diff against plan, fresh context              (stage 2)
/pd:slice 12345       → usually one slice                             (stage 3)
/pd:preflight 12345   → deterministic gates
/pd:pr 12345          → branch, PR body, PR                      [you confirm push]
```

## 2. A one-line fix

```
/pd:triage 12908      → route: quickfix
/pd:quickfix 12908
/pd:preflight 12908
/pd:pr 12908                                                     [you confirm push]
```

Planning is skipped on purpose. If the diff fits in one sentence, a plan is
overhead — and the threshold in config is a defence against ceremony, not an
optimization.

If the fix outgrows the thresholds, `pdkit issue escalate 12908` sends it back
to triage. That ordering is not bureaucracy: requirements derived from a diff
you have already written describe what you built rather than what was needed.

## 3. A new feature

The full path. `/pd:slice` will usually produce 2–5 pull requests, and the plan
has to have anticipated that: a diff planned without slicing in mind cannot be
cut apart afterwards without redoing the work. The slicer lands in stage 3.

## 4. Coming back after a break

```
/pd:sync
/pd:resume 12345      → upstream drift, rebase, conflicts             (stage 4)
/pd:pr-sync 2871      → review threads accumulated meanwhile          (stage 4)
/pd:preflight 12345
/pd:pr 12345
```

A previous green preflight means nothing after a rebase.

## 5. Reviewing someone else's PR

```
/pd:review-pr 2903                                                    (stage 5)
```

Outside the issue lifecycle entirely.

---

## What preflight actually runs

`pdkit preflight <issue>` runs eighteen checks, and on podman-desktop it takes
minutes, because it runs the repository's real scripts. Script names are
resolved from the repository's own `package.json` — there is no `pnpm lint`
there, and `pnpm test` drags in the e2e suite.

Three results, and the difference between them matters:

| | Meaning |
|---|---|
| **pass** | the check ran and was satisfied |
| **skip** | the check did not run, and the summary says why |
| **fail** | blocking, unless the check is advisory (`debug-leftovers`) |

A skip is never a pass. `steps-to-check` skipping because no PR body exists yet
means that check has not run at all.

**`working-tree` is first, and red there invalidates the rest.** The file
checks read the committed diff; the command checks run whatever is on disk. On
a clean tree those are one thing. On a dirty one the report mixes two, and it
can go green on a diff that will not be pushed.

### The two passes

Four checks read the PR body, and the body depends on preflight — `Notes for
reviewers` is mandatory exactly when preflight flags something CI cannot judge.
One pass cannot close that loop, so:

```
pdkit preflight 12345                                   # pass 1, no body
pdkit render prBody --issue 12345 --values v.json --strip-comments > body.md
pdkit preflight 12345 --body-only --body body.md        # pass 2
```

Green on pass 2 is what the gate is issued from. Pass 1 alone is not enough,
and `--body-only` without `--body` is refused rather than reported green.

## The push gate

Nothing reaches GitHub without a consent token, and a token is issued for one
branch, expires in ten minutes, and is spent on first use.

```
pdkit gate open --issue 12345 --branch DESKTOP-12345/slug
git push origin DESKTOP-12345/slug
pdkit pr create --issue 12345 --branch DESKTOP-12345/slug --title … --body body.md
```

`gate open` refuses unless the issue is in `preflight-green` and the branch
belongs to that issue. Both are checked inside `pdkit` rather than asked of the
caller.

Refused without a token, and refused the same way whether you type it or an
agent does:

- `git push` in any shape — chained behind `&&`, in a subshell, in a command
  substitution, named by absolute path, or wrapped by a rewriter such as `rtk`
- `gh pr create|edit|merge|review`, `gh issue create|comment|close`
- `gh api` with a mutating method, and `gh api graphql` carrying a mutation

Refused **always**, token or not:

- `git push --force` without `--force-with-lease`
- `git add -A` and `git add .`
- `git rebase -i` — the husky `commit-msg` hook adds `Signed-off-by` to a
  message that already has one, then rejects the duplicate it created. Squash
  with `git reset --soft <base> && git commit`
- `git commit --no-verify`

Ordinary work is untouched: `git status`, `git add <path>`, `git commit -m`,
`gh pr view`, `gh api` reads. If a refusal looks wrong, `pdkit doctor
--gate-selftest` says whether the gate is behaving; rephrasing the command is
not a fix, and the parser was written for exactly that attempt.

## Decision points that stay yours

The plugin stops and waits at exactly four places, and none of them can be
automated away:

1. Plan approval — after `[NEEDS DECISION]` items are resolved.
2. Slice graph approval.
3. Push confirmation — per branch, in the same turn, never carried over.
4. Plan amendments arising from review.

## Where the state lives

`$PDKIT_HOME`, default `~/.pdkit/podman-desktop` — **outside the fork**, so
nothing the plugin records can end up in a pull request.

```
pdkit state 12345             # where an issue is, and where it may go next
pdkit journal --issue 12345   # why it got there
```

`state.json` knows *where*; the journal knows *why*. "Why is slice #2 stacked
rather than branched from main" is recoverable six months later only from the
journal, which is append-only and never rewritten.
