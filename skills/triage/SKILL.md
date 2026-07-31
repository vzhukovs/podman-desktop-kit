---
name: triage
description: "Triage an upstream podman-desktop issue: dedup, classify, draft requirements, and pick a route."
argument-hint: "<issue-number|url>"
disable-model-invocation: true
model: opus
---

Decide whether planning is needed at all. Half the value of this plugin is
here — the other half is spent by people who skipped it.

## 1. Read, and dedup before anything else

`pdkit issue fetch <n>` prints the issue and every pull request that
references it, in any state.

Act on that before analysing anything:

- **an open PR** → the work exists. Report it and stop. Duplicating it is the
  most expensive possible outcome.
- **a merged PR plus a revert** → route `redo`. The archaeology comes first:
  what the original PR did, why it was reverted, what regressed. `redo` is not
  implemented before stage 4 — say so and stop rather than improvising.
- **a closed PR without a merge** → read why it was closed. A maintainer who
  rejected the approach once will reject it again.

## 2. Locate, do not read

Two or three `pd-scout` agents in parallel, different questions each: where
the behaviour lives, what already exists that resembles the fix, how that area
is tested. They return a map, ≤ 40 lines, every claim carrying `file:line`.

Do not read the code broadly yourself. The compression is the point — if you
read what the scouts read, you have paid twice for one answer.

`pdkit packages --of <path>` turns a path into its package and layer.

## 3. Classify

**Nature:** bug, feature, enhancement, tech-debt, dep-bump, docs.

**Size:** `trivial` only when all of these hold — estimated diff ≤ 20 lines,
≤ 3 files, nothing under `packages/extension-api`, no schema change, no new
dependency. Anything else is `standard` or larger.

## 4. Draft the requirements, with a source tag on every line

- `[issue]` — stated in the issue, in its words
- `[paraphrase]` — the same thing, reworded
- `[inferred]` — you concluded it

**Read the `[inferred]` list back to the user before writing anything to
disk.** Show it on its own, not buried in a summary. This is the cheap defence
against requirements the plugin invented, and it only works if the list is
short enough to actually read — if it is long, that is itself the finding.

Allocate with `pdkit ids requirement <n>` once the set is agreed. **Not on the
quickfix route**: it allocates nothing there, and the CLI refuses if you try.

## 5. Verdict

State one route explicitly:

| Route | When |
|---|---|
| `quickfix` | trivial by the thresholds above, and the fix is describable in one sentence |
| `standard` | everything ordinary |
| `multi-slice` | the change spans layers that different reviewers own |
| `redo` | a previous attempt was reverted |
| `invalid` | duplicate, already fixed, or not reproducible |

`invalid` is a result, not a failure. Its output is a **draft comment** for the
issue. Do not post it — publishing to someone else's tracker is a human action,
and the gate refuses it anyway.

## 6. Record

Render `templates/issue.md` with `pdkit render issue --issue <n> --values <f>
--path issue.md`, then `pdkit state <n> --to triaged`.
