# `/pd:review-pr <pr#>` — reviewing somebody else's pull request

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:review-pr`

The machine goes first here as well. `pdkit review fetch <k> [--json]`:

| Collected | Why |
|---|---|
| the diff `merge-base...refs/pull/<k>/head`, locally | against the tip of `main` it would carry every commit landed since, and the review would ask the author about work they never did |
| files → packages → layers | how many layers are mixed in one PR is the main cause of slow review |
| whether `extension-api.d.ts` is touched; diff exports found in it | the `RunOptions` trap in somebody else's PR is the same trap as in ours |
| schemas changed without `generate:schemas` | an upstream rule, living in `lib/upstream.js` |
| SPDX on added files | the same |
| the linked issue and its text | without it, `Requirement fit` is filled with nothing but guesses |
| review threads that already exist | so four axes do not repeat what reviewers said last week |
| CI status | a red CI is not a reviewer's finding, but it is context for one |

**Commit scope is not checked here.** Upstream does not require it; scope is our
own discipline, and spending an author's attention on a rule their project does
not have is how a review loses the standing to raise the ones it does.

Then four axes in parallel, each its own agent, each seeing the diff and the
target files:

| Axis | Agent | Looks for |
|---|---|---|
| Architecture fit | `pd-review-architecture` | does it sit in existing patterns; does it duplicate a utility; correct layer; coupling and dependency direction |
| API & compatibility | `pd-review-api-compat` | `extension-api.d.ts`; backwards compatibility; `Disposable` and leaks; schema changes without regeneration |
| Tests & quality | `pd-review-tests` | are the claimed edge cases covered; workarounds (`skip`, weakened asserts, `any`, `@ts-ignore`); test determinism |
| Product & UX | `pd-review-product` | fit to the issue; i18n, a11y, contrast; error and empty states; regressions in neighbouring flows |

`pd-review-synth` (opus) deduplicates, prioritises and reaches a verdict.

**Reviewer discipline, straight from experience: a reviewer told to find problems
will find them in correct code.** So the axis prompts forbid reporting style,
demanding defensive code for impossible cases, and "this could be more abstract".
**An empty section is a valid result.** And `What I could not verify` is
mandatory, against false confidence.

The report lands in `reviews/<pr>.md` and **is not published**. A comment on
somebody else's PR is an outward write, which needs a `reply` token, and a review
of a foreign PR is tied to no issue and therefore to no state such a token could
be issued from. A human publishes it, in their own words and under their own
account.

---

**In practice** — [`workflows.md`](../../workflows.md):

- [§13 — Reviewing someone else's pull request](../../workflows.md#13-reviewing-someone-elses-pull-request)

← [`/pd:reset`](reset.md) · [Contents](../README.md) · [`/pd:knowledge`](knowledge.md) →
