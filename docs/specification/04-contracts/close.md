# `/pd:close <issue>` — the end of the cycle

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:close`

`pdkit close --issue <n>` collects facts: what merged and when, how each
amendment ended up — its status read from the amendment file, which is what
`amendment approve` rewrites, and who decided it read from the journal, which is
the half the file does not keep — which drift and regression events the journal
recorded, which checks went red on the way. Which of that is knowledge worth adding to `knowledge/` is
the human's call; `close` writes nothing there itself.

Two mechanical steps: cleaning up the issue's working trees (`worktree remove`,
refusing on an unmerged branch), and **the transition to `merged` only on the
`prs.json` rollup**. An unclosed PR produces a refusal listing the numbers.

**Deferrals still open are named, and do not block.** Closing is the last step,
so there is no later gate to catch them at — which reads as an argument for
refusing until the other half is weighed: a gate standing between a finished
issue and its terminal state is paid every time and earns its keep almost never,
and that is the reasoning `unverified` already settled. What keeps the promise is
not the gate but the journal: `pdkit defer list` still answers after the issue is
`merged`.

---

← [`/pd:resume`](resume.md) · [Contents](../README.md) · [`/pd:reset`](reset.md) →
