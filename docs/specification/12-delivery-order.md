# 12. Delivery order

[Specification](README.md) › Section 12

Not everything at once. By decreasing return, each stage independently useful.

| Stage | What | Gives | Readiness signal |
|---|---|---|---|
| **0** | the `pdkit` skeleton: `state`, `ids`, `init`, `doctor`; the `plan.md`, `receipt.md`, `pr-body.md` templates; `knowledge/upstream-rules.md` | the frame everything else hangs on | `pdkit doctor` green on a real fork |
| **1** | the single-PR backbone: `sync`, `triage`, `plan`, `exec`, `preflight`, `pr` (gate + hooks), `quickfix` | [scenarios 1 and 2](10-scenarios.md) end to end | one real bug fix carried to an open upstream pull request |
| **2** | quality: `plan-review`, `audit`, the `Write`/`Edit` hook on `Owns`, receipts as a hard gate | drift from the plan stops reaching a pull request | the auditor caught a divergence the implementer did not notice |
| **3** | **slicing**: `slice`, standalone verification, worktrees, `slice cascade` | the key feature: one change set → N atomic PRs | one change set cut into 3 PRs, each standalone green |
| **4** | the PR lifecycle: `pr-status`, `pr-sync`, `resume`, `close`, `--from-pr` | [scenarios 5 and 13](10-scenarios.md); pull requests stop rotting | a stale PR carried to re-review without unpicking threads by hand |
| **5** | `validate` + Playwright + e2e generation, `review-pr`, `knowledge` | evidence instead of claims; e2e as a useful by-product; reviews of other people's PRs | an e2e test written by the plugin survived three runs and travelled upstream with the feature |

**Stage 3 cannot precede stage 1.** Slicing without a working single-PR backbone
is not verifiable: there is nothing to verify it on.

One fork in the road had to be settled before any code: **skills or commands.**
The direction of the ecosystem is skills, and the answer was `skills/` only —
orchestrating ones with `disable-model-invocation: true`, knowledge ones
phrase-triggered. Shipping `commands/` as well would be two sources of truth for
one behaviour.

---

← [11 · Known weaknesses](11-known-weaknesses.md) · [Contents](README.md) · [13 · Status](13-status.md) →
