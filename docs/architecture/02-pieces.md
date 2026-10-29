# The pieces

[Architecture](README.md) › 2 of 7

| Piece | Role |
|---|---|
| [`bin/pdkit`](../../bin/pdkit) + [`lib/`](../../lib/) | everything deterministic: state machine, IDs, slicing, gates, preflight, validation evidence |
| [`skills/`](../../skills/) | the workflow surface — what you invoke |
| [`agents/`](../../agents/) | bounded workers with their own context |
| [`hooks/`](../../hooks/) | the rules that a prompt cannot guarantee |
| [`knowledge/`](../../knowledge/) | upstream constitution, shipped with the plugin |
| [`templates/`](../../templates/) | the shape of every artefact |

The split is not stylistic. Anything that must be **true** is in `lib/` and
`hooks/`, where it can be tested. Anything that requires **judgement** is in
`skills/` and `agents/`. A rule stated only in a prompt is a rule that holds most
of the time.

---

**In depth** — [`specification.md`](../specification.md):

- [§2 — Plugin structure](../specification.md#2-plugin-structure)
- [§5 — Agents and model routing](../specification.md#5-agents-and-model-routing)

← [The constraint](01-constraint.md) · [Contents](README.md) · [The lifecycle](03-lifecycle.md) →
