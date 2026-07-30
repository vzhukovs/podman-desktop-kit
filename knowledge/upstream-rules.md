# Upstream rules — podman-desktop

The constitution. These are not preferences, and a PR that breaks one of them
does not get discussed, it gets bounced. Every phase references this file, and
preflight enforces the mechanical parts.

Verified against `podman-desktop/podman-desktop` at `b0e77bc` (2026-06-04).
Every rule below names what enforces it, so the next reader can re-check it
instead of trusting this file. Anything that could not be verified was removed
rather than softened.

## Enforced mechanically — CI or a hook rejects the change

### Licensing

Every source file carries the Red Hat Apache header, and the SPDX line lives
inside it. This is the house format, not a bare identifier line:

```ts
/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/
```

Checked: 60 of 60 sampled files under `packages/main/src` carry it. A new file
with only `// SPDX-License-Identifier: Apache-2.0` is not in the house format
and will be asked about in review.

### Sign-off

Exactly one `Signed-off-by` trailer per commit. `.husky/commit-msg` appends the
trailer when it is missing and then **rejects the commit if the trailer appears
twice**:

```sh
SOB=$(git var GIT_AUTHOR_IDENT | sed -n 's/^\(.*>\).*$/Signed-off-by: \1/p')
grep -qs "^$SOB" "$1" || echo "$SOB" >>"$1"
test "" = "$(grep '^Signed-off-by: ' "$1" | sort | uniq -c | sed -e '/^[ ]*1[ ]/d')" || exit 1
```

This is why squashing is done with `git reset --soft <base> && git commit` and
not with `git rebase -i`: the hook adds the trailer to a message that already
carries one from the commits being squashed, and then rejects what it just
created. It surprises everybody once.

### Commit messages

Conventional Commits, enforced by `pnpm commitlint` from the same hook.
`commitlint.config.cjs` is `{ extends: ['@commitlint/config-conventional'] }`.

The type is mandatory and comes from the list in `CONTRIBUTING.md`: `fix`,
`chore`, `docs`, `build`, `ci`, `feat`, `perf`, `refactor`, `style`, `test`.

**The scope is optional.** `CONTRIBUTING.md` writes the format as
`<type>[optional scope]: <description>`, and scope-less subjects land on `main`
regularly (`fix: replace shadow-black with --pd-modal-shadow…`). Use a package
scope anyway — it tells a reviewer which area they are being asked about — but
do not treat a missing scope as a defect in someone else's PR, and do not let
preflight block on it.

### Formatting and linting

Run before pushing; CI runs all of them:

| Command | What it covers |
|---|---|
| `pnpm lint:check` | ESLint over the workspace |
| `pnpm format:check` | Biome, plus prettier for `website/**/*.md` |
| `pnpm typecheck` | tsc/svelte-check per package |
| `pnpm test:unit` | vitest |
| `pnpm markdownlint:check` | website markdown only |

`.husky/pre-commit` runs `pnpm lint-staged`, so some of this is caught locally.

### Schemas

Changing a schema means running `pnpm generate:schemas` and committing the
result. The script builds `packages/main` and runs the generator, then formats
`schemas/` with Biome. A stale generated schema fails CI long after the change
that caused it, usually in someone else's PR.

## Documented in CONTRIBUTING — a reviewer will hold you to it

### Public API

`packages/extension-api/src/extension-api.d.ts` is the public surface. Touching
it brings obligations: backward compatibility, disposal semantics, and a
section in the PR body about both.

### Pull requests

The repository template (`.github/PULL_REQUEST_TEMPLATE.md`) has four sections,
and they are what a reviewer expects to find:

1. `What does this PR do?`
2. `Screenshot / video of UI` — required when the PR changes UI
3. `What issues does this PR fix or reference?` — include `Closes #XXX`
4. `How to test this PR?` — with the checkbox `Tests are covering the bug fix
   or the new feature`

Also from `CONTRIBUTING.md`:

- Break large PRs into smaller ones; squash commits into logical pieces.
- Changes made in response to review go in a **new commit**, so reviewers can
  see what changed between rounds. Do not force-push a rewritten history
  mid-review.
- One approval, two for a large code change. A large code PR needs proof of
  review or testing — a video or a screenshot.
- Confirm a significant change works on macOS, Windows and Linux.
- Do not enable auto-merge.

### What CI actually runs

Format and lint checking, cross-platform builds (Windows, macOS, Linux), unit
tests on Linux, and e2e tests on Linux. **E2E failures do not block merging**
— they are known to be unstable — which means a green PR is not evidence that
the e2e suite passed. Read the run.

## What to add here

A rule that cost time to discover, stated with what happens when it is broken
and what enforces it. Not general good practice, and nothing that has not been
checked against the repository.
