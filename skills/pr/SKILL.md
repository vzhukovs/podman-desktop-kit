---
name: pr
description: "Create branches and pull requests. The only command that writes to GitHub."
argument-hint: "<issue-number> [slice]"
disable-model-invocation: true
model: opus
---

The only command in this plugin that writes to someone else's repository.
Order matters and is not negotiable.

## Sliced or single

`pdkit slice show --issue <n>` says which this is.

**With a graph**, the whole of what follows runs once per slice, in merge
order, and finishes each slice before starting the next — including the human
confirmation. Collecting three bodies and asking once turns the gate into the
reflex it exists to prevent. The token is per branch for the same reason.

Step 1 becomes `pdkit slice materialize --issue <n> --slice <i> --subject
"<type>(<scope>): <description>"`, which cuts the branch from the slice's base,
applies the slice and makes the single commit — no squash needed, and the
working branch is left where it was. Steps 3 and 5 take `--slice <i>`, or infer
it from the branch you are standing on.

**Without one**, it runs once, as below.

## Steps

1. **Branch.** `pdkit branch create --issue <n> --slug <slug>`. Idempotent —
   re-running after a preflight failure is the normal case.

2. **Squash.** `git reset --soft <base> && git commit`. Never `rebase -i`: the
   husky `commit-msg` hook appends `Signed-off-by` to a message that already
   carries one from the commits being squashed, then rejects the duplicate it
   just created. This surprises everybody exactly once.

3. **Preflight, pass one.** `pdkit preflight <n>`. Runs the repository's real
   test, lint and typecheck scripts — minutes, not seconds. Red stops
   everything. Note what `ci-blind-spots` reports: it decides whether `Notes
   for reviewers` is mandatory.

   On a slice this also reads the stored verification, and fails if the branch
   has drifted from what was verified. Re-verify rather than arguing with it:
   that check is the only thing standing between "verified" and "was verified
   once".

4. **Body.** `pdkit render prBody --issue <n> --values <f> --strip-comments`.
   Write it to a file. The four upstream headings are not ours to rearrange —
   a podman-desktop reviewer scans for their own.

   - `Closes #<n>` in the last slice to merge, `Part of #<n>` in the rest;
     on the quickfix route, a single `Fixes #<n>` and no coverage table.
   - The coverage table lists **this slice's** R-IDs — `pdkit slice show`
     has them. Preflight asks for exactly those, not the whole frozen set.
   - `Not in this PR`: name the slices the rest went to, by branch. This is
     the section that stops a reviewer looking for the other half.
   - `Steps to check`: at least three numbered steps, each with an expected
     result. Preflight enforces this, including on quickfix.
   - `Notes for reviewers`: mandatory when preflight flagged something CI
     cannot judge. Name the platform you checked on.

5. **Preflight, pass two.** `pdkit preflight <n> --body-only --body <file>`.
   Four checks read the body and could only skip on pass one. **Green here is
   what the gate is issued from** — pass one alone is not enough.

6. **Show the user, and stop.** The exact push command, the exact branch, and
   the full body as it will appear. Not a summary of it: the gate exists so a
   human reads the thing being published, and a summary defeats that as
   thoroughly as no gate at all.

7. **Wait for explicit confirmation in this same turn.** Not implied by an
   earlier "go ahead", not carried from another slice. Confirmation for slice
   #1 is not confirmation for #2 — the token is issued per branch.

8. **Then, and only then:**

   ```
   pdkit state <n> --to preflight-green    # from quickfix or slices-approved
   pdkit gate open --issue <n> --branch <b>
   git push origin <b>
   pdkit pr create --issue <n> --branch <b> --title <t> --body <file>
   ```

   **One token covers those two writes**, once each: the push spends half, and
   the pull request the push exists for spends the rest. That is one reading —
   the body and the branch you just showed — rather than two confirmations, and
   the second one would have arrived after the branch was already public.

   The order is fixed and not symmetric. Opening the pull request spends the
   token whole, so a push may come before it and never after: new commits on a
   branch already under review are their own publication and need their own
   token.

   `pdkit state <n> --to preflight-green` is **earned, not asserted**. It reads
   what `pdkit preflight` wrote — for this commit, with every check green and
   the body-dependent four having actually seen a body. If it refuses, the
   answer is a preflight run, never a different way of setting the state.

   `pdkit pr create` verifies and spends the token itself. If you open the PR
   any other way, do it after `gate open` and expect the hook to spend the
   token on the `gh` call.

   On a stacked slice the pull request opens against **its base branch**, not
   `main` — `pdkit pr create` takes it from the graph, so there is nothing to
   pass. Against `main` the diff would carry the previous slice's work, and the
   reviewer would be reading two changes believing they are one.

   **From a fork, that base usually does not exist.** The base of a pull
   request is a branch of the repository it opens against, and a slice branch
   lives in your fork — so a stack is only expressible when the branches and
   the pull requests share a repository. `pdkit pr create` checks upstream for
   the base and refuses before the token is spent when it is not there. Two
   honest ways past it, and neither is a different spelling of the command:

   - **Wait.** Merge the slice below, then open this one. Cleanest, and free if
     the review is not urgent.
   - **`--base main`, and say so in the body.** The diff will carry the other
     slice until it lands. Then "Not in this PR" has to state that in the first
     line, name the pull request it depends on, and list the files this one
     actually adds — otherwise the body describes a diff the reviewer is not
     looking at.

   `pdkit slice set` warns about this at the cut, which is the last point where
   choosing independence is still cheap.

   Then start the next slice at step 1. The issue returns to
   `preflight-green` for each; an issue with three slices passes through that
   state three times.

## What the gate will refuse, and why arguing with it is wrong

- No token → the push is blocked. Ask, do not rephrase the command.
- A token for another branch → blocked. That is the point of one token per
  branch.
- An expired token → blocked. Ten minutes, so consent cannot be accumulated.
- `--force` without `--force-with-lease` → blocked always, token or not.

If a refusal looks wrong, `pdkit doctor --gate-selftest` answers whether the
gate is working. A refusal that is genuinely wrong is a bug worth a report;
working around it by spelling the command differently is not a fix, and the
parser was written for exactly that attempt.

## Step 6 does not compress

The one failure mode this whole design cannot prevent is a human pressing yes
without reading. It is mitigated by showing something worth reading — the
actual body, the actual branch — and by a TTL short enough that consent cannot
be banked. Printing "ready to push?" instead would hand that mitigation back.

## Next

`/pd:pr-status` — CI, review and idleness across every open pull request. When a
reviewer answers, `/pd:pr-sync <pr>`.
