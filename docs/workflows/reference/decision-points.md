# Decision points that stay yours

[Workflows](../README.md) › [Reference](README.md)

The plugin stops and waits at exactly five places, and none of them can be automated
away:

1. Plan approval — after `[NEEDS DECISION]` items are resolved.
2. Slice graph approval.
3. Push confirmation — per branch, in the same turn, never carried over.
4. Plan amendments arising from review.
5. Anything added to `knowledge/`, whether proposed by `/pd:close` after one issue
   or by `/pd:knowledge` over the whole base.

Three more are decisions the plugin refuses to make rather than waits on: publishing
a review of someone else's pull request, commenting in the upstream tracker, and
posting the findings of an `answered` issue. All three are writes into a project that
is not ours, and all three are refused by the hook rather than gated.

---

**The design** — [3 · Commands](../../specification/03-commands.md)

← [Measuring what a cycle costs](cost.md) · [Reference](README.md) · [Revising what the plugin thinks it knows](knowledge.md) →
