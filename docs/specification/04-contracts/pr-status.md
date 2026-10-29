# `/pd:pr-status` — the dashboard, and how a red CI is measured here

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:pr-status`

`pdkit pr list` returns facts for every registered pull request: slice, branch,
base, review decision, unresolved thread count, how far behind the base, how long
since anything moved. All reads; no state moves.

**The age of the reading is a column too.** Every field is what the last refresh
saw, and a ten-PR sweep costs 37 seconds, so nobody refreshes everything before
every glance: a stale row is the normal case. A three-day-old verdict used to
print identically to a one-second-old one; the row now ends in `read:<age>`, with
`←` past six hours. Same principle as `inconclusive` below: a measurement must say
what it did not see.

**There is no cache here, and that is a measurement rather than an omission.**
`pr refresh` costs 3 GraphQL points and 2.3 s on a green PR, 4 and 7.2 s on a red
one; a sweep of ten is 32 points against an hourly budget of 5000. Seconds are the
constraint, not the budget. The conditional refetch keyed on `updatedAt` that
suggested itself is refuted on its own terms: on eight of eight upstream PRs with
recent runs, CI finished **after** `updatedAt`, by 2.5 to 37 minutes. The
timestamp follows people, so that refetch would skip exactly the pull requests
whose CI verdict just changed.

The only non-trivial part is a red job. **A red CI has two possible causes and
they are told apart by measurement, not by reasoning:**

| Outcome | How it is reached |
|---|---|
| `fail` — we broke it | red here and green across the peers |
| `inconclusive` — red without us | the same job red on **other people's open upstream PRs**. Warn, not fail: blocking over what the change did not do teaches people to route around the gate |
| `flake` | the same job on the same commit reached different conclusions in different runs |
| `pass` | green |

**The baseline is the peer population, not the base branch, and that too is a
measurement.** podman-desktop runs `pr-check` on the `pull_request` event, so
those jobs never run on `main` at all and a base comparison would return "no such
job on the base" for every check — that is, `inconclusive` on everything. One
`gh pr list --json statusCheckRollup` over fifteen open PRs costs about two
seconds and shows immediately that `windows-11-arm update e2e tests` is red for
several independent authors at once.

**And what is left to the model is answered by the failure text, not the job
name.** Returning a verdict and a link asks the model to tell a platform
difference from a regression by the word "Windows" — exactly the reasoning-
instead-of-reading this plugin exists to replace. `pdkit pr ci` fetches
`--log-failed` for the jobs the measurement calls **ours**: `inconclusive`
describes somebody else's problem and `flake` is already the finding, so neither
pays for a request.

**The window is anchored on the error marker, and that is a measurement too.**
The first version took the tail. On #18590 the `##[error]` marker sits fifty lines
from the end of a 245-line log, and everything after it is the runner removing
credentials: a forty-line tail showed all cleanup and nothing about the failure,
confidently and with no sign of a miss. The real cause was
`E: Package 'qemu-user-static' has no installation candidate` — infrastructure,
which no reading of the diff would ever have found. What falls outside the window
is counted at **both** ends: a window that reports what it cut from the front and
stays silent about the back implies the log ended there. With no marker to anchor
on, the report says the window is the end of the file and may not be the failure.

The log is not stored. It expires, and a stale copy beside the verdict would
carry the verdict's standing — the freshness problem slices answered with a
digest rather than by keeping more.

---

**In practice** — [`workflows/`](../../workflows/README.md):

- [§7 — A pull request that has gone stale](../../workflows/07-stale-pr.md)

← [`/pd:pr`](pr.md) · [Contents](../README.md) · [`/pd:pr-sync`](pr-sync.md) →
