# 6. Hooks — where a prompt does not guarantee

[Specification](README.md) › Section 6

Instructions in skills are advisory. Hooks are deterministic.

**The constraint that shapes the whole construction.** The `matcher` field in
`hooks.json` is compared **only against the tool name** (`Bash`, `Write`,
`Edit`) — never against the command string. `Bash(git push*)` cannot be written
as a matcher: such a hook either never fires or fires in the wrong place. So
`hooks.json` stays thin — seven entries, all on one binary — and the conditions on
the command string are applied by code in `lib/hooks/`.

| Event | Matcher | Handler |
|---|---|---|
| `PreToolUse` | `Bash` | `bin/pdkit hook pre-bash` |
| `PreToolUse` | `Write\|Edit` | `bin/pdkit hook pre-write` |
| `PostToolUse` | `Write\|Edit` | `bin/pdkit hook post-write` |
| `SubagentStop` | — | `bin/pdkit hook subagent-stop` |
| `SessionStart` | — | `bin/pdkit hook session-start` |
| `PreCompact` | — | `bin/pdkit hook pre-compact` |
| `UserPromptSubmit` | — | `bin/pdkit hook prompt-submit` |

The rules the handlers apply:

| Handler | Rule | Behaviour |
|---|---|---|
| `pre-bash` | `git push`, `gh pr create` | deny without a valid **`push`** token for that branch; otherwise allow and spend the token. Allowed without a token where the command is proven to act outside podman-desktop (below) |
| `pre-bash` | `gh pr edit/review/merge/comment`, `gh api` with a mutation | deny without a valid **`reply`** token for that PR. Such writes belong to no branch, and the token is not spent: the unit of consent is the batch |
| `pre-bash` | `gh issue comment`, `gh issue create/edit/close` | **deny always.** No state authorises a write to the tracker, and the one route that produces issue text says a human posts it. A gate that cannot open is worse than a refusal that says what to do |
| `pre-bash` | `git push --force` without `--force-with-lease` | deny always |
| `pre-bash` | `git add -A`, `git add .` | deny always, with a hint to list paths |
| `pre-bash` | `git rebase -i` | deny, hint `git reset --soft <base>` — husky's `commit-msg` appends `Signed-off-by` and then rejects the duplicate it created |
| `pre-bash` | `git commit --no-verify` | deny |
| `pre-write` | a path outside the active task's `Owns` | deny |
| `pre-write` | the active task's `Owns` is recorded and **empty** | deny every path: the plan made it a verification, and a verification writes nothing. Empty is not missing |
| `pre-write` | no `Owns` recorded for the active task | allow with a message naming `pdkit task sync` — nobody has synced the plan, so nothing is known rather than nothing is owned |
| `pre-write` | no active task in this working tree | allow — the restriction belongs to executing a planned task, not to having the plugin installed |
| `post-write` | a new file without the SPDX header | exit 2 with the text to paste |
| `post-write` | `*.ts` under schemas | remind about `generate:schemas`, mark `schemas_dirty` |
| `subagent-stop` | any agent other than `pd:pd-implementer` finishing | allow, after counting it. Only the implementer's finish claims the active task; a payload with no `agent_type` is treated as the implementer |
| `subagent-stop` | no `receipts/<TASK_ID>.md`, or it fails `validateReceipt` | exit 2 with the exact command to run |
| `subagent-stop` | a real receipt with `exitCode ≠ 0` | exit 2: the `Done when` command did not pass |
| `subagent-stop` | the same run has stopped `STALL_LIMIT` (3) times with no capture of the task between, e.g. `pdkit receipt write` cannot run because `Done when` is prose | the third refusal adds that the next stop is let go; the fourth stop is allowed with rule `stalled`. Nothing writes `task-receipt … accepted`, so the task stays unproven and the audit reports it. Without this, a failure that records no attempt would hold the agent forever |
| `subagent-stop` | this is the `exec.max_attempts`-th failure in a row | exit 2, with a **different** message: the task is blocked, and the question is not "fix it and capture again" but "what changed between the second attempt and the third". Exit 2 on `SubagentStop` keeps the subagent running, so when the host asks again (`stop_hook_active`) it is let go with the same message rather than held for a fourth try |
| `session-start` | — | inject the summary: active issue, state, next step. This is re-anchoring |
| `pre-compact` | — | flush the active state to the journal so compaction does not eat the task context |
| `prompt-submit` | `/pd:<skill> <n>` whose argument-hint is an issue or a registered pull request, and the tree is another issue's while the issue's work is in a named worktree or branch | add the context: this tree, where the issue's work is, and that the number is not a typo. Never blocks — a block on this event discards the prompt — and writes nothing. Any other prompt returns before git or the state directory is touched, because it runs on every message |

**Command recognition is not substring search.** `lib/hooks/command-parse.js`
strips leading assignments, splits on `&&`, `||`, `;`, `$()` and backticks, sees
into subshells and brace groups, resolves a program named by path, unquotes
argv[0], and strips **wrapper programs**. That last one is not about any
particular tool: hooks on the Bash tool are global, so a wrapper can appear in
this project without this project being told, and the question is never "did
somebody mean to wrap it" but "what is going to run".

It also moves **options written before the subcommand** — git's `-C`, `-c`,
`--git-dir`, `--work-tree`, gh's `-R` — out of the arguments and into a list of
their own. Every rule matches on an argument prefix, and until that was done
`git -C <dir> push` had `-C` where the prefix expects `push` and matched no rule
at all. The list is kept, not dropped, because it says where the command acts.

A **deny anywhere in the line refuses the line**, before any token is asked
about. A token for the push in `git push && gh issue comment …` is not consent
for the comment.

## The gate guards podman-desktop, and stands aside only where that is proven

Hooks on the Bash tool are global, so the token rules above used to apply in
every repository on the machine — this plugin's own checkout included, where
the only way to push was a `/pd:pr` flow built for somebody else's project.
`lib/hooks/scope.js` now lets a gated command (`push` or `reply` kind) run
without a token **only when it is proven to act outside podman-desktop**:

- the working tree has no remote whose slug is `repo.upstream` or `repo.fork`,
  or whose repository name is `podman-desktop` — the last one is what keeps a
  fork clone gated before `pdkit init` has filled `repo.fork`;
- the line names neither slug nor the name as a whole word (`podman-desktop.git`
  matches, `podman-desktop-kit` does not), so a URL or `gh -R` pointing there is
  gated;
- nothing in it moves where the command runs: no `cd`, `pushd` or `popd`, no
  `git -C`, `--git-dir` or `--work-tree`, no `GIT_DIR`, `GIT_WORK_TREE` or
  `GH_REPO` in the line or in the hook's environment;
- the configuration loaded and the working tree is a repository.

The burden of proof is on "outside" on purpose. A wrong "inside" is one refusal
in a repository that did not need guarding; a wrong "outside" is an ungated push
to upstream. So every failure — a config that does not load, a directory that
is not a repository, a `git` that cannot be run — is "inside", and the gate
decides as before. Deny rules are untouched: force push, `--no-verify`,
`add -A`, `rebase -i` and tracker writes are refused everywhere. Each command
the gate stands aside for is written to the journal as `allowed-outside`, so
standing aside does not leave the same trace as never running.
`pdkit doctor --gate-selftest` probes both sides, in throwaway repositories, so
it does not depend on where it is run from.

Two consequences of the rules living in code rather than in JSON: they are
versioned with the plugin, and they are unit-tested. For a circuit where a
mistake costs public noise in somebody else's repository, that is not a luxury.

## Two kinds of token

Until stage 4 every outward write was tied to a branch, and `gate.open` required
a branch name parsed as `DESKTOP-<n>/…`. A reply to a review thread and a
`resolve` are also writes into somebody else's repository, but they have no
branch at all, and at that moment the issue sits in `review-in-progress` rather
than `preflight-green`. No token of that shape could be issued.

Hence `--kind push` (per branch, only from `preflight-green`) and `--kind reply`
(per PR, from `pr-open` and `review-in-progress`). The eligible states live in
code (`state.GATE_ELIGIBLE`, a map by kind), not in the config: the only thing a
config key could do is widen the list, and a widened push list is a token issued
before preflight.

**This also closed a hole nobody had seen.** For commands with no branch of their
own, `dispatch.js` fell back to the current branch. So the token issued to push
slice #1 also authorised a review reply, a comment in somebody else's tracker,
and any `gh api` mutation: one confirmation, given for publishing code, working
for writes nobody was asked about. Token kinds remove that not by adding a check
but by making keys of different kinds unfindable for one another.

A hand-written `gh api graphql` mutation is a separate case: the PR number is
nowhere in it, so there is nothing to check a token against. Such a command is
refused with a hint to use `pdkit pr reply --pr <n>` rather than matched against
whatever token happens to be lying around.

## One consent, two writes

Publishing a branch takes two commands — `git push`, then `gh pr create` — and
the push spent the token the pull request then needed. `/pd:pr` has documented
that exact pair since it was written, so **the documented sequence could not
work**, and it was found by running it: on DESKTOP-18832 the refusal arrived
after the push, leaving the one state worse than either outcome — a public branch
with no pull request to explain it.

Issuing a second token was the other repair and it is the wrong one. What a human
reads at `gate open` is the body and the branch, together; asking again splits one
reading into two confirmations, which is the fatigue [section 4](04-contracts/README.md) says a gate cannot
afford — and the second confirmation would come after the irreversible half.

So a push token carries two **uses**, `push` and `pr`, spent separately. One
token, one push is untouched: a token that has pushed cannot push again, only do
the other thing it was granted for. The order is fixed and not symmetric —
opening the pull request spends the token whole, so a push may precede it and
never follow it. A token that had opened a pull request and kept its push would
put new commits on a branch already under review, with nobody confirming them in
the moment.

Reply tokens are unchanged: no uses, spent by the TTL rather than on first write,
because what they authorise is the batch of drafts somebody read in one go.

## Receipts, and why the ceiling holds

The two `subagent-stop` rows rest not on the strictness of the validator but on
**who produces the receipt**. `pdkit` does: `pdkit receipt write --issue <n>
--task T1` reads the command out of the task's `## Done when`, runs it through
`lib/evidence.js` (by spawning it directly, so nothing can sit between the
command and its output), and records what it printed. There is no parameter
through which an agent could hand over text — the "summarise the run
convincingly" path is closed by the absence of an input, not by a check. The
validator catches the remainder: a file edited by hand (the digest over the
`## Output` block stops matching) and a truncated capture (`complete: false`).

**The attempt ceiling holds by the same device.** What increments the count is a
capture with a non-zero exit — the same input that decides everything else about
completion. There is no input through which an agent could declare "this was the
first attempt". Two things reset it, and both mean somebody went through the
task: a green capture, and an explicit unblock with a reason. The config
(`exec.max_attempts`) can only weaken it — zero switches blocking off entirely —
and that is deliberate: somebody who decides a fourth attempt is sensible says so
once, rather than learning to scroll past a message.

The separation of duties is strict: `validateReceipt` answers only "is this a
real capture", not "did the run succeed". A red `pnpm test:main` produces a
**valid** receipt — it is the proof that matters most — and the hook decides "the
task is not done" by reading `exitCode`. A validator that rejected evidence for
proving a failure would return us to receipts it is profitable not to attach.

---

**In brief** — [`architecture/`](../architecture/README.md): [6 · Hooks](../architecture/06-hooks.md)

**In practice** — [`workflows/`](../workflows/README.md):

- [The push gate](../workflows/reference/push-gate.md)
- [The ownership hook](../workflows/reference/ownership.md)
- [Receipts](../workflows/reference/receipts.md)
- [§15 — A task that has failed three times](../workflows/15-task-failed-three-times.md)

← [5 · Agents and model routing](05-agents.md) · [Contents](README.md) · [7 · Preflight](07-preflight.md) →
