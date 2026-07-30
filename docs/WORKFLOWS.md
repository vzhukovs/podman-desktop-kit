# Workflows

Scenarios, in the order you are likely to hit them. Each names the commands and
the decision points that are yours rather than the plugin's.

> Stub. Filled in as stages land — see section 12 of the architecture spec.

## 1. A bug fix

```
/pd:triage 12345      → route, drafted requirements
/pd:plan 12345        → reconnaissance, open questions, plan     [you approve]
/pd:plan-review 12345 → adversarial review of the plan
/pd:exec 12345        → implementation, one task per worker, receipts
/pd:validate 12345    → evidence from the running application
/pd:audit 12345       → diff against plan, fresh context
/pd:slice 12345       → usually one slice                        [you approve]
/pd:preflight 12345   → deterministic gates
/pd:pr 12345          → branches and PR bodies                   [you confirm push]
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

## 3. A new feature

The full path. `/pd:slice` will usually produce 2–5 pull requests, and the plan
has to have anticipated that: a diff planned without slicing in mind cannot be
cut apart afterwards without redoing the work.

## 4. Coming back after a break

```
/pd:sync
/pd:resume 12345      → upstream drift, rebase, conflict classification
/pd:pr-sync 2871      → review threads accumulated meanwhile
/pd:preflight 12345
/pd:pr 12345
```

A previous green preflight means nothing after a rebase.

## 5. Reviewing someone else's PR

```
/pd:review-pr 2903
```

Outside the issue lifecycle entirely.

## Decision points that stay yours

The plugin stops and waits at exactly four places, and none of them can be
automated away:

1. Plan approval — after `[NEEDS DECISION]` items are resolved.
2. Slice graph approval.
3. Push confirmation — per branch, in the same turn, never carried over.
4. Plan amendments arising from review.
