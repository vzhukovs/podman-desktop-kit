---
name: review-pr
description: "Review someone else's pull request along four parallel axes."
argument-hint: "<pr-number>"
disable-model-invocation: true
model: opus
effort: medium
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

Each axis gets the diff, the facts above, the target files and the linked
issue, **but not the threads already on the pull request**. Leave out
`feedback` from what `review fetch` returned. An axis that has read what
someone else already said ends up agreeing with it, or arguing with it. Either
way the review stops being a second opinion. The threads are not wasted: they
go to the synthesis, after the judgement is made.

Each axis reads `${CLAUDE_PLUGIN_ROOT}/knowledge/maintainer-rules.md`: its calibration, and the
sections named in its own prompt. That is the rule set upstream's own review
agent applies, so a finding grounded in it is one the maintainer would also
raise. Every finding is one line with a Semantic Code Reviews label:

```
path/to/file.ts:LINE — issue: <what and why, imperative, one or two sentences> (§<n>)
```

- `issue:` blocks approval.
- `nit:` is optional.
- `question:` needs an answer in the PR.

`(§n)` cites the section of `maintainer-rules.md`. A finding that comes from
our own axis lens and not from those rules (does it solve the issue, does it
regress a neighbouring scenario) is marked `(outside the rule set)`. That
marker is a label, not a downgrade. A finding is reported only after it has
been checked in the actual code. If it could not be checked, it becomes a
`question:`.

Then `pd-review-synth` merges them. It is given the four reports **and**
`feedback` from step 1: dedupe, calibrate, mark what reviewers already raised,
and reach one verdict.

## 3. The report

```
pdkit review render <k> --values <file.json> --reveal
```

Writes `reviews/<k>.md` from the template, and opens it in the file manager.
`--reveal` is on here because the report lands under `$PDKIT_HOME`, which is
outside the repository and outside whatever window is already open — printing
the path and leaving a copy-paste between finishing a review and reading it is
the wrong last step. Where there is no desktop it says so on one line and the
render still succeeds; drop the flag if you would rather it stayed quiet. `What I could not verify` is
mandatory and is never empty by default: the platforms you did not exercise,
the steps that need a human, the behaviour you could only read about.

The verdict follows from the findings. It is not a separate judgement. Take
the first row that matches, the same order upstream's review agent uses:

| Verdict | When |
|---|---|
| `REQUEST_CHANGES` | at least one `issue:`, or CI is red, or the diff carries changes the title and body do not describe |
| `NEEDS_DISCUSSION` | no `issue:`, but a rule requires a check nobody here can do: platform or QE validation, UX approval, a public extension-API change, running the app. Name each one under `What I could not verify` |
| `APPROVE_WITH_NITS` | only `nit:` and `question:` |
| `APPROVE` | nothing to report |

`Counts` is `Blockers N · Nits N · Questions N · Files reviewed N/N`. Do not
add a numeric grade.

## Discipline

A reviewer told to find problems will find them in correct code, and the second
time that happens nobody reads the report. So:

- do not report what the linter already catches. The rules in
  `maintainer-rules.md` are not style in this sense, even the ones that look
  like it: the maintainer raises them, so they are reported, as `nit:` where
  the calibration says so;
- a violation that already existed in a touched file is a `nit:` marked
  pre-existing, never an `issue:`, unless the PR adds a new occurrence;
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
