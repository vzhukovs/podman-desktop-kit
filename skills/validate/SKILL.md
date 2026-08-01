---
name: validate
description: "Drive the built application, collect evidence, and propose an e2e test."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: sonnet
---

Via `pd-validator`, against a running application.

Evidence or nothing. Reading the source and concluding it works is explicitly
not validation, and there is no way to record PASS on that basis — the outcome
of a step comes from what is attached to it, and `pdkit validate attach` has no
`--status`.

## Preconditions

`pdkit state <issue>` says `implemented`. Validating a change that is still
being written means validating something nobody will ship.

## 1. What is waiting

```
pdkit validate steps --issue <n>
```

The requirements, the tasks with the command each said it would be done by, the
plan's `e2e coverage` decision, and whatever is already attached.

Turn that into scenarios. This is the part the tests do not reach: a task's
`Done when` proves the unit works, and what is left is whether a person using
the application gets what the issue asked for.

## 2. The application

```
pdkit validate launch --issue <n> [--build]
```

Prints a CDP endpoint. Playwright MCP attaches to it — configure the server with
`--cdp-endpoint`; pdkit starts the application and does not connect to it.

`--build` first when the tree is stale. `/pd:doctor` says whether there is
anything to drive at all, which is a different problem from Playwright being
absent and has a different fix.

Stop it when you are done: `pdkit validate stop --issue <n>`.

## 3. Drive it, and attach what you see

```
pdkit validate attach --issue <n> --requirement R2 \
  --title "the dialog does not reappear" \
  --expected "no dialog on the second launch" \
  --observed "no dialog; screenshot attached" \
  --evidence /tmp/second-launch.png
```

Measured values, not impressions. "The contrast is sufficient" is an opinion;
`4.6:1` with the screenshot it was read from is evidence.

A step with an artefact and nothing said about it does not count — the artefact
shows something, and which something is yours to state.

## 4. Codify it

```
pdkit validate codify --issue <n> --spec tests/playwright/src/specs/<name>.spec.ts
pdkit validate run    --issue <n>
```

Write the scenario you just performed as a test, then run it. **That run is what
PASS rests on.** A checklist is verified once, by one person, today; a test is
verified by CI on every pull request that follows.

Then prove it is not a flake:

```
pdkit e2e stability --issue <n>
```

Three runs in a row, and the series stops at the first red. A flake carried into
someone else's repository is the worst thing this workflow can deliver, and
preflight will not accept a series recorded against a spec that was edited
afterwards.

On the `quickfix` route no e2e is added at all — it inflates review and CI time,
which is the opposite of what a small pull request is for.

## 5. Close it out

```
pdkit validate finish --issue <n>
```

Writes `validation.md` and moves the issue. Three outcomes:

- **pass** — every step has an artefact.
- **fail** — a captured run came back red. The issue does not move; that is a
  finding about the change, not about the process.
- **unverified** — steps nobody could demonstrate. The issue **does** move.

## When you could not demonstrate something

Say so, and say it where a reviewer will read it. `unverified` does not block
the pipeline — without Playwright there would be no way out of `implemented`,
and a gate that expensive gets routed around — but it does not evaporate
either: `validation-evidence` in preflight refuses a pull request body that
does not name what was left unchecked, under `Notes for reviewers`.

An unverified step nobody mentions reads exactly like a verified one. That is
the whole reason the check exists.

## What not to do here

Do not record PASS from reading code. There is no input for it, and
constructing one — attaching a file that says "looks correct" — is the same act
as writing a receipt by hand.

If the application could not be driven at all, produce the human checklist,
attach nothing, and let the outcome be `unverified`. An honest gap is useful; a
fabricated pass is worse than no validation at all.
