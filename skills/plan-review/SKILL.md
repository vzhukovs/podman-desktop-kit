---
name: plan-review
description: "Adversarial review of a plan, before any code is written."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: opus
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

None of these need judgement, and none of them should cost any. An Opus asked
to intersect two lists of paths is an Opus that can fail to; `pdkit plan check`
cannot. Red here means the plan gets **redone rather than patched** — these are
the requirements from `/pd:plan`, not preferences.

## 2. The question nothing else asks

Give `pd-plan-critic` the plan **and the report from step 1**, so it does not
spend its context rediscovering what a grep already found.

What it is for: **is this task necessary at all, and does something already do
it?** podman-desktop is large, utilities get duplicated between `packages/main`
and `packages/renderer`, and reviewers push back on it. Catching that here costs
a conversation; catching it in review costs a rewrite.

## 3. The report

`plan-review.md` under the issue. Structure it as: what must change before
approval, what is worth discussing, and what the reviewer could not judge from
the plan alone.

An empty "must change" section is a valid result. A critic that finds something
wrong with every plan is one nobody reads by the third time.

## State

None. `plan check` failing is not a state transition — it is a plan that goes
back to `/pd:plan`. Approval stays a human action, and only after it:
`pdkit ids freeze <n>` and `pdkit state <n> --to plan-approved`.
