# 1. Domain model

[Specification](README.md) › Section 1

The unit of work is an **upstream issue**. Not an epic, not a spec, not a PRD.
An issue has:

- a **nature** (bug / feature / enhancement / tech-debt / dep-bump / docs) and a
  **size** (trivial / standard / multi-slice), both decided at triage, and
  together they pick the route;
- an **R-set** — numbered requirements `R1..Rn`, frozen once the plan is approved;
- a **plan** — how it will be built, with a file-ownership map and executable
  done-criteria;
- a **slice graph** — how one change set becomes N atomic pull requests;
- a **set of pull requests**, each with its own lifecycle (CI, review threads, merge).

## The state machine

Transitions are permitted by `pdkit`, never by an agent.

```
new
 └─ triage ──────────────► triaged
                            ├─ (trivial) ──────► quickfix ──┐
                            └─ plan ──► planned              │
                                         │                   │
                              plan-review│                   │
                                         ▼                   │
                                   plan-approved  ◄── human  │
                                         │                   │
                                      exec                   │
                                         ▼                   │
                                   implemented               │
                                         │                   │
                                   validate                  │
                                         ▼                   │
                                    validated                │
                                         │                   │
                                     audit                   │
                                         ▼                   │
                                     audited                 │
                                         │                   │
                                     slice                   │
                                         ▼                   │
                                sliced ─► slices-approved ◄── human
                                         │                   │
                                  preflight ◄────────────────┘
                                         ▼
                                 preflight-green
                                         │
                                    pr (GATE)  ◄── human, in the same turn
                                         ▼
                                   pr-open ──► review-in-progress ⇄ pr-sync
                                         ▼
                                     merged | abandoned

     slices-approved ─┐
     preflight-green ─┤
     pr-open ─────────┼─► sliced   (re-cut: `slice join`, with --reason)
     review-in-progress ┘

     triaged ─┐
     planned ─┴─► answered ──► resolved | planned | abandoned
                (the answer is published; we are waiting on the reporter)
```

## The `answered` branch — an issue whose deliverable is not a diff

It happens more often than it sounds. The bug is real and reproducible, and the
cause lives in a dependency, in the host, or across a version boundary the
product merely triggers. The work then produces a reproduction, a detector
command and a workaround, published as a comment.

Entry is guarded by the same rule as PASS: **`answered` cannot be entered while
nothing has been captured.** What is checked is the presence of a capture under
`validation/` — a file only a real run produces, since `lib/evidence.js` has no
input through which text could be handed to it. The same device holds ordering
on the `redo` route through `archaeology.json`. The guarantee is narrow and is
stated narrowly: a capture happened. That the workaround *works* is not
something code can confirm, and promising it would buy a check that reports on
work it did not do.

**`answered` is not terminal**, and that is a correction a live run made to the
design. A terminal "settled without a diff" was the obvious shape, and it is
wrong: at the moment the findings are posted the issue is not settled, it is
**waiting on the reporter**. The machine could already wait on a reviewer
(`review-in-progress`, `awaiting-review` by domain) and could not wait on a
reporter. Hence three exits, all of which happen: confirmed → `resolved`; the
answer implies product work → back to `planned`; nobody answers → `abandoned`.

`resolved` is deliberately separate from `merged` and from `abandoned`. The
first claims a change landed when none did; the second says the work was
dropped, when here the work *was* the entire deliverable. Either reading would
be false, and nothing on disk would correct it.

## The `rework` edge

From `pr-open` and `review-in-progress` there is an edge back to `triaged`. A
reviewer rejecting the *approach* rather than a detail is an ordinary outcome of
review in somebody else's repository, and without this edge there were two
exits: push again (which assumes the design survived) and abandon an issue still
worth doing.

The edge leads to `triaged` rather than `planned` on purpose: the route is
chosen again, and planning starts from the issue rather than from the rejected
diff — the same ordering `escalate` imposes, for the same reason. The pull
request stays open, the branch stays put, and `--reason` is required.

## The `re-cut` edge

From `slices-approved`, `preflight-green`, `pr-open` and `review-in-progress`
there is an edge back to `sliced`. An approved graph can turn out to be the
wrong one after its pull requests are open: on DESKTOP-19818 review asked for
three of them to become one. `pdkit slice join` re-cuts the graph, and the edge
puts it in front of a human again before anything is cut from it. `--reason` is
required, for the same reason it is on `rework`.

## There is no edge into `new`, and starting over does not add one

A run can go wrong early — the triage reads the issue as something it is not,
the scouts map the wrong package — and then every later step inherits the
mistake, because every later step reads what the earlier ones wrote. The machine
had no answer for that: `new` has no predecessor, so nothing could return an
issue to the state its own artefacts had never been produced in.

Adding such an edge would be the wrong fix, and the reason is the same one
`adopted` exists for. A transition writes history, so an issue that travelled
back to `new` would carry a trip the work never took, and "these artefacts were
never produced" would stop reading differently from "these artefacts were lost" —
which is the distinction every downstream check depends on.

So `pdkit reset <issue>` **removes the record instead of moving it**. With no
`state.json`, `state.read` returns `blank()`, which is the machine's own
representation of nothing has happened here, and `new -> triaged` is the only way
out of it. The contract is in [section 4](04-contracts/reset.md).

## The machine names the next command, not only the next state

`pdkit state` has always been able to say where an issue may go next, and until
0.29 that was all it said: `next: implemented`. That is a **state**, and a state
name in the position where a next action belongs is one that gets typed.

Seven of the eight states in the chain are spelled like the command that reaches
them — `triaged`/`triage`, `planned`/`plan`, `validated`/`validate`,
`audited`/`audit`, `sliced`/`slice`, `preflight-green`/`preflight`,
`pr-open`/`pr`. The eighth is `implemented`, reached by `/pd:exec`. A session on
DESKTOP-18832 finished a plan review, read `next: implemented`, applied the
pattern that holds seven times out of eight, and told the user to run a skill
named after the state — `implement`, under the `/pd:` namespace — which does not
exist.

Nothing in the plugin had contradicted it. Every skill in the chain ended on a
`pdkit state --to` call and named nothing after it: the forward links did not
exist, so `/pd:plan` pointed at `/pd:plan-review`, `/pd:plan-review` pointed back
at `/pd:plan`, and past that the chain simply stopped.

So `lib/state.js` carries `ADVANCES`, a state → skill table, and `nextStep()`
resolves it against the record — against the record rather than the state,
because one answer depends on the route: a `triaged` issue on the quickfix route
goes to `/pd:quickfix`, and sending it to `/pd:plan` is what `escalate` exists to
undo. Three places print it: the transition, the record, and the SessionStart
summary. The skills say it too, but the table is what is printed by the command
the model has just run, whether or not it read anything — the same argument
[section 6](06-hooks.md) makes for hooks.

Two states answer with a sentence rather than a command, and deliberately.
`sliced` and `planned`-after-review wait on an approval that is a person's to
give, and naming a skill there would name one that must not run yet.

## The hard rule

**`pdkit gate` lets `git push` and `gh pr create` through only from
`preflight-green`, and only for a branch present in the approved graph.**
Everything else is denied at the hook, not at the prompt.

**And `preflight-green` is earned rather than asserted** — which it was not, for
the first twenty-nine versions of this document. The gate checked the state
faithfully; nothing checked that the state was true. `slices-approved ->
preflight-green` is a legal move, so the entire chain of gates could be replaced
by typing the name of its outcome. Found on DESKTOP-18832, where a session did
exactly that after a slice graph landed, opened a token and pushed.

The repair is the device every other guarded state already used: something on
disk that only a real run could have produced. `answered` refuses while nothing
has been captured; the redo route refuses to leave `triaged` until the previous
attempt has been looked up. Preflight had no such file — it printed a report and
forgot it — which is precisely why this was the one rule with nothing behind it.
It now writes `preflight.json`, and the transition asks three questions of it:

1. **on this commit.** Runs are filed under the resolved head SHA, so a green
   run of a diff that has since moved is not evidence — the same thing the slice
   verifier refuses by digest.
2. **nothing blocking is failing**, taken from the recorded per-check results
   rather than from a summary anyone could have typed.
3. **the body-dependent four have seen a body.** [Section 7](07-preflight.md)'s two passes mean no
   single run is complete, so the question is asked of the merged view: the
   latest result per check, and for those four, one from a run that had the body.
   A check that skipped because it had nothing to read has judged nothing.

Adoption stays the exception, deliberately: `issue adopt` writes the state
directly rather than transitioning, because work that predates the plugin never
ran preflight and inventing the artefacts of states it skipped is the one thing
that command exists not to do.

---

**In brief** — [`architecture/`](../architecture/README.md): [3 · The lifecycle](../architecture/03-lifecycle.md)

**In practice** — [`workflows.md`](../workflows.md):

- [§6 — An issue that ends in an answer](../workflows.md#6-an-issue-that-ends-in-an-answer)
- [§9 — The reviewer rejected the approach, not the diff](../workflows.md#9-the-reviewer-rejected-the-approach-not-the-diff)
- [§11a — Upstream asks you to join open pull requests](../workflows.md#11a-upstream-asks-you-to-join-open-pull-requests)
- [§16 — Starting one issue over](../workflows.md#16-starting-one-issue-over)

← [0 · References taken and rejected](00-references.md) · [Contents](README.md) · [2 · Plugin structure](02-plugin-structure.md) →
