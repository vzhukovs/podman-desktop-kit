---
name: plan-review
description: "Adversarial review of a plan, before any code is written."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: opus
effort: high
---

Fresh context, via `pd-plan-critic`. The author of a plan is the worst reviewer
of it.

Machine first, then the model. In that order, and the order is the point.

## 0. The plan this round reads

```
pdkit plan snapshot <n>
```

Before anything reads the plan: it copies `plan.md` and `tasks/` to
`reviews/r<k>/`, `k` being this round, and the next round compares the plan
with that copy. Nothing else writes under `reviews/`. Run again in the same
round it changes nothing, unless the plan changed before this round's report
was written — then the copy is of the plan as it is now.

## 1. The mechanical failures

```
pdkit plan check <n>
```

Sections present; `Owns` exclusive between tasks; `Done when` a command rather
than prose; every R-ID closed by a task and every task pointing at a real R-ID;
`e2e coverage` decided; `Slice hypothesis` written; no `[NEEDS DECISION]` left.

None of these need judgment, and none of them should cost any. An Opus asked
to intersect two lists of paths is an Opus that can fail to; `pdkit plan check`
cannot. Red here means the plan gets **redone rather than patched** — these are
the requirements from `/pd:plan`, not preferences.

Its warnings include the probe: every live task whose `Done when` was never
run, was run as a different command, or did not exit 0 on the base commit. A
task never run is run now, before the critic starts:

```
pdkit plan probe <n> --task <the tasks it names>
```

from the main checkout. An approved plan once stopped five times in exec on
commands nobody had run; the critic reads, and does not run.

## 2. The question nothing else asks

What it is for: **is this task necessary at all, and does something already do
it?** podman-desktop is large, utilities get duplicated between `packages/main`
and `packages/renderer`, and reviewers push back on it. Catching that here costs
a conversation; catching it in review costs a rewrite.

### Full or delta

```
pdkit plan diff <n> --json
```

It compares the plan with the snapshot of the plan the last round read.

- **Delta** when `base.round` equals `lastRound` — the plan the last round
  read was kept — and `structural` is `false`: one critic, with
  `pdkit plan brief <n> --mode delta`. Its brief carries the diff, the last
  round's decisions, and each changed task with its neighbors: its `After`
  both ways and the frozen interfaces it shares. The critic checks that each
  accepted decision is in the plan, with `file:line`; then the changed blocks
  and their neighbors — `Owns`, `After`, `Done when`, requirement coverage;
  and outside the change, only a defect that would stop exec, as an A item
  headed `Outside the delta:` with its evidence.
- **Full** otherwise: the first round; a last round whose plan was not kept;
  or a structural change — a task added or removed, `Frozen interfaces` or
  `Slice hypothesis` changed. A delta there would say the rest of the plan was
  reviewed when what it rests on has changed, and the brief refuses it.

A repeat round reviewed whole costs about what the first did, and most of what
it reads it read last time; a full round where a delta is possible is the
person's call, not yours.

### One critic or several

A full round — the brief's default mode — reviews the whole plan, and one
critic does not hold a large one. On a plan of a dozen tasks a single critic
reached the ceiling of its context every round and read a different part of
the plan each time, so findings that had been in it from the first round
surfaced one round at a time. So first:

```
pdkit plan areas <n> --json
```

- **Four live tasks or fewer, or one area besides `gate`**: one critic, with
  `pdkit plan brief <n>`.
- **Otherwise**, group the areas, and launch every critic **in one message**,
  so they run side by side:
  - one critic per group: `pdkit plan brief <n> --area <a>,<b>`;
  - one more across the whole plan: `pdkit plan brief <n> --axis duplication`.

Grouping the areas, into three groups at most:

1. Areas that share a task are one group. The task is one change, and its
   contract is read on both sides of it.
2. While more than three groups remain, join the two with the fewest tasks.
   `gate` counts as a group of its own.
3. Every area is in exactly one group. An area is never split between critics.

### The brief

Each critic's prompt is its brief, **passed as it is**: the scope with its
tasks and the edges that leave it, where the plan, the research and the code
are, the report from step 1 with every probe warning and its last line, what
the last round accepted and every round rejected, and the shape of the report
with its coverage map. Fill in its `Language:` line with the language the
person reads, and change nothing else.

You may append one section, `## Orchestrator facts`: facts you verified in
this session, each with `file:line`. Nothing on where to look or what to focus
on, and nothing asking the critic to converge or not to pad. What a critic
finds follows what its prompt mentions, so a hint is a choice of findings made
before the review; its checklist is in its own definition.

## 3. The report

`plan-review.md` under the issue. If one is already there from an earlier
round, move it to `plan-review.r<k>.md` first, `k` being its round, so every
round keeps its own file and `plan-review.md` is always the latest. Title it
`# PLAN REVIEW: DESKTOP-<n> — round <k>`, and under the title write the mode,
full or delta, and why, as the brief's Mode section gives it. In a delta
round, an item outside the delta keeps that mark in the merged report.
Structure it as: what must change
before approval (A1, A2…), what is worth discussing (B1…), and what the
reviewer could not judge from the plan alone (C1…), then the sections the
brief asks of a critic.

With one critic, its report is the review. With several, wait for every one of
them, then merge their reports into one:

- **Numbered again**, A1, A2… across the merged report, each item naming the
  scope of the critic that raised it.
- **One defect, one item.** The same finding from two critics is one item, in
  the more severe of their sections, with both citations.
- **A disagreement is shown, not settled.** When two critics contradict each
  other — one says it must change, another checked the same thing and says it
  holds — it is one item with both positions, each with its `file:line`, in the
  more severe section. Which one is right is the person's call, not yours.
- **Outside a critic's scope.** A line the critic of that scope also raised is
  dropped. One it did not raise is a C item naming the critic that saw it.
- **Probes, decisions of the last round, checked without findings**: the union.

Then `## Coverage map`, after C and before any decisions: a row per task in
the round's scope — every live task in a full round, the changed ones in a
delta — the columns of the critics' maps. A cell is `✓` when any critic made
the check, `—` when none did and one found it does not apply, and `?`
otherwise. Every `?` is a C item of its own,
`### C<k>. <T-ID> — <column>: not checked`, with one critic as with several:
a part of the plan nobody read is then a line the person decides on, not a
finding a later round turns up.

An empty "must change" section is a valid result. A critic that finds something
wrong with every plan is one nobody reads by the third time.

## 4. The decisions

When the person has decided, write the decisions into `plan-review.md` as the
last section, in exactly this shape — `pdkit next` reads the heading, and
`/pd:plan` reads the lines:

```
## Operator decisions (round <k>)
- A1: accepted
- A2: accepted, variant (a) — <what the variant is, in one line>
- B1: accepted — <the change, if the finding left a choice>
- B3: rejected — <why, in the person's words>
- B4: no decision
```

One line per item, every item in the report, the person's own qualifiers kept.
Nothing here edits the plan: applying the decisions is `/pd:plan`'s, in a new
session, with nothing to paste after the command.

Then the accepted A items that state a fact about the repository rather than
about this plan: what a loader requires, which modes a suite runs in, what a
directory's `AGENTS.md` obliges — not "T4 runs before T6". Propose each to the
person as a knowledge candidate, in one line: the fact as an entry would state
it, with its `file:line`, and the file of `${CLAUDE_PLUGIN_ROOT}/knowledge/`
whose `## What to add here` it meets. Check the line against the code first: an
item accepted for this plan is not yet a verified fact. Nothing records a
candidate; the ones the person wants are theirs to take to `/pd:knowledge`.

When the report has no A item, or the person rejects every one, tell them
before they decide the B items: the ones they accept will be applied and go to
approval without another round, unless applying them changes a task's Owns,
After, Done when, Satisfies or Slice, the set of tasks, Frozen interfaces or
the slice hypothesis. `pdkit plan revised` measures that against this round's
snapshot once the revision is done. An A item left with no decision sends the
plan to another round as an accepted one does. A round can still be asked for:
`/pd:plan-review <n>` runs whenever it is invoked.

## State

None. `plan check` failing is not a state transition — it is a plan that goes
back to `/pd:plan`. Approval stays a human action, and only after it:
`pdkit ids freeze <n>` and `pdkit state <n> --to plan-approved`.

## Next, when something must change

`/pd:plan <issue>`, in a new session, and nothing after the issue number. With
the decisions in `plan-review.md`, `pdkit next <issue>` prints exactly that,
and `/pd:plan` starts in its revision phase: it reads the decisions, applies
the accepted ones, re-probes what changed, and runs `pdkit plan revised`. That
prints what follows: `/pd:plan-review` again when an A item was accepted or
left undecided, or the revision changed what execution reads — the fields named
in section 4 — and otherwise the approval, which stays the person's. Do not
compose a paragraph of context for the person to paste: it is a second,
unreviewed copy of the decisions, with line numbers the next edit moves.

## Next, on approval

`/pd:exec <issue>`, once approval has been given and the state moved. It is
spelled `exec` rather than `implement` — the state it produces is `implemented`,
and that is the one place in the chain where the state and the command are not
the same word.

**In a new session.** Exec is the longest phase in the chain — several turns per
task, for every task — and whatever this one leaves in context is re-read on
each of them. It starts from `plan.md` and the task files; the critic's case is
in `plan-review.md`, and the approval is in the state record. The SessionStart
summary names the command once the tree is on the issue's branch, and
`pdkit next <issue>` does anywhere.
