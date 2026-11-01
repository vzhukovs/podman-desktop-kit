# 3. A feature, cut into several pull requests

[Workflows](README.md) › Part I — Choosing and starting work · [Sessions and models](#sessions-and-models)

The full path. `/pd:slice` will usually produce 2–5 pull requests, and the plan
has to have anticipated that: a diff planned without slicing in mind cannot be
cut apart afterwards without redoing the work.

```
/pd:slice 12345       → graph of slices, each one verified       [you approve]
/pd:pr 12345          → per slice: branch, preflight, body, PR   [you confirm each]
```

What happens under those two lines:

```
pdkit slice suggest --issue 12345 --json     facts: file → package → layer → task → R-IDs
pdkit slice set --issue 12345 --from f.json  refuses a graph that cannot work
pdkit slice verify --issue 12345 --all       builds each slice alone, from main
pdkit slice render --issue 12345             slices.md, verified columns included
pdkit state 12345 --to sliced                                    [you approve]
pdkit slice materialize --issue 12345 --slice 1 --subject "…"
pdkit preflight 12345 --slice 1              … then the body, the second pass,
                                             the gate, and the next slice
```

**A slice is a base plus a set of files.** Verification runs before any branch
exists, so what gets built is the diff restricted to those files, applied to a
scratch worktree from `main`.

**Green standalone means the slice branches from `main`. Red means it needs a
stack** — and the red run is the evidence for the stack, not a failure to fix.
Independence is preferred because a stack is fragile: after #1 merges, #2 needs
its base switched and its review threads point at lines that moved.

**Every slice, merged alone, leaves main working.** Not only building: no
feature broken, no built-in extension regressed. A body saying "merge #A → #B →
#C" does not count, and `merge-order` in preflight fails one about slices the
graph calls independent.

**The plan's slice hypothesis is where the cut starts.** More slices than the
plan said is refused unless the slicer gives a reason, and the reason is shown
in `slices.md` beside `Plan said:`.

What the machine refuses, so the slicer does not have to be trusted with it: two
slices sharing a file, a changed file in no slice, a cycle between bases, a public
API change mixed into another layer or merging after it, an R-ID that reaches no
slice, the two ends of an existing IPC channel in different slices, more slices
than the plan without a reason.

**One change across layers is one pull request with a commit per layer.** An IPC
signature through main, preload and renderer has no part that works alone. The
slice gets `commits`, `materialize` makes one commit each, and the title carries
every scope: `refactor(main,preload,renderer): …`.

What stays judgment: whether a slice justifies itself without the next one.
Upstream does not accept dead code staged for a future PR.

**Verification is re-checked, not remembered.** `slices.json` stores the digest of
the diff that was verified; preflight recomputes it and fails on a mismatch. On a
materialized branch that doubles as proof the branch is what was verified.

If a review fix lands in a slice that others are stacked on:

```
pdkit slice cascade --issue 12345 --from 1    rebase the dependents, verify again
```

Anything that stopped being green is reported, not rebased into a lie.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
/clear
/model sonnet                       already sonnet if you came from /pd:audit
/effort medium
/pd:slice 12345
pdkit state 12345 --to slices-approved   your approval

/clear
/pd:pr 12345                        slice 1

/clear
/pd:pr 12345                        slice 2 — a new session for each
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `/pd:slice 12345` | **new** · issue tree | sonnet | `pd-slicer` · sonnet |
| approve: `pdkit state --to slices-approved` | the slice session, or **terminal** | — | — |
| `/pd:pr 12345` | **new** · issue tree, **one per slice** | sonnet | — |
| `pdkit slice cascade …` | **terminal**, or the `/pd:pr-sync` session that made the fix | — | — |

The `pdkit slice …` lines below are what the two skills run; typed by hand they
need no model. The path before slicing is [scenario 1](01-bug-fix.md#sessions-and-models).

---

**The design** — [`/pd:slice`](../specification/04-contracts/slice.md), [`/pd:pr`](../specification/04-contracts/pr.md), [architecture · The slicer](../architecture/04-slicer.md)

← [2 · A one-line fix](02-one-line-fix.md) · [Contents](README.md) · [4 · Validating against the running application](04-validating.md) →
