---
name: triage
description: "Triage an upstream podman-desktop issue: dedup, classify, draft requirements, and pick a route. Without an issue number, shortlist what is worth taking."
argument-hint: "[<issue-number|url>] [--label <a,b>]"
disable-model-invocation: true
model: opus
---

Decide whether planning is needed at all. Half the value of this plugin is
here — the other half is spent by people who skipped it.

## 0. No issue number? Then the question is which one

Skip this section when you were given an issue. When you were not, the job is
scenario 6: not "take this issue" but "what is there to take".

`pdkit issue list [--label a,b] [--limit 20]` prints the open backlog with the
facts that decide whether an issue **can be started**: pull requests that
reference it in this repository, who it is assigned to, whether a maintainer
answered, whether a bug carries a reproduction, and how long since a human —
not the stale bot — last touched it. `·` marks the ones something blocks.

That listing is an order over facts. It does not know the thing that actually
decides, and you do:

1. **Read the top few bodies, not all of them.** Three to five, with
   `pdkit issue fetch <n>`. The listing exists so that you do not read twenty.
2. **Judge what no grep judges** — whether the requirement is clear enough to
   plan against, whether the reported behaviour is specific enough to verify,
   and roughly how big it looks. A well-formatted issue that says "improve the
   UX" is not ready; a free-hand one with a stack trace and a file path is.
3. **Say what is blocked and why**, rather than silently dropping it. An issue
   with an open PR is not a bad issue, it is a taken one, and the difference
   matters when that PR goes stale.
4. **Offer a shortlist of three at most**, each with one sentence on why it is
   on the list and one on what is unclear about it. Then ask which to triage.

Nothing here writes anything or moves any issue. Listing is a read; picking is
the user's. When they pick, continue from section 1 with that number.

## 1. Read, and dedup before anything else

`pdkit issue fetch <n>` prints the issue and every pull request that
references it, in any state.

Act on that before analysing anything:

- **an open PR** → the work exists. Report it and stop. Duplicating it is the
  most expensive possible outcome.
- **a merged PR plus a revert** → route `redo`, and the archaeology comes
  first. See section 5a: this is not a normal triage with extra reading.
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

**A valid, reproducible bug whose cause is outside this repository is not
`invalid`.** It is an ordinary route until the investigation says otherwise, and
what changes is where it ends: the state `answered`, and a findings artefact
instead of a diff. Do not decide this at triage — on #18284 the report reads as
a plain bug and the version skew behind it only appeared once someone had built
the machine and run the pull. Section 5b is where that lands.

## 5b. When the answer turns out not to be a diff

Some issues are real, reproducible, and not ours to fix in code: the cause sits
in a dependency, in the host, or across a version boundary the product only
drives. The deliverable is then a reproduction, a way to tell this problem from
the ones it resembles, and a workaround — published as a comment.

The machine has a state for it, and it is guarded by the same rule as PASS:

```
pdkit validate attach --issue <n> --title "<what this step shows>" --run "<command>"
pdkit findings new --issue <n> --values <file.json>
pdkit state <n> --to answered --reason "<what the answer is>"
```

Three things this route asks that are easy to skip:

1. **Run the workaround, do not reason it out.** `answered` is refused while
   nothing is captured, and that refusal is the point: a workaround nobody
   executed is a suggestion, and a suggestion posted in the voice of a finding
   costs the reporter their evening.
2. **Give them a detector.** One command whose output separates this problem
   from its look-alikes. Without it, every reader with a similar symptom runs
   the workaround and half of them are fixing something else.
3. **Answer the product question.** An environmental cause is a reason not to
   change this repository — not a reason for the repository to say nothing. On
   #18284 the client is 6.0.1, the machine is 5.8.2, and Podman Desktop shows
   both without a word. Name that, and whether it should be its own issue.

`answered` is **not** the end. It means the findings are out and the reporter
has not spoken; from there the issue is `resolved` when someone confirms, back
to `planned` if the answer implied product work, or `abandoned` if it goes
quiet. Closing it on our own say-so would make the plugin the judge of whether
someone else's problem went away.

## 5a. On the redo route only

Work that was landed and backed out is not ordinary work with more history
attached. The reason it was reverted is a requirement, and it was written down
at the time — rediscovering it by re-implementing is what this route exists to
prevent.

```
pdkit issue history <n>
```

One call brings back the attempt, the pull request that reverted it, how long
it lived in the base branch, what reviewers said, what merged in those files
afterwards, and what could not be established. It writes `archaeology.json`,
and **`pdkit` refuses to leave `triaged` on this route until that file
exists** — not as ceremony: the ordering in scenario 10 is the whole point of
the route, and an ordering held by a sentence in a prompt is an ordering.

Then dispatch `pd-archaeologist` with the issue number. It reads the facts and
answers what they cannot: why it was reverted, what reviewers objected to,
whether that objection still applies, and what this attempt has to do
differently. Its report goes in `archaeology.md`.

Two things to carry into the requirements, and they are easy to lose:

- **The regression is a requirement too.** Whatever the revert was filed
  against belongs in the R-set alongside the original ask, or the redo lands
  and is reverted for the same reason.
- **A blocking objection to the approach means the plan is different, not
  longer.** If a reviewer said "this seems really hacky, it should not be
  merged", re-submitting the same approach with better tests is a slower way to
  be reverted again.

## 6. Record

Render `templates/issue.md` with `pdkit render issue --issue <n> --values <f>
--path issue.md`, then `pdkit state <n> --to triaged --route <route>`.

The route is recorded there, not implied: `standard`, `quickfix`,
`multi-slice` or `redo`. `invalid` is not a route — an issue that should not be
worked on goes to `pdkit state <n> --to abandoned` with the reason, and the
draft comment stays for a human to post.
