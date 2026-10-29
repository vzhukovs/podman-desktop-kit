# 10. Scenario coverage

[Specification](README.md) › Section 10

| Scenario | Route |
|---|---|
| 1. Bug fix | `triage` → `plan` → `plan-review` → `exec` → `validate` → `audit` → `slice` (usually 1) → `preflight` → `pr` |
| 2. One-line fix | `triage` → **`quickfix`** → `preflight` → `pr`. Planning is skipped deliberately |
| 3. New feature | the full path; `slice` will almost certainly produce 2–5 pull requests |
| 4. Improving something that exists | the full path; `plan` must separate the refactor from the new behaviour — they become separate slices |
| 5. Resuming after a break | `sync` → **`resume`** → `pr-sync` → `preflight` → `pr` |
| Reviewing somebody else's PR | `review-pr` — outside the issue lifecycle entirely |

## Scenarios the brief did not name

| # | Scenario | How it is covered |
|---|---|---|
| 6 | **Choosing an issue from the backlog.** Not "I am taking this issue" but "which one" | `/pd:triage` with no number → `pdkit issue list`. Readiness to start is measured mechanically; clarity of the requirement stays with the model, and the choice with the human |
| 7 | **Dependency bump.** A mechanical diff whose real risk is breaking changes in transitive dependencies | **Struck by measurement.** In this repository bumps are dependabot's work: of 200 merged pull requests, 88 are bots (dependabot alone: 84), and of the 112 human ones exactly three concern dependencies — all three within `quickfix` thresholds. A fifth route for 2.7% of human pull requests, each already served, is a key with no work behind it. What remains and fires for anyone: the lockfile is a `ci-blind-spots` area, so a PR that moved dependencies cannot reach review without saying what was checked; `dep-bump` remains a **nature** at triage, because a nature describes the issue rather than the way of doing it |
| 8 | **Bulk mechanical refactor** across independent packages | **No special machinery, and none is being built.** In the same sample the largest human pull request is 32 files and lives inside one layer; so do the mechanical ones. `max_files_per_slice` turns a large set into a conversation rather than a refusal, and proposing a graph by hand was never blocked. Per-package slicing and "equivalence of build output" are struck as mechanisms for a scenario the upstream population does not contain |
| 9 | **CI red, local green.** Upstream's CI is multi-platform; Windows/macOS-only failures are normal | `/pd:pr-status` measures whose the red job is and fetches the failure text for the ones that are ours; a separate `ci-triage` lane distinguishes platform difference / flake / real regression. "Re-run it" is not an answer — it hides the information the lane exists for |
| 10 | **The PR was closed by a maintainer, or the change was reverted.** A redo needs archaeology | the `redo` route. The machine half is `pdkit issue history <n>`; the ordering "archaeology before any implementation" is held by the state machine, not by a prompt |
| 11 | **The issue turned out to be invalid** | the `invalid` route: a draft comment, published by hand |
| 12 | **A change to the public extension API** | not a separate command but a mandatory sub-mode, triggered by the fact that `extension-api.d.ts` was touched. It adds backwards-compatibility and disposal checks, and is always carved into a separate first slice |
| 13 | **Upstream asks for an already-open PR to be split** | `slice suggest --from-pr <n>`: the same slicer, with a published diff as its input; the output is a graph plus a plan for migrating review threads into the new pull requests |
| 14 | **There is an answer, and no diff.** The bug is real and reproducible, and the cause lives outside the repository — in a dependency, in the host, or across a version boundary the product merely triggers | the `answered` state plus `findings.md`: reproduction, detector command, workaround, and the question "what would have kept this from reaching a user". Entry requires a capture: a workaround nobody ran is a suggestion, and a suggestion posted in the voice of a finding costs the reporter their evening. A human publishes it; `gh issue comment` is denied by the hook from every state |
| 15 | **The cycle itself went wrong.** Not the diff and not the review — the triage read the issue as something it is not, or the scouts mapped the wrong package, and everything after inherits it, because everything after reads what came before | `/pd:reset <n>`: one issue forgotten, none of its neighbours touched, and the record **removed rather than transitioned**, so the machine reads `new` and triage is the only exit. Deliberately distinct from the three outcomes it is easy to confuse with — `rework` (a reviewer refused the approach; their objection is the most valuable thing the review produced, and a reset would throw it away), `redo` (it was tried and reverted; the archaeology is the whole point) and `abandoned` (the work was dropped, and why is worth keeping). Nothing upstream moves and the journal keeps everything, so what is forgotten is our reading of the issue, not the issue's history |

Scenario 13 is worth holding in mind when reading the slicer: it must work not
only from the local `HEAD` but from an arbitrary diff. And "work" means in
**every** command the cut passes through, not just the one that draws the draft.
A dry run found the substitution living in `slice suggest` alone, so a proposal
drawn from a published PR was checked by `slice set` against `main...HEAD` and
rejected one file at a time. A flag that redirects the source in one command of a
chain is not half a feature; it is a feature that does not work.

---

**Every scenario in full** — [`workflows/`](../workflows/README.md): the commands and the decision points of each use case.

← [9 · Configuration](09-configuration.md) · [Contents](README.md) · [11 · Known weaknesses](11-known-weaknesses.md) →
