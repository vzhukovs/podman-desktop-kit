# One session per phase

[Workflows](../README.md) › [Reference](README.md)

The cycle is walked in several sessions, not one: a new session for each phase,
one per slice through preflight and pr, and one per review round. Every
orchestrating skill ends its `## Next` by saying so.

The reason is arithmetic. Context is re-read whole on every call, so a session
that grows steadily to C tokens over N calls reads about N·C/2 in total — its
cost grows as the square of its length. The dearest session measured (issue
18967, 26 August to 16 October) made 676 calls and grew to 878 k tokens of
context without one compaction. N·C/2 predicts 297 M input tokens against 331 M
observed, and 82 % of the issue's cost was cache reads — re-reading what had
already accumulated. The same work in eight sessions of about 85 calls is about
41 M. `pr` and `pr-sync`, at the end of such sessions, were a third to over half
of each cycle. `pdkit cost --issue <n>` repeats the measurement for any issue.

Nothing is lost at the boundary that the next phase reads. `issue.md`,
`research.md`, `plan.md`, `tasks/`, `receipts/`, `validation.md`, `audit.md` and
`slices.json` are on disk, under `$PDKIT_HOME`, which is why state lives there.
What does not survive is the informal part of a conversation — and for that,
triage takes whatever follows the first line of the command into
`## Prior context`, verbatim.

What makes a restart cheap rather than merely possible:

```
pdkit next 12345              # one line: the command to run now
```

and the summary `SessionStart` prints when a session opens in the issue's
worktree — the issue, state, route, the running task and its files if there is
one, failed captures, the command to run, the phase's turn budget and the last
few journal entries:

```
pdkit: issue 12345 — plan-approved, standard
  task    : none running
  next    : implemented
  run     : /pd:exec 12345
  budget  : about 80 turns per task, then a fresh session — a guide, nothing counts them
  recent  :
    …
```

**The budget is a guide and cannot be a limit.** `budget.turns.*` in the config
holds a soft ceiling per phase, in turns. No command can see how many turns a
session has taken, and the model cannot count its own precisely, so nothing
refuses anything at the ceiling. It is the number a skill names when it suggests
stopping — and stopping means writing what is settled to disk and asking for a
restart, not finishing the phase in a context that is already the expensive part.

Compaction is not the same thing. A compacted session keeps a summary of
everything before it and costs a call to produce; a new one keeps only what the
files and the summary above hold, which is what the next phase was designed to
work from.

## Which session, which model

### The model switches in one cycle

A skill's `model:` holds for its first turn only. After that the session's model
runs the phase, and **that model survives `/clear`**. So the model the phase is
routed to is the one you type, at the start of the session, before the command:

```
cd <fork> && claude          ──► sonnet, the fork's default

/model opus    before /pd:triage       holds through /pd:plan and /pd:plan-review
/model sonnet  before /pd:exec         holds through validate, audit, slice, preflight, pr, pr-status
/model opus    before /pd:pr-sync      holds through every review round
/model sonnet  before /pd:resume, /pd:slice, /pd:pr or /pd:close after a review round
```

Three phases outside that line run on opus as well: `/pd:review-pr`,
`/pd:knowledge`, and `/pd:plan` again after a [rework](../09-approach-rejected.md).

`pdkit next <n>` prints the `/model` line above the command, so copying its
output top to bottom switches before the skill starts. It does not name
`/pd:pr-sync`: from `pr-open` it points at `/pd:pr-status`, and going to a review
round is your call. When the session is on the wrong model anyway, the
`UserPromptSubmit` hook says so in a line addressed to you and carries on:

```
pdkit: /pd:exec runs on sonnet, and this session is on opus — type /model sonnet now.
A skill's model lasts its first turn; /model lasts the session.
```

It cannot switch the model itself: `/model` is typed by a person. A hook is not
given the model either, so it works it out, in this order, and says nothing when
none of them answers:

- **the session's transcript** — the last answer's model, or the last `/model`
  typed. That is why `/model sonnet` typed before `/pd:exec` already counts;
- **the transcript the same `claude` process had before `/clear`.** `/clear`
  opens an empty transcript while the model carries over, and `CLAUDE_PID` is
  the one identifier that survives it;
- **the fork's default**, on the first command of a fresh process: the `model`
  in `<fork>/.claude/settings.local.json`, counted out of the skills'
  frontmatter. The notice then says the session *most likely started on* it.
  `pdkit doctor` warns when the written default no longer matches the count.

**Effort** is set beside the model in the same frontmatter, and nothing reminds
you of it:

```
/effort high     /pd:triage, /pd:plan, /pd:plan-review, /pd:audit, /pd:pr-sync
/effort medium   every other phase
```

`/pd:audit` is the one sonnet session at high effort. Its verdict is
`pd-auditor`'s, on opus in its own context, and the session only hands it the
diff — so switching the session to opus there would buy nothing and carry opus
into the slicing after it.

### The columns

Every **Sessions and models** table in these pages uses the same four columns.

**Session.** **new** means a fresh session for this step: `/clear`, or close
`claude` and start it again — `SessionStart` fires on both. Where it is opened is
the second half:

| Where | What it is |
|---|---|
| **main checkout** | the podman-desktop fork itself, standing on the base branch. `claude` is started here, and triage, planning and reviews of other people's work run here: nothing in them writes code |
| **issue tree** | `DESKTOP-<n>`, beside the fork, made by `/pd:exec` or `pdkit worktree create`. Every phase from validation on runs here. You do not `cd` into it: on `/pd:<skill> <n>` the `UserPromptSubmit` hook has the session move there with `EnterWorktree`, and the `SessionStart` summary is printed when a session opens here |
| **terminal** | a plain `pdkit` command: no model is involved. A shell, or `! pdkit …` in whichever session is open |

One `claude` process works one issue. To change issue, quit and start `claude`
in the fork again; the hook moves the new session into the other tree. How the
move works, and what to do when it does not happen:
[Where a session works](trees.md).

**`/model`.** The model to type before the command, as above. A dash means the
step involves no model.

**Subagents.** Their model is fixed in `agents/*.md` and does not follow the
session's: `pd-auditor` is opus under a sonnet `/pd:audit`, and the review axes
are sonnet under an opus `/pd:review-pr`.

### Every command

From the `model:` and `effort:` frontmatter of `skills/*/SKILL.md` and
`agents/*.md`, which is the single source of truth. The turn budget is
`budget.turns.*` in the config: a guide for when to stop and restart, not a limit.

| Command | Session | `/model` | `/effort` | Subagents | Budget, turns |
|---|---|---|---|---|---|
| `/pd:doctor` | new · anywhere in the fork | sonnet | medium | — | — |
| `/pd:sync` | new · main checkout | sonnet | medium | — | — |
| `/pd:editor`, `/pd:open` | anywhere | haiku | low | — | — |
| `/pd:triage` | new · main checkout | **opus** | high | `pd-scout` · sonnet, `pd-archaeologist` · sonnet on `redo` | 40 |
| `/pd:plan` | new · main checkout | **opus** | high | `pd-scout` · sonnet | 60 |
| `/pd:plan-review` | new · main checkout | **opus** | high | `pd-plan-critic` · opus | — |
| `/pd:exec` | new · main checkout or the issue tree; it moves itself into the tree | sonnet | medium | `pd-implementer` · sonnet, one per task | 80 per task |
| `/pd:quickfix` | new · the checkout that will carry the branch | sonnet | medium | — | — |
| `/pd:validate` | new · issue tree | sonnet | medium | `pd-validator` · sonnet | 80 |
| `/pd:audit` | new · issue tree | sonnet | high | `pd-auditor` · opus | 40 |
| `/pd:slice` | new · issue tree | sonnet | medium | `pd-slicer` · sonnet | 60 |
| `/pd:preflight` | new · issue tree | sonnet | medium | — | — |
| `/pd:pr` | new · issue tree, one per slice | sonnet | medium | — | 50 |
| `/pd:pr-status` | new · anywhere in the fork | sonnet | medium | — | — |
| `/pd:pr-sync` | new · issue tree, one per review round | **opus** | high | `pd-thread-resolver` · sonnet; first round of an adopted issue: the four `pd-review-*` · sonnet, `pd-review-synth` · opus | 60 |
| `/pd:resume` | new · issue tree | sonnet | medium | `pd-conflict-analyst` · opus | — |
| `/pd:close` | new · issue tree; it leaves the tree before removing it | sonnet | medium | — | — |
| `/pd:reset` | new · main checkout | sonnet | medium | — | — |
| `/pd:review-pr` | new · main checkout, one per pull request | **opus** | medium | the four `pd-review-*` · sonnet, `pd-review-synth` · opus | — |
| `/pd:knowledge` | new · anywhere in the fork | **opus** | medium | — | — |

### Where the decisions are taken

The [decision points](decision-points.md) are not phases and get no session of
their own. Each is taken at the end of the session that produced what is being
decided, or in a terminal afterwards — the artefact waits on disk either way:

| Decision | Taken in |
|---|---|
| plan approval | the `/pd:plan-review` session, or a terminal: `pdkit ids freeze`, `pdkit state --to plan-approved` |
| slice graph approval | the `/pd:slice` session, or a terminal: `pdkit state --to slices-approved` |
| push confirmation | the `/pd:pr` or `/pd:pr-sync` session, in the turn that shows the push |
| plan amendments from review | the `/pd:pr-sync` session that raised them |
| additions to `knowledge/` | the `/pd:close` or `/pd:knowledge` session that proposed them |

---

**The design** — [5 · Agents and model routing](../../specification/05-agents.md), [3 · Commands](../../specification/03-commands.md), [architecture · Hooks](../../architecture/06-hooks.md)

← [Calibrating the thresholds](thresholds.md) · [Reference](README.md) · [Measuring what a cycle costs](cost.md) →
