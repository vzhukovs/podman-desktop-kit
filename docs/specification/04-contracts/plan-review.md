# `/pd:plan-review <issue>` — reviewing the plan before any code

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:plan-review`

Fresh context, through `pd-plan-critic`. **The ordering matters more than the
content: machine first, then model.**

1. `pdkit plan check <n> [--json]` — mechanical failures. Template sections
   present; `Owns` exclusive between tasks; `Done when` a command in backticks
   rather than prose; every R-ID closed by at least one task and every task
   citing an existing R-ID; `e2e coverage` filled in; `Slice hypothesis`
   non-empty; no `[NEEDS DECISION]` left.
2. `pd-plan-critic` receives the plan **and that report**, and spends itself on
   the question code cannot check: is this task needed at all, and does a utility
   for it already exist.

The split rests on the same argument as the API-surface grep in [section 7](../07-preflight.md): this
is not a heuristic for an agent, it is a grep. An Opus looking for an overlap
between `Owns` lists is an Opus that may not find it; `pdkit plan check` cannot
fail to.

The output is `plan-review.md`, and the state does not move: a red `plan check`
means the plan is rewritten, not that approval is refused, and the human decides.

---

**In practice** — [`workflows/`](../../workflows/README.md):

- [§1 — A bug fix](../../workflows/01-bug-fix.md)

← [`/pd:plan`](plan.md) · [Contents](../README.md) · [`/pd:validate`](validate.md) →
