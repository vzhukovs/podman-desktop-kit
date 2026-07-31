---
name: pr-sync
description: "Process review feedback: triage threads, fix, reply, resolve."
argument-hint: "<pr-number>"
disable-model-invocation: true
model: opus
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
   - `defer` — a separate issue, named;
   - `reject` — we disagree, with the reason, stated once.

   A thread flagged **unmapped** — its file belongs to no slice and no task — is
   a signal, not noise. Either the reviewer found a requirement the plan missed,
   or the pull request failed to explain itself. Decide which, out loud.

4. **Amendments.** If an `accept` changes what the plan promised — a new
   requirement, a changed one, a slice that has to move — then
   `pdkit amendment new --issue <n> --values <f>`. **It goes to the user for
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
   pdkit state <n> --to preflight-green
   pdkit gate open --issue <n> --branch <b>            # push: per branch
   git push --force-with-lease origin <b>
   pdkit state <n> --to pr-open
   pdkit gate open --issue <n> --pr <k> --kind reply   # reply: per pull request
   pdkit pr reply <k> --thread <id> --body <f> [--resolve]
   pdkit gate close --pr <k> --kind reply
   pdkit pr render <k> --issue <n>
   ```

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
