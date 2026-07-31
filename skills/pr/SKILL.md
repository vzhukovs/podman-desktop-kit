---
name: pr
description: "Create branches and pull requests. The only command that writes to GitHub."
argument-hint: "<issue-number> [slice]"
disable-model-invocation: true
model: opus
---

The only command in this plugin that writes to someone else's repository.
Order matters and is not negotiable.

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

4. **Body.** `pdkit render prBody --issue <n> --values <f> --strip-comments`.
   Write it to a file. The four upstream headings are not ours to rearrange —
   a podman-desktop reviewer scans for their own.

   - `Closes #<n>` in the last slice of a stack, `Part of #<n>` in the rest;
     on the quickfix route, a single `Fixes #<n>` and no coverage table.
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
   pdkit state <n> --to preflight-green
   pdkit gate open --issue <n> --branch <b>
   git push origin <b>
   pdkit pr create --issue <n> --branch <b> --title <t> --body <file>
   ```

   `pdkit pr create` verifies and spends the token itself. If you open the PR
   any other way, do it after `gate open` and expect the hook to spend the
   token on the `gh` call.

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
