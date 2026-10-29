# Known weaknesses

[Architecture](README.md) › 7 of 7

Stated rather than discovered later:

- A fresh-context auditor of the same model catches drift from the plan, not blind
  spots shared with the model that wrote the code.
- Slicing a finished diff is expensive. That is why the plan carries a slice
  hypothesis.
- `Patch comes off` is a textual check, and named for it: the diff applies in
  reverse. Whether the build survives a revert is measured at +100% per slice
  (+26% narrowed to typecheck) and is deliberately not bought — the revert that
  matters happens weeks later, against a tree that has moved.
- Stacked PRs are fragile, which is why independent slices are the default.
- Consent fatigue is real. The gate prints the PR body and branch list rather than
  a yes/no prompt, because that is the thing worth reading.
- Validation proves an artefact was captured, not that the artefact shows the
  right thing. Whether the screen was correct stays with a human.
- Lists in the config replace rather than merge, so a list copied by `init` and
  never edited stops tracking the shipped default. `doctor` reports it; nothing
  prevents it, because silently re-extending a list somebody edited would be
  worse.

---

**In depth** — [`specification.md`](../specification.md):

- [§11 — Known weaknesses of this design](../specification.md#11-known-weaknesses-of-this-design)
- [§13 — Status: what has been verified, and what has not](../specification.md#13-status-what-has-been-verified-and-what-has-not)

← [Hooks](06-hooks.md) · [Contents](README.md)
