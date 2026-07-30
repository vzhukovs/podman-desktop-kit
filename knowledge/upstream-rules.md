# Upstream rules — podman-desktop

The constitution. These are not preferences, and a PR that breaks one of them
does not get discussed, it gets bounced. Every phase references this file, and
preflight enforces the mechanical parts.

> Stub. Verify each rule against the repository before relying on it; the
> entries below are the ones already observed, not an audit.

## Licensing

Every new source file carries an SPDX header:

```
// SPDX-License-Identifier: Apache-2.0
```

Enforced twice on purpose — the post-write hook catches it at creation, and
preflight catches anything that slipped through.

## Commits

- Conventional commits, with a **package scope**. The scope is not decoration:
  it is how upstream routes review.
- Exactly one `Signed-off-by` trailer per commit. Zero fails DCO.
- **Squash with `git reset --soft <base> && git commit`, never `git rebase -i`.**
  The Husky `commit-msg` hook appends `Signed-off-by` and then rejects the
  duplicate it just created. This one surprises everybody once.

## Schemas

Changing a schema means running `pnpm generate:schemas` and committing the
result. A stale generated schema fails CI long after the change that caused it,
usually in someone else's PR.

## Public API

`packages/extension-api/src/extension-api.d.ts` is the public surface. Touching
it brings obligations: backward compatibility, disposal semantics, and a section
in the PR body about both.

## Pull requests

- Small and single-layer. Mixing layers slows review more than size does.
- `Steps to check` with expected results, always, regardless of diff size.
- Tests are welcomed. e2e tests are welcomed and expensive — see `pitfalls.md`.

## What to add here

A rule that cost time to discover, stated with what happens when it is broken.
Not general good practice.
