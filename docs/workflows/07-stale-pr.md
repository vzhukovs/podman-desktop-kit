# 7. A pull request that has gone stale

[Workflows](README.md) › Part III — Living with an open pull request · [Sessions and models](#sessions-and-models)

```
/pd:pr-status                        → what is open, what is blocked, how idle
/pd:pr-sync 17577                    → a decision per item, fixes, the diff, replies
```

`pr-sync` stops three times, and the first is before any code changes: a table
with every open item — thread, review body or comment — and what to do about
it. Rows marked ⚠ are yours to decide: the reviewer offered alternatives, the
fix would touch or create a file outside the slice, or the plan changes. Then
the push, shown as `pdkit pr diff` first; then the replies, all drafts in
full.

The table also carries **our own findings**, as `self (§n)` rows below the
reviewers' ones. They come from `pdkit preflight <n> --only maintainer-rules`,
run against the whole pull request because upstream's review agent reads all
of it. On the first round of an **adopted** issue they also come from a full
self-review: the `/pd:review-pr` axes on the local diff, recorded in
`reviews/<k>.md`. A `self` row is fixed in its own commit and gets no reply.

What the dashboard tells you, and what it deliberately does not:

```
pdkit pr list                        every row, and how old its reading is
pdkit pr refresh 17577               read GitHub into prs.json
pdkit pr ci 17577                    the CI verdict, plus the failure text
pdkit pr threads 17577               bots collapsed, threads and the files a
                                     review cites mapped to slices
pdkit pr diff 17577                  what a push would change, against the
                                     pull request's head on GitHub
```

**`pr list` is local, and every row says when it was last read** — `read:3d`, with
`←` past six hours. A sweep of ten pull requests was measured at 32 GraphQL points
and 37 seconds, so nobody refreshes everything before every glance; that makes an
old row the normal case, and a verdict from three days ago used to print exactly
like one from a second ago. Refreshing by "what looks recently touched" does not
work either: CI finishing does not move a pull request's `updatedAt` — measured,
eight of eight.

**A red job has two possible meanings and they are measured apart.** `fail` is red
here and green on other people's open pull requests. `inconclusive` is the same
job red on theirs too — a warning, not a block, because refusing to proceed over
something the change did not do teaches people to work around the gate. `flake` is
the same job answering twice on one commit. A `pending` job prints its age: a check
stuck IN_PROGRESS since June is a finding about the pull request, not about CI.

**And for the jobs that are yours, the log comes with the verdict.** The window is
anchored on the runner's `##[error]`, so what precedes it is the output that led
there — measured because a plain tail showed credential cleanup and no failure.
The other verdicts do not fetch one: `inconclusive` describes someone else's
problem and `flake` is already the finding. `--no-logs` for the sweep.

**Threads are not the whole of the feedback.** Review submissions and top-level
comments come back too, and on a stale PR that is usually where the blocking
comment is. Bots are collapsed to one line with a link — never dropped, and an
escalation word expands one back.

Publishing takes two tokens, because they are two different acts of consent:

```
pdkit gate open --issue 17221 --branch <b>              push, per branch, spent on use
pdkit gate open --issue 17221 --pr 17577 --kind reply   replies, per PR, covers the batch
```

## The three stops

```
/pd:pr-sync <pr>
  ├─ the hook moves the session into DESKTOP-<n>
  ├─ pdkit pr refresh, pdkit pr threads
  │
  ❶ the decision table                        ← you answer before any edit
  │    (a row that changes the plan → an amendment, approved on its own)
  │
  ├─ one pd-thread-resolver per accepted row (sonnet)
  ├─ cascade, when slices are stacked on the one fixed
  ├─ pdkit preflight, both passes
  │
  ❷ pdkit pr diff → "push?"                   ← the push, with the diff on screen
  ❸ every reply drafted in full → "send?"
  └─ push, replies, prs/<pr>.md
```

### ❶ The decision table

Every open item is a row — threads, review bodies, top-level comments. A review
with no threads still shows by file, because the `path:line` it cites is mapped
to slices. What it looks like, from #19750:

```
#  Item (who, where)                    Decision  How                         Files
1  reviewer, index.spec.ts:226          accept    type the callback           index.spec.ts
2  reviewer, index.spec.ts:229          accept    assert(...) instead of as   index.spec.ts
3  reviewer, index.spec.ts:211-246      accept    ⚠ a) existing test pattern  index.spec.ts
                                                    b) extract a module       + before-quit-handler.ts (outside slice #1)
4  reviewer, index.spec.ts:96-100       accept    automock                    index.spec.ts
5  reviewer, index.ts:65                accept    comment on the guard        index.ts
6  reviewer, index.ts:82                defer     separate PR
7  reviewer, question                   discuss   answer from validation V2
8  reviewer, question                   discuss   intended: no retry, why
```

The decision is one of `accept`, `discuss`, `defer` (recorded with
`pdkit defer new`) or `reject` with its reason. You answer in a line — `3b, 6 do
it here, 7 show me the draft first` — and nothing is edited until you have. A
row that changes the requirements or the slices becomes an amendment, approved
with `pdkit amendment approve` rather than "ok" in the chat. A reviewer who
refused the approach is not a row to accept: that is
[`pdkit issue rework`](09-approach-rejected.md), and the round ends.

Each accepted row goes to one `pd-thread-resolver` with the row whole: the item,
the decision, the option chosen, the files it may touch. If the fix turns out to
need another file or another approach, it stops and reports, and the row comes
back to you.

### Reading `pdkit pr diff`

Before asking about the push, the session shows what it would change:

```
#19750 DESKTOP-18915/1-quit-and-install-race, slice #1
  on GitHub : 16b4e18a5db
  local     : 12feae3a1b4 (1 ahead)
```

followed by the diff. Three things to read in it:

- **`N ahead`** — new commits on top of the pull request.
- **`N ahead, M behind — a rewrite, pushed with --force-with-lease`** — commits
  already in the pull request were rewritten. Normal here, where fixes are
  often amended in; the reviewer will see a force-push.
- **`outside slice #<i> after the push: …`** — after the push the pull request
  would carry files the slice graph does not list. If you did not approve them
  at ❶, do not push.

`the same commit — nothing to push` means the branch and the pull request
already agree.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
/clear
/model sonnet
/pd:pr-status                       the dashboard

/clear
/model opus                         ← switch: review rounds are opus
/effort high
/pd:pr-sync 17577                   pdkit next does not name it — the hook reminds

… the reviewer answers, days later …

/clear
/effort high
/pd:pr-sync 17577                   the next round — still opus
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `/pd:pr-status` | **new** · anywhere in the fork | sonnet | — |
| `/pd:pr-sync 17577` | **new** · issue tree, **one per review round** | opus | `pd-thread-resolver` · sonnet; on the first round of an adopted issue also the four `pd-review-*` · sonnet and `pd-review-synth` · opus |
| `pdkit gate open …` | the pr-sync session, when it asks — you confirm | — | — |
| `pdkit pr list` / `refresh` / `ci` / `threads` / `diff` | **terminal** | — | — |

---

**The design** — [`/pd:pr-status`](../specification/04-contracts/pr-status.md), [`/pd:pr-sync`](../specification/04-contracts/pr-sync.md)

← [6 · An issue that ends in an answer](06-ends-in-an-answer.md) · [Contents](README.md) · [7a · Feedback that arrives after the merge](07a-feedback-after-merge.md) →
