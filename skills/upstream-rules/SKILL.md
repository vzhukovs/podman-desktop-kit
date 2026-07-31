---
name: upstream-rules
description: "The non-negotiable rules of the podman-desktop repository: SPDX headers, conventional commits with a package scope, Signed-off-by, schema regeneration, squashing without interactive rebase."
when_to_use: "Triggers when a commit is about to be made, a new file is created, or a schema is touched."
---

Answer from `knowledge/upstream-rules.md`. State the rule **and what happens
upstream when it is broken** — a rule without its consequence reads as a
preference, and preferences get skipped under time pressure.

Everything below is checked against the repository rather than remembered. If
something is not in `knowledge/upstream-rules.md`, say that it is our own
discipline rather than upstream's; three of the four rules that file started
with turned out to be wrong when measured.

## Rejected by a hook or by CI

- **License header.** The Red Hat Apache block with the SPDX line *inside* it.
  A bare `// SPDX-License-Identifier: Apache-2.0` is not the house format. The
  `post-write` hook offers the exact block to paste.
- **One `Signed-off-by` per commit.** `.husky/commit-msg` appends it when
  missing and then rejects the commit if it appears twice.
- **Conventional commit type**, from the list in `CONTRIBUTING.md`. **The scope
  is optional** — say so plainly. Use one anyway, because it tells a reviewer
  which area they are being asked about, but never report a missing scope as a
  defect in somebody else's PR.
- **Regenerated schemas.** Touching a schema means `pnpm generate:schemas` and
  committing the result. A stale generated schema fails CI long after the change
  that caused it, usually inside someone else's PR.
- **Lint, format, typecheck, unit tests.** `pnpm lint:check` — there is no
  `pnpm lint` — and `pnpm test:unit`, because plain `pnpm test` drags in e2e.

## The one that surprises everybody once

Squash with `git reset --soft <base> && git commit`, **not** `git rebase -i`.
The commit-msg hook appends `Signed-off-by` to a message that already carries
one from the commits being squashed, then rejects the duplicate it just made.
The Bash hook refuses `git rebase -i` for this reason and says so.

## Held to it by a reviewer, not by a machine

- `packages/extension-api/src/extension-api.d.ts` is the public surface.
  Touching it makes the change a compatibility question — and a type that lives
  in `packages/main` can be declared there too, so location does not tell you.
- `Steps to check` in the PR body, at any diff size. A reviewer should not have
  to work out how to verify the change.
- Anything CI cannot judge — packaging, platform behaviour, a manual check —
  belongs in `Notes for reviewers`, not in the commit you hope nobody reads.

## Do not turn this into a lecture

When this triggers on a commit or a new file, name the one or two rules that
apply to what is happening and stop. `pdkit preflight` checks all of it
mechanically before anything is pushed, so the value here is timing — catching a
missing header while the file is open — not coverage.
