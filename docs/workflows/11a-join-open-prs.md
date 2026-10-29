# 11a. Upstream asks you to join open pull requests

[Workflows](README.md) › Part III — Living with an open pull request · [Sessions and models](#sessions-and-models)

The other direction. DESKTOP-19818 went out as three pull requests that only
worked merged together, and the review said: one pull request, three commits.

```
pdkit checkpoint 19818 --phase slice
pdkit slice join --issue 19818 --slices 1,2,3     one slice, a commit per old one
pdkit state 19818 --to sliced --reason "review asked for one PR with a commit per layer"
pdkit slice verify --issue 19818 --all
pdkit slice verify --issue 19818 --slice 1 --commits     each commit, for information
pdkit slice render --issue 19818                                  [you approve]
/pd:pr 19818                                       a new pull request    [you confirm]
pdkit pr supersede 19829 --by <new> --body close.md      what would be posted
pdkit gate open --issue 19818 --pr 19829 --kind reply                [you confirm]
pdkit pr supersede 19829 --by <new> --body close.md --confirm
```

The commits keep the subjects the old pull requests were published with.
`join` refuses a slice branch that review moved away from the working branch,
because the join is cut from the working branch, and it prints the
`git checkout` that brings the change back. Each old pull request is closed
only after the new one exists, with a comment that points at it.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
/clear
/model sonnet                       ← back from the opus of /pd:pr-sync
/effort medium
/pd:slice 19818                     checkpoint, join, verify, render
pdkit state 19818 --to slices-approved   your approval

/clear
/pd:pr 19818                        the new pull request
pdkit pr supersede 19829 --by <new> --body close.md
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `checkpoint` … `slice render` | **new** · issue tree running `/pd:slice 19818`, or **terminal** | sonnet | `pd-slicer` · sonnet |
| `/pd:pr 19818` | **new** · issue tree | sonnet | — |
| `pdkit pr supersede`, `pdkit gate open --kind reply` | **terminal** | — | — |

---

**The design** — [`/pd:slice`](../specification/04-contracts/slice.md), [1 · The `re-cut` edge](../specification/01-domain-model.md#the-re-cut-edge)

← [11 · Upstream asks you to split an open pull request](11-split-open-pr.md) · [Contents](README.md) · [12 · Work that predates the plugin](12-predates-the-plugin.md) →
