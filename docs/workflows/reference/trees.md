# Where a session works

[Workflows](../README.md) › [Reference](README.md)

```
podman-desktop/                    → the base branch, always   the template: fetch, trees made from it
pd-worktrees/DESKTOP-<n>/          → the issue's branch        everything done for the issue
pd-worktrees/verify-DESKTOP-<n>/                               slice verification; not yours to touch
```

**The fork stays on the base branch.** It is the template the trees are made
from, and it is never an issue's tree — not even on that issue's branch. Start
`claude` there. You do not `cd` into an issue's tree: the session is moved.

## What happens on `/pd:<skill> <n>`

The `UserPromptSubmit` hook reads the number in the command and the tree the
session stands in. For a skill that takes a pull request number — `/pd:pr-sync`
— it finds the issue through `prs.json`; a pull request no issue of ours knows,
such as one passed to `/pd:review-pr`, is not looked at.

| Where the issue's work is | What the hook does |
|---|---|
| the session is already in the issue's tree | nothing |
| nothing names the issue yet — no tree, no `DESKTOP-<n>/…` branch | nothing: it is the start of the work, and triage and planning run where you stand. **Except `/pd:exec`**, which writes code: it is told to create the tree with `pdkit worktree create --issue <n> --slug <…>` and move into it |
| the issue has a tree, and the session is elsewhere | tells Claude to call `EnterWorktree` with the tree's path, before anything else |
| the issue's branch is checked out in the fork | shows two commands, to run once you agree — `git -C <fork> switch main` and `pdkit worktree create --issue <n> --branch <b>` — then `EnterWorktree` |
| the issue's branch exists and is checked out nowhere | the same without the `git switch` |

What it prints, for the second case:

```
pdkit: /pd:pr-sync is about issue 18915 — pr-open, standard, and this tree is not its.
  here    : …/podman-desktop on main — the main checkout
  18915   : …/pd-worktrees/DESKTOP-18915 on DESKTOP-18915/1-quit-and-install-race
  Before anything else, move this session into the issue's tree. Do not cd, and do not run the command here.
  Call the EnterWorktree tool with path: …/pd-worktrees/DESKTOP-18915
  Subagents started after the switch work there too. Then carry on with the command as typed.
```

`EnterWorktree` rather than `cd`, because a `cd` moves one shell, while
`EnterWorktree` moves the session and every subagent started after it — and
subagents edit files wherever the session is. Claude Code may ask permission
for the tool; that is expected. Before agreeing to a `git switch` in the fork,
look at `git status` there: uncommitted changes are either carried along or
refused.

**One `claude` process works one issue.** `EnterWorktree` moves a session from
where it was started into a tree; between two issue trees it is not offered. To
change issue, quit and start `claude` in the fork again. Inside one issue,
`/clear` between phases as usual.

## When the session did not move

The commands themselves are the second line. Run in another issue's tree,
`pdkit preflight`, `pdkit audit`, `pdkit validate …`, `pdkit e2e stability`,
`pdkit task start` and `pdkit slice suggest|set|join|materialize|cascade` run
nothing and print one line to copy:

```
pdkit preflight: this tree is not DESKTOP-18967's, so nothing was run.
  …
  Run it where the issue is:
    git -C …/podman-desktop switch main && pdkit worktree create --issue 18967 --branch … && cd …/pd-worktrees/DESKTOP-18967 && pdkit preflight 18967
```

`pdkit publish`, `pdkit pr reply`, `pdkit defer` and `pdkit amendment` have no
such check; for them the hook is the only guard.

## Making the tree

```
pdkit worktree create --issue <n>              early, with no branch
pdkit worktree create --issue <n> --slug <s>   with the branch DESKTOP-<n>/<s>
pdkit worktree list                            what exists, and where
```

**A tree can be made as early as triage**, once the issue is certainly yours.
Without `--slug` it is created on the base branch with a detached HEAD, and is
still the issue's tree by its directory name; the branch is named later. From
then on any command about `<n>` moves the session there. Otherwise `/pd:exec`
makes it, with the slug, before its first task.

**Dependencies are not installed.** `worktree create` copies `.env` and the rest
of `worktrees.copy_files`, and nothing else. Run `pnpm install` in the tree
before its first build — `/pd:exec`, `/pd:validate`. The pnpm store is shared,
so it links rather than downloads, but `node_modules` is per tree and still
takes minutes on this workspace.

## A branch in two places

An issue whose tree exists while its pull request's branch is checked out in
the fork — where work begun before the trees were enforced is often found. Git
will not check one branch out in two trees, so it is moved by hand, after
`git status` in both shows nothing uncommitted:

```
git -C <fork> switch main
git -C pd-worktrees/DESKTOP-<n> switch <the pull request's branch>
```

## Something looks wrong

| You see | It means |
|---|---|
| the hook asks for `EnterWorktree` again in the same session | the session did not move, or the hook was given the old directory — report it |
| `pdkit: /pd:<skill> runs on X, and this session is on Y` | type `/model X`: a skill's model holds one turn — [Which session, which model](sessions.md#which-session-which-model) |
| a command refuses with `this tree is not DESKTOP-<n>'s` | Claude did not follow the hook; paste the line it printed |
| `pdkit pr diff` shows `outside slice #<i> after the push` | the pull request would carry files you did not approve — back to the decision table ([§7](../07-stale-pr.md#reading-pdkit-pr-diff)) |
| `git -C <fork> status` shows a `DESKTOP-…` branch | the fork has become a place to work again — [a branch in two places](#a-branch-in-two-places), or let the hook move it |

---

**The design** — [2.2 · State, outside the repository](../../specification/02-plugin-structure.md#22-state-outside-the-repository), [6 · Hooks](../../specification/06-hooks.md), [architecture · Hooks](../../architecture/06-hooks.md)

← [Where the state lives](state.md) · [Reference](README.md)
