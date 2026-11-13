# `/pd:plan-review <issue>` — reviewing the plan before any code

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:plan-review`

Fresh context, through `pd-plan-critic`. **The ordering matters more than the
content: machine first, then model.**

1. `pdkit plan check <n> [--json]` — mechanical failures. Template sections
   present; `Owns` exclusive between tasks; `Done when` a command in backticks
   rather than prose; every R-ID closed by at least one task and every task
   citing an existing R-ID; `e2e coverage` filled in; `Slice hypothesis`
   non-empty; no `[NEEDS DECISION]` left; no `Context` line saying something is
   absent that cites neither a `file:line` nor a `searched:` query; every
   `- After:` names a task the plan has, and no two tasks wait on each other.
   With `probe.json` on record (`pdkit plan probe <n>`, run on the base
   branch), it also warns about every live task whose `Done when` was never
   run, ran as another command, or did not exit 0 — with the last line it
   printed.
2. `pd-plan-critic` receives `pdkit plan brief <n>` **as it prints it**: where
   the plan, the research and the code are, that report, what the last round
   accepted and every round rejected, and the shape of the report. The
   orchestrator fills in the report's language and may append verified facts,
   never hints on where to look. The critic spends itself on the questions code
   cannot check: is this task needed at all, does a utility for it already
   exist, and does each red probe fail because the code is not written yet or
   because the command can never pass.

The split rests on the same argument as the API-surface grep in [section 7](../07-preflight.md): this
is not a heuristic for an agent, it is a grep. An Opus looking for an overlap
between `Owns` lists is an Opus that may not find it; `pdkit plan check` cannot
fail to.

The output is `plan-review.md`, and the state does not move: a red `plan check`
means the plan is rewritten, not that approval is refused, and the human decides.
An earlier round's file is kept as `plan-review.r<k>.md`.

The human's decisions go into `plan-review.md` as `## Operator decisions
(round N)`, one line per item. While that round has not been applied,
`pdkit next` names `/pd:plan <n>` with nothing after it: `/pd:plan` reads the
decisions itself, applies the accepted ones, and closes the round with
`pdkit plan revised <n>`.

---

**In practice** — [`workflows/`](../../workflows/README.md):

- [§1 — A bug fix](../../workflows/01-bug-fix.md)

← [`/pd:plan`](plan.md) · [Contents](../README.md) · [`/pd:validate`](validate.md) →
