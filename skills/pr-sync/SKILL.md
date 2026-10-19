---
name: pr-sync
description: "Process review feedback: triage threads, fix, reply, resolve."
argument-hint: "<pr-number>"
disable-model-invocation: true
model: sonnet
effort: medium
---

The reviewer spent their time. This command exists so it does not have to be
spent twice.

## Steps

1. **Read.** `pdkit pr refresh <k>` then `pdkit pr threads <k> --json`.

   What comes back is already sorted mechanically: who is a bot, which file and
   slice each thread belongs to, which task owns that file, which requirement
   that task satisfies. None of it is classified — that part is yours.

   **Do not stop at threads.** The output includes review submissions and
   top-level comments, and on a stale pull request that is usually where the
   blocking feedback is. #17577 has two open threads, both a bot's, while the
   reason it is stuck is a four-line `CHANGES_REQUESTED` body.

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

   A thread flagged **unmapped** — its file belongs to no slice and no task — is
   a signal, not noise. Either the reviewer found a requirement the plan missed,
   or the pull request failed to explain itself. Decide which, out loud.

   **A fifth outcome exists and is not on that list: the reviewer rejected the
   approach.** "This should not be done this way at all" is not a change to
   make, and classifying it `accept` starts an edit against a design the
   maintainer already refused. It is `pdkit issue rework <n> --reason "<what
   was refused>"`: back to `triaged`, pull request left open, branch untouched,
   planning starting again from the issue rather than from the diff. Say so and
   stop — what to do instead is the next planning round's question, and the
   reviewer usually named it.

4. **Amendments.** If an `accept` changes what the plan promised — a new
   requirement, a changed one, a slice that has to move — then
   `pdkit amendment new --issue <n> --values <f>`, with every requirement it
   touches as a row of `rows` — `{"rid": "R7" | ["R2", "R6"], "change": …,
   "detail": …}`, change being `added`, `withdrawn`, `unchanged`, `superseded
   by R<k>` or `replaced by R<k>`. Never finish the table by hand: approval
   applies it to the issue's R-IDs and to plan.md. **It goes to the user for
   approval, and nothing moves until it is approved.** An amendment applied
   quietly turns the plan into a record of what happened rather than a statement
   of what was intended.

5. **Fix.** One `pd-thread-resolver` per accepted thread, each confined to the
   files that thread concerns. They draft the reply as well as the change. They
   never publish.

6. **Cascade.** If a fix touched a slice something else is stacked on:
   `pdkit slice cascade --issue <n> --from <i>`. It rebases the dependants and
   verifies them again, and marks anything that stopped being standalone rather
   than rebasing it into a lie.

7. **Preflight.** `pdkit preflight <n> --slice <i>`, both passes, as in
   `/pd:pr`. A previous green means nothing now.

8. **Publish, in this order.**

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

9. **Record.** `pdkit pr render <k>` writes `prs/<k>.md`, including what was
   done about each thread. A conversation with a reviewer outlives the
   conversation.

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
