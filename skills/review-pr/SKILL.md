---
name: review-pr
description: "Review someone else's pull request along four parallel axes."
argument-hint: "<pr-number>"
disable-model-invocation: true
model: opus
---

Outside the issue lifecycle entirely. Nothing here moves a state machine, and
nothing here is published.

## 1. The facts

```
pdkit review fetch <k> --json
```

Fetches `refs/pull/<k>/head` and reads the diff locally, from where the pull
request branched rather than from where upstream is now — against the tip it
would carry every commit that landed since, and the review would ask the author
about work they never did.

What comes back is mechanical and already done: files by layer, whether the
public API is touched, exported symbols that reach `extension-api.d.ts`,
schemas changed with nothing generated beside them, added files without a
licence header, the threads reviewers have already opened, and **the linked
issue with its text** — read from `closingIssuesReferences` first, then from
keywords in the body, then from the bare number under upstream's "What issues
does this PR fix or reference?" heading.

Hand that issue to the four axes. Without it, `Requirement fit` is the diff
agreeing with itself: a table that finds nothing missing because it was built
from the same source it is checking. When `references` comes back empty the
report says so out loud, and that is a fact about the pull request worth
raising rather than a gap to paper over.

## 2. Four axes, in parallel

| Agent | Looking for |
|---|---|
| `pd-review-architecture` | does it fit existing patterns; does it duplicate a utility; right layer; dependency direction |
| `pd-review-api-compat` | backwards compatibility, `Disposable` and leaks, schemas, the public surface |
| `pd-review-tests` | are the claimed edge cases covered; skips, weakened assertions, `any`, `@ts-ignore`; determinism |
| `pd-review-product` | does it do what the issue asked; i18n, a11y, contrast; error and empty states; neighbouring regressions |

Each gets the diff, the facts above, and the target files. Give each the threads
that already exist: a review repeating what somebody said a week ago reads as
automated, and gets treated accordingly.

Then `pd-review-synth` merges them — dedupe, prioritise, one verdict.

## 3. The report

```
pdkit review render <k> --values <file.json>
```

Writes `reviews/<k>.md` from the template. `What I could not verify` is
mandatory and is never empty by default: the platforms you did not exercise,
the steps that need a human, the behaviour you could only read about.

## Discipline

A reviewer told to find problems will find them in correct code, and the second
time that happens nobody reads the report. So:

- do not report style;
- do not ask for defensive code against impossible states;
- do not suggest one more abstraction;
- **do not mention commit scope.** Upstream does not require it — it is our own
  discipline, and `pdkit review fetch` deliberately never reports it. Spending
  an author's attention on a rule their project does not have is how a review
  loses the standing to raise the ones it does.

An empty section is a valid result. Two blocking findings and three empty
sections is a better review than eleven nits.

## Publishing

Nobody publishes but you. The report lands in `reviews/<k>.md`; posting it is a
human action, in your own words and under your own account. The hook refuses the
write in any case — a review comment needs a `reply` token, and reviewing
someone else's pull request has no issue and no state to issue one from.
