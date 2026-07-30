---
name: upstream-rules
description: "The non-negotiable rules of the podman-desktop repository: SPDX headers, conventional commits with a package scope, Signed-off-by, schema regeneration, squashing without interactive rebase."
when_to_use: "Triggers when a commit is about to be made, a new file is created, or a schema is touched."
---

Answer from `knowledge/upstream-rules.md`. These are constraints, not suggestions: state the rule and what happens upstream when it is broken.

The one that surprises people: squash with `git reset --soft <base> && git commit`, not `git rebase -i`. The Husky commit-msg hook appends `Signed-off-by` and then rejects the duplicate it just created.

> Stub. Content is filled in from `knowledge/` as that base is written.
