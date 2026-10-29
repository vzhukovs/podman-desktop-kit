# The push gate

[Workflows](../README.md) › [Reference](README.md)

Nothing reaches GitHub without a consent token, and a token is issued for one
branch, expires in ten minutes, and is spent on first use.

```
pdkit gate open --issue 12345 --branch DESKTOP-12345/slug
git push origin DESKTOP-12345/slug
pdkit pr create --issue 12345 --branch DESKTOP-12345/slug --title … --body body.md
```

`pdkit publish --issue 12345 --branch DESKTOP-12345/slug --title … --body body.md`
is the same sequence, with `pdkit state 12345 --to preflight-green` in front, as
one command. It asks nothing — the reading happens before it — and has no flag
that skips or loosens a step. It checks a stacked slice's base before pushing
rather than after, and if it stops between the push and the pull request it
says so: the branch is public, the token has its pull-request half left, and
the `pdkit pr create` to finish with is printed. With `--pr <k>` instead of a
title and body it updates an open pull request: `push --force-with-lease`, then
back to `pr-open`.

`gate open` refuses unless the issue is in `preflight-green` and the branch belongs
to that issue. Both are checked inside `pdkit` rather than asked of the caller.

Refused without a token, and refused the same way whether you type it or an agent
does:

- `git push` in any shape — chained behind `&&`, in a subshell, in a command
  substitution, named by absolute path, or behind a wrapper program (`env`, `sudo`,
  `nice`, `nohup`, …)
- `gh pr create|edit|merge|review`, `gh issue create|comment|close`
- `gh api` with a mutating method, and `gh api graphql` carrying a mutation

Refused **always**, token or not:

- `git push --force` without `--force-with-lease`
- `git add -A` and `git add .`
- `git rebase -i` — the husky `commit-msg` hook adds `Signed-off-by` to a message
  that already has one, then rejects the duplicate it created. Squash with
  `git reset --soft <base> && git commit`
- `git commit --no-verify`

Ordinary work is untouched: `git status`, `git add <path>`, `git commit -m`,
`gh pr view`, `gh api` reads. If a refusal looks wrong, `pdkit doctor
--gate-selftest` says whether the gate is behaving; rephrasing the command is not a
fix, and the parser was written for exactly that attempt.

---

**The design** — [6 · Hooks](../../specification/06-hooks.md), [`/pd:pr`](../../specification/04-contracts/pr.md), [architecture · Hooks](../../architecture/06-hooks.md)

← [What preflight actually runs](preflight.md) · [Reference](README.md) · [The ownership hook](ownership.md) →
