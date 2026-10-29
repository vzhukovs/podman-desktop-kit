# 7a. Feedback that arrives after the merge

[Workflows](README.md) › Part III — Living with an open pull request · [Sessions and models](#sessions-and-models)

The pull request is merged and a reviewer asks something anyway. It happens, and
it is not a defect in anybody's process: on #18561 the question came a week after
the merge and was a good one — what does a very long container command do to the
display?

There is nothing to push, so `/pd:pr-sync` has nothing to drive. What is left is
a decision, and the decision has to survive the issue closing.

```
pdkit defer new --issue 18248 --pr 18561 --raised-by reviewer3 --kind bug \
  --what "a very long container command may break the interface display; it needs an ellipsis plus a tooltip in the renderer" \
  --url https://github.com/podman-desktop/podman-desktop/pull/18561#issuecomment-5266241008
```

That writes a journal entry and drafts the follow-up issue under
`deferrals/D1.md`. **Opening the issue is yours** — `gh issue create` is denied
at the hook from every state.

**The draft is laid out in upstream's own issue form**, so you open the issue
through the template in the GitHub UI and copy field by field. `--kind` picks
which form: `bug` (default), `feature` or `task`, matching
`.github/ISSUE_TEMPLATE/` upstream. The headings in the draft are that form's
field labels, so the posted issue reads like every other one in the repository
rather than like something a tool produced. The operating system and the version
are filled in from the machine and the checkout.

**The title comes first**, under its own heading, because it is the first field
of the form and not part of the body. It is derived from `--what`, and `--title`
overrides when the two differ — a feature request is titled by what should exist,
while `--what` records what was set aside. It is never truncated: upstream titles
run to a hundred characters, and one cut mid-clause says less than a long one
while looking finished.

Screenshots get **visible placeholders**, one per image found under the issue's
`evidence/` directory:

```
**[SCREENSHOT 1 — replace this line by dragging in `long-cmd-token-summary.png`]**
```

Visible rather than an HTML comment, deliberately: a comment renders as nothing,
so one left unreplaced reaches the issue invisibly — the same defect this
repository has fixed three times elsewhere. Posted unreplaced, that line is
obvious to you and to the reader.

**Why this is a new issue rather than a wider pull request.** The one that merged
fixed a conversion in the logic: the container command was not being joined.
Truncation, an ellipsis and a tooltip are the renderer's. Putting both in one
pull request would have made a one-line fix into a UI change, sent it to a second
domain owner for review, and given preflight a slice spanning two layers to warn
about. "Out of scope" is not the argument; **the layer is**, and it is the
argument that survives being read by the reviewer who raised the point.

Then close the issue that is actually finished:

```
pdkit close 18248 --finish
```

It **warns rather than refuses**:

```
  ! D1 is still open, and closing does not settle it:
      a very long container command may break the interface display … — reviewer3, #18561
      https://github.com/podman-desktop/podman-desktop/pull/18561#issuecomment-5266241008
      `pdkit defer resolve D1 --issue 18248 --follow-up <n>` when you open one.
DESKTOP-18248 is merged
```

Closing is the last step, so there is no later gate this could be caught at —
which sounds like an argument for refusing until you notice the other half: a
gate standing between a finished issue and its terminal state gets paid every
time and earns its keep almost never. What keeps the promise is not the gate. It
is that the journal is append-only, so `pdkit defer list --issue 18248` still
answers after the issue is `merged`, and `pdkit journal --issue 18248` still has
the line.

```
pdkit defer list --issue 18248            # what is outstanding
pdkit defer list --issue 18248 --all      # including what has been settled
pdkit defer resolve D1 --issue 18248 --follow-up 18604
pdkit defer drop D1 --issue 18248 --reason "asks about a code path the fix removed"
```

`drop` takes a reason for the same purpose `task unblock` does: it is the only
record of why something a reviewer raised is not being done.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
pdkit defer new --issue 18248 --pr 18561 …    no model: a terminal
pdkit close 18248 --finish

  or, with the knowledge harvest:

/clear
/model sonnet                       ← back from the opus of /pd:pr-sync
/effort medium
/pd:close 18248
```

| Step | Session | `/model` | Subagents |
|---|---|---|---|
| `pdkit defer new …` | **terminal**, or the `/pd:pr-sync` session that read the comment | — | — |
| opening the follow-up issue | GitHub, by hand | — | — |
| `pdkit close 18248 --finish` | **terminal** | — | — |
| `pdkit defer list` / `resolve` / `drop` | **terminal** | — | — |

`/pd:close 18248` does the same as the closing line, with the knowledge harvest
— **new** · issue tree, sonnet. It leaves the tree before removing it.

---

**The design** — [`/pd:pr-sync`](../specification/04-contracts/pr-sync.md)

← [7 · A pull request that has gone stale](07-stale-pr.md) · [Contents](README.md) · [8 · Coming back after a break](08-coming-back.md) →
