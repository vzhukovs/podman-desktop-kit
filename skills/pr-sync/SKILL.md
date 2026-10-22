---
name: pr-sync
description: "Process review feedback: triage threads, fix, reply, resolve."
argument-hint: "<pr-number>"
disable-model-invocation: true
model: opus
effort: high
---

The reviewer spent their time. This command exists so it does not have to be
spent twice.

## Steps

0. **Checkpoint.** `pdkit checkpoint <n> --phase pr-sync`, where `<n>` is the
   issue the pull request belongs to (`pdkit pr list` shows it). This round
   can go somewhere it should not. On DESKTOP-18833 it built a stack the
   plugin could not hold, and only a checkpoint makes the way back a command
   instead of a recollection.

1. **Read.** `pdkit pr refresh <k>` then `pdkit pr threads <k> --json`.

   What comes back is already sorted mechanically: who is a bot, which file and
   slice each thread belongs to, which task owns that file, which requirement
   that task satisfies. None of it is classified — that part is yours.

   **Do not stop at threads.** The output includes review submissions and
   top-level comments, and on a stale pull request that is usually where the
   blocking feedback is. #17577 has two open threads, both a bot's, while the
   reason it is stuck is a four-line `CHANGES_REQUESTED` body.

   A review body is mapped too: every `path:line` it cites comes back under
   `cites`, with its slice or **unmapped**. #19750's review was one body with
   eight findings and no threads at all.

   **Then what no reviewer has said yet.** Upstream's review agent reads the
   whole diff of the pull request, not the last round. A violation of
   `${CLAUDE_PLUGIN_ROOT}/knowledge/maintainer-rules.md` that nobody has named will be named in the
   next round, so find it in this one:

   ```
   pdkit preflight <n> [--slice <i>] --only maintainer-rules
   ```

   It reads the branch against its base, so on a pull request opened before
   these rules existed it covers everything the pull request carries. The
   report's `base` line is the base that step 1a below diffs against.

1a. **Adopted issue, first round: a self-review.** If `pdkit state <n>` shows
   `adopted`, no plan critic and no slicer ever looked at this work. Section 1
   violations are most likely here: several concerns in one PR, tests changed
   together with their implementation, drive-by edits. A grep does not see
   them. So, once per pull request, review it the way `/pd:review-pr` reviews
   somebody else's:
   - the four `pd-review-*` axes, in parallel, on `git diff <base>...HEAD` in
     the local tree. Use the local tree, not `refs/pull/<k>/head`: after
     `/pd:resume` the rebased branch is not pushed yet;
   - then `pd-review-synth`, then `pdkit review render <k> --values <f>`.

   No threads go to the axes or to the synthesis. The threads are already this
   round's agenda, and the self-review exists to find what they missed.

   The rendered `$PDKIT_HOME/reviews/<k>.md` is the record that it was done.
   If that file exists, skip this step. Do it again only if the person asks.

2. **Bots.** Collapsed to one line with a link, never dropped. A thread the
   escalation words expanded is read in full, like a person's. If a collapsed
   line looks like it might matter, open the link: collapsing is about
   attention, not a decision that it was worthless.

3. **Classify each open item**, and say which it is:

   - `accept` — we change something;
   - `discuss` — an answer, not a change;
   - `defer` — a separate issue, and **record it**:

     ```
     pdkit defer new --issue <n> --pr <k> --raised-by <who> --what "<what was set aside>" --url <comment>
     ```

     Saying "we will open an issue for that" in a reply and leaving it there is
     how the promise ends up existing only on GitHub, on a pull request that is
     about to merge. The command writes it to the journal, which is append-only,
     so it outlives the issue reaching `merged` — and `pdkit close` names it
     while there is still somebody reading. Once the follow-up exists,
     `pdkit defer resolve D<k> --issue <n> --follow-up <new issue>`.

   - `reject` — we disagree, with the reason, stated once.

   An item flagged **unmapped** — a thread on a file in no slice and no task, or
   a review that cites one — is a signal, not noise. Either the reviewer found a requirement the plan missed,
   or the pull request failed to explain itself. Decide which, out loud.

   **A fifth outcome exists and is not on that list: the reviewer rejected the
   approach.** "This should not be done this way at all" is not a change to
   make, and classifying it `accept` starts an edit against a design the
   maintainer already refused. It is `pdkit issue rework <n> --reason "<what
   was refused>"`: back to `triaged`, pull request left open, branch untouched,
   planning starting again from the issue rather than from the diff. Say so and
   stop — what to do instead is the next planning round's question, and the
   reviewer usually named it.

   **A sixth: the reviewer wants something landed first.** "This should be its
   own PR, before this one." Before offering anything, compare the files that
   change would touch with the files of the existing slices
   (`pdkit slice show --issue <n>` lists them):

   - **No file in common.** It can be a new slice of this issue, through an
     amendment, like any other plan change.
   - **A file in common.** This issue cannot hold it. A slice is the diff
     restricted to its files, so one file has one slice, and two pull requests
     changing the same file one after the other are not something the slice
     model can express. It is `block`: a separate upstream issue that must merge
     first, and this pull request waits for it. Do not offer "a new slice under
     this issue" here, and do not offer stacking: neither has a command behind
     it, and on DESKTOP-18833 both ended in refusals, after the work was done.

   Rows that only make sense once the blocker has merged are marked
   `blocked by <row>`. Everything else in the table still moves this round.

### Every option has a command behind it

An option in the table, or in any question to the person, names the pdkit
command that carries it out. An option no command carries is marked **"pdkit
does not support this"**, and it is never the recommended one. On
DESKTOP-18833 the session offered a three-commit stack that it had made up.
The person chose it, and the plugin refused it two phases later.

**A refusal is an answer, not an obstacle.** When `amendment approve`,
`slice set` or `task start` refuses, stop and bring the refusal to the person
with the options that are supported. Do not route around it. That means no
deleting task headings so ownership stops being checked, no dropping a file
from a slice until the overlap goes away, no rewriting work as prose so
nothing parses it. Each of those turns a refusal now into a worse one later,
or into nothing at all.

4. **Decide with the person, before any code changes.** Show one table, every
   open item a row, and stop:

   ```
   #  Item (who, where)                    Decision  How                         Files
   1  reviewer, index.spec.ts:226          accept    type the callback           index.spec.ts
   3  reviewer, index.spec.ts:211-246      accept    ⚠ a) existing test pattern  index.spec.ts
                                                       b) extract a module       + before-quit-handler.ts (outside slice #1)
   6  reviewer, index.ts:82                defer     separate PR
   7  reviewer, question                   discuss   answer from validation V2
   ```

   Mark ⚠, and leave the choice to the person, wherever the decision is not
   yours to take:

   - the reviewer offered alternatives — "either … or …" is a question to the
     author, and the author is the person, not the session;
   - the fix would touch a file outside the item's slice, or create one;
   - the decision changes what the plan promised (step 5).

   **Our own findings are rows too**, below the reviewers' ones, with the
   source `self (§n)`. They come from the `maintainer-rules` check in step 1
   and from the step 1a self-review. They never merge into a reviewer's row:
   nobody asked for them, and a reply must not present them as an answer to
   someone.
   - Propose `accept` when the fix stays inside the item's slice.
   - Mark ⚠ and propose `defer` when it does not, and for any section 1
     finding. Splitting an open pull request mid-review is a decision about
     the pull request, not a fix.
   - Propose `reject`, with the reason, when the hit is a false positive. A
     grep cannot see context.

   ```
   #  Item (who, where)                    Decision  How                         Files
   8  self (§2), main.spec.ts:40           accept    vi.mock(import(…))          main.spec.ts
   9  self (§1), tests and impl together   ⚠ defer   separate PR for the test    —
   ```

   Everything else you may propose outright. The person answers in a line —
   "3b, 6 do it here" — and nothing is edited until they have. A fix the person
   did not see decided is the failure this step exists for: on #19750 the
   session chose the extraction on its own, and the first anyone heard of the
   two new files was the push.

4b. **A `block` row, once decided.** Nothing about it is edited on this branch.

   ```
   pdkit issue draft-blocker <n> --what "<what it carries>" --pr <k> \
     --raised-by <who> --url <comment> [--prior <branch>]
   ```

   This writes the upstream issue draft into `blockers/`. Give the person its
   path. **Opening the issue is theirs:** `gh issue create` is denied at the
   hook. When they come back with its number:

   ```
   pdkit issue block <n> --by <new issue> --reason "<what it carries>"
   ```

   From then on, `next`, `state` and `pr list` say what this issue waits on.
   The new issue is worked **in a new session**, starting from triage. Hand
   the person the exact message to start it with, the invocation line first
   and the prior context after it:

   ```
   /pd:triage <new issue>
   Requested by <who> on #<k> as a PR to land before it: <url>
   Prior work: <branch>, written and tested under DESKTOP-<n>. Reuse it, but
   plan, verify and preflight it from scratch under this issue.
   ```

   Prior work exists when code for it was already written, as on 18833. The
   new issue gets its own `DESKTOP-<new>/…` branch: pdkit refuses a tree that
   belongs to another issue, so the code is carried over by cherry-pick
   during `/pd:exec`, not by working on the old branch.

   Then this round carries on without the blocked rows. The replies for those
   rows say the work was split out, name the new issue once it exists, and
   say that this pull request will be rebased after it merges.

5. **Amendments.** If an `accept` changes what the plan promised — a new
   requirement, a changed one, a slice that has to move — then
   `pdkit amendment new --issue <n> --values <f>`, with every requirement it
   touches as a row of `rows` — `{"rid": "R7" | ["R2", "R6"], "change": …,
   "detail": …}`, change being `added`, `withdrawn`, `unchanged`, `superseded
   by R<k>` or `replaced by R<k>`. Never finish the table by hand: approval
   applies it to the issue's R-IDs and to plan.md. **It goes to the user for
   approval, and nothing moves until it is approved.** An amendment applied
   quietly turns the plan into a record of what happened rather than a statement
   of what was intended.

6. **Fix.** One `pd-thread-resolver` per accepted row, given the row as
   approved: the item, the decision, the option chosen, and the files it may
   touch. It implements that and nothing wider; if the fix turns out to need
   another file or another approach, it stops and reports, and the row comes
   back to the person. Resolvers draft the reply as well as the change. They
   never publish.

   A `self` row goes to a resolver as well. Tell it there is no thread, so it
   drafts no reply. Its fixes go in a commit of their own, apart from the
   commits that answer reviewers. Upstream asks for review rounds to be
   visible as new commits, and a reviewer reading "address review" should find
   only what they asked for.

7. **Cascade.** If a fix touched a slice something else is stacked on:
   `pdkit slice cascade --issue <n> --from <i>`. It rebases the dependants and
   verifies them again, and marks anything that stopped being standalone rather
   than rebasing it into a lie.

8. **Preflight.** `pdkit preflight <n> --slice <i>`, both passes, as in
   `/pd:pr`. A previous green means nothing now.

   `maintainer-rules` is advisory, but a hit that was **not** a row in step 4
   is something a fix in this round introduced. Go back to step 4 with it.
   Fixing it now without a decision is the unseen change step 4 exists to
   prevent. Pushing it unread means the maintainer reads it first.

9. **Publish, in this order.** First show what the push would change:

   ```
   pdkit pr diff <k>
   ```

   The pull request's head on GitHub against the local branch, and any file the
   pull request would then carry outside its slice. Show it in full before
   asking about the push — the question is about this diff, and a push
   approved without it is approved blind. Then:

   ```
   pdkit publish --issue <n> --branch <b> --pr <k> [--slice <i>]   # push: per branch
   pdkit gate open --issue <n> --pr <k> --kind reply   # reply: per pull request
   pdkit pr reply <k> --thread <id> --body <f> [--resolve]
   pdkit gate close --pr <k> --kind reply
   pdkit pr render <k> --issue <n>
   ```

   `publish --pr` is the first four lines it replaced — `state --to
   preflight-green` (earned from preflight, as always), `gate open --branch`,
   `git push --force-with-lease`, `state --to pr-open` — in that order, stopping
   at the first refusal. It asks nothing: the person has already read the drafts
   and the change. The separate commands still work when it stops partway.

   Two tokens, because these are two different acts of consent. The push token
   is per branch and is spent on use. The reply token covers **the batch of
   drafts the user read in one go** — show all of them, ask once, then send.
   Asking eight times in a row is how a gate becomes a reflex.

   Show every draft reply in full before asking. Not a summary: the point of the
   gate is that a person reads what is about to be published under their name.

10. **Record.** `pdkit pr render <k>` writes `prs/<k>.md`, including what was
   done about each thread. A conversation with a reviewer outlives the
   conversation.

## When the phase went somewhere it should not

If this phase built on an option pdkit does not carry, or a refusal was routed
around before anyone noticed, go back to its start rather than patch forward:

```
pdkit rollback <n>              what would come back, and what stays
pdkit rollback <n> --confirm    after the person has read that
```

Branches return to their heads at the checkpoint, with the present tips kept
under `refs/pdkit-backup/`. Artefacts return from the copy, with the present
ones archived. The state record comes back too. It is refused if the phase
moved the issue to another state, because a transition is not undone by
rewriting the record. What was published stays published, and the journal
keeps everything. Show the dry run in full and ask before `--confirm`. Then
run the phase again, in a new session.

## Replying well

Say what changed and where. When you disagreed, say why — once. Disagreement
defended at length reads as reluctance to change anything, and it costs the
reviewer a second reading of an argument they already followed.

Never resolve a thread the reply did not answer. A resolved thread with nothing
in it is worse than an open one: it removes the reviewer's marker without
removing their question.

## When the phase runs long

`budget.turns.pr_sync` is per round, and it is a guide, not a count: nothing in
the plugin can tell how many turns a session has taken, and neither can you.
Stop between threads, never inside one. A fix is a commit; a draft reply should
be a file before you stop — `pr reply` takes its body from one anyway. Then ask
for a restart, and the new session takes up the threads `pdkit pr threads <k>`
still shows open.

## Next

The next round on this pull request is `/pd:pr-sync <pr>` again, when the
reviewer answers — **in a new session**, for the reason every round should be:
the answer arrives days later, and this round is in `prs/<k>.md`, not in
anything that needs re-reading on each turn of the next. `/pd:pr-status` shows
what else is waiting. Once every pull request of the issue has merged,
`/pd:close <issue>`. If the approach was rejected and the issue went back to
`triaged`, planning restarts with `/pd:plan <issue>`. `pdkit next <issue>`
prints whichever line applies.
