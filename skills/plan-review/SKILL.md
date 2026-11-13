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
`# PLAN REVIEW: DESKTOP-<n> — round <k>`. Structure it as: what must change
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

Then `## Coverage map`, after C and before any decisions: a row per live task,
the columns of the critics' maps. A cell is `✓` when any critic made the check,
`—` when none did and one found it does not apply, and `?` otherwise. Every `?`
is a C item of its own, `### C<k>. <T-ID> — <column>: not checked`, with one
critic as with several: a part of the plan nobody read is then a line the
person decides on, not a finding a later round turns up.

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

## State

None. `plan check` failing is not a state transition — it is a plan that goes
back to `/pd:plan`. Approval stays a human action, and only after it:
`pdkit ids freeze <n>` and `pdkit state <n> --to plan-approved`.

## Next, when something must change

`/pd:plan <issue>`, in a new session, and nothing after the issue number. With
the decisions in `plan-review.md`, `pdkit next <issue>` prints exactly that,
and `/pd:plan` starts in its revision phase: it reads the decisions, applies
the accepted ones, re-probes what changed, and runs `pdkit plan revised`. Then
`/pd:plan-review` again. Do not compose a paragraph of context for the person
to paste: it is a second, unreviewed copy of the decisions, with line numbers
the next edit moves.

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
