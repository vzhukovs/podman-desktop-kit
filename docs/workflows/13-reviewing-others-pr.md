# 13. Reviewing someone else's pull request

[Workflows](README.md) › Part III — Living with an open pull request · [Sessions and models](#sessions-and-models)

```
/pd:review-pr 2903
```

Outside the issue lifecycle entirely. Nothing moves a state machine, and nothing is
published — the report lands in `$PDKIT_HOME/reviews/2903.md`, and posting it is a
human action in your own words.

```
pdkit review fetch 2903 --json      files by layer, public API, schemas, SPDX,
                                    the linked issue, the threads reviewers
                                    already opened, CI status
pdkit review render 2903 --values v.json [--reveal]
```

The diff is read locally, from `refs/pull/2903/head` against where that pull request
branched. Against the tip of `main` it would carry every commit that landed since,
and the review would ask the author about work they never did.

Then four axes in parallel — architecture, API compatibility, tests, product — and
`pd-review-synth` to dedupe and reach one verdict.

The axes apply `knowledge/maintainer-rules.md`, the rule set upstream's own review
agent uses, and label every finding `issue:`, `nit:` or `question:`. They judge
**without** the threads already on the pull request, so the review is a second
opinion and not an echo. Only the synthesis reads those threads, after the
judgment, and marks a finding a reviewer already raised as `(already raised by
@login)`.

## What comes out

A file with a fixed shape, rendered from `templates/review-report.md` rather than
written free-hand, so a section cannot go missing by being forgotten:

```markdown
# Review: PR #2903 — <title>

Verdict: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES | NEEDS_DISCUSSION
Confidence: high | medium | low — and why
Counts: Blockers N · Nits N · Questions N · Files reviewed N/N

## Requirement fit                                  ← one row per issue requirement
| Issue requirement | Covered | Where |
## Blocking (correctness, compatibility, data loss)
## Nits (author's discretion)
## Questions for the author
## What I could not verify
```

Three of those carry the discipline, and each exists because of a way reviews go
wrong:

- **`Confidence` takes a reason, not just a word.** "high" on a PR whose area you
  have never opened is the failure this field exists to make visible.
- **`What I could not verify` is mandatory and rarely empty.** What cannot be
  established by reading, which steps need a human, which platform was not
  exercised. A review that reads as complete when it is not is worse than one that
  admits its edges.
- **`Requirement fit` needs the linked issue**, which is why `review fetch` reads
  it. Without it the table is filled with guesses about what the author was asked
  to do.

`--reveal` opens the finished report in your file manager; where there is no
desktop it says so and carries on.

**The report can be in your language while everything published stays English.**
`languages.review_report` in the config decides — the report is read by you, and
the comment you eventually post is written by you, so nothing about it has to
match what upstream sees.

## Two rules, both from experience

A reviewer told to find problems will find them in correct code, so **an empty
section is a valid result** — the axis prompts forbid reporting style, demanding
defensive code for impossible cases, and "this could be more abstract".

And **commit scope is never mentioned**: upstream does not require it, it is our
own discipline, and `pdkit review fetch` deliberately never reports it. Spending an
author's attention on a rule their project does not have is how a review loses the
standing to raise the ones it does.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
/clear
/model opus                         ← the synthesis and the session are opus
/effort medium
/pd:review-pr 2903                  the four axes run on sonnet on their own
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `/pd:review-pr 2903` | **new** · main checkout | opus | `pd-review-architecture`, `-api-compat`, `-tests`, `-product` · sonnet; `pd-review-synth` · opus |
| posting the review | GitHub, by hand | — | — |

One session per pull request reviewed. The `pdkit review …` lines below are
what the skill runs.

---

**The design** — [`/pd:review-pr`](../specification/04-contracts/review-pr.md)

← [12 · Work that predates the plugin](12-predates-the-plugin.md) · [Contents](README.md) · [14 · Two issues at once](14-two-issues.md) →
