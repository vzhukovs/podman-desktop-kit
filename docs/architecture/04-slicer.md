# What the slicer is, in one paragraph

[Architecture](README.md) › 4 of 7

A slice is a base plus a set of files. It is verified before any branch exists, by
applying the diff restricted to those files to a scratch worktree from `main` and
running the repository's own typecheck, lint and tests there. Green means it
branches from `main`; red means it needs a stack, and the red run is the evidence
for that stack. The result is produced by `pdkit` and stored with the digest of
the diff it describes, so preflight can ask later whether it is still about this
diff — which is also how a materialized branch is checked against what was
verified. Nothing in that sentence has a parameter an agent could supply.

---

**In depth** — [`specification/`](../specification/README.md):

- [§4 — `/pd:slice`](../specification/04-contracts/slice.md)
- [§7 — Preflight](../specification/07-preflight.md)

**In practice** — [`workflows/`](../workflows/README.md):

- [§3 — A feature, cut into several pull requests](../workflows/03-feature-in-several-prs.md)
- [What preflight actually runs](../workflows/reference/preflight.md)

← [The lifecycle](03-lifecycle.md) · [Contents](README.md) · [Validation](05-validation.md) →
