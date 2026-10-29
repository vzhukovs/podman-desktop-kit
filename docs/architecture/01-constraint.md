# The constraint everything follows from

[Architecture](README.md) › 1 of 7

We work in a fork of a repository we do not own. That forbids three things other
workflow tools take for granted:

1. **State cannot live in the tree.** It would show up in a diff and then in a
   pull request. State lives in `$PDKIT_HOME`, keyed by issue number — which also
   means several worktrees share one state rather than each keeping a copy.
2. **We cannot open scratch issues.** Tools that store epics as GitHub issues
   assume they own the repository. Our source of truth is local files.
3. **A careless push is public.** Hence [the gate](06-hooks.md).

---

**In depth** — [`specification/`](../specification/README.md):

- [§0 — the one structural divergence from the references](../specification/00-references.md)
- [§2.2 — State, outside the repository](../specification/02-plugin-structure.md#22-state-outside-the-repository)

**In practice** — [`configuration/`](../configuration/README.md), [`workflows/`](../workflows/README.md):

- [Where the state lives](../workflows/reference/state.md)
- [`$PDKIT_HOME`](../configuration/02-pdkit-home.md)

[Contents](README.md) · [The pieces](02-pieces.md) →
