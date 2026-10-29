# Reference

[Workflows](../README.md) › Part IV

What the scenarios lean on: the gates, the hooks, the measurements, and the
rules for sessions. Each page stands on its own.

| Page | What it answers |
|---|---|
| [What preflight actually runs](preflight.md) | the three results, why `working-tree` comes first, the two passes |
| [The push gate](push-gate.md) | the consent token, `pdkit publish`, what is refused with and without one |
| [The ownership hook](ownership.md) | writes outside a task's `Owns` set, and the two deliberate allowances |
| [Receipts](receipts.md) | what finishes a task, and what is printed about the capture |
| [Calibrating the thresholds](thresholds.md) | `pdkit stats` against the four configured numbers |
| [One session per phase](sessions.md) | why a session per phase, which session and which model for every command, the turn budget |
| [Measuring what a cycle costs](cost.md) | `pdkit cost`, cost units, and the caveats it prints |
| [Decision points that stay yours](decision-points.md) | the five places the plugin waits, and the three it refuses |
| [Revising what the plugin thinks it knows](knowledge.md) | `/pd:knowledge` and `pdkit knowledge check` |
| [Where the state lives](state.md) | `$PDKIT_HOME`, `state.json` and the append-only journal |
| [Where a session works](trees.md) | the fork and the issue trees, how the hook moves a session, the commands that refuse in the wrong tree, `pnpm install`, and what to do when something looks wrong |

---

← [16 · Starting one issue over](../16-starting-over.md) · [Contents](../README.md) · [What preflight actually runs](preflight.md) →
