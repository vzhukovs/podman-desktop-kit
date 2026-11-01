# `/pd:knowledge` — revising what everything else leans on

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:knowledge`

`knowledge/` ships with the plugin and is read by every subsequent issue. A base
nobody weeds is a base people stop believing; and "re-read four files" is reading,
not revision.

The mechanical half, `pdkit knowledge check [--json]`:

| Checked | Why it is a grep |
|---|---|
| paths and `file:line` that no longer exist in the fork | a link to a vanished file is literally "an entry that is now wrong" |
| `package-map.md` against `package-map.json` and `slicing.layer_order` | drift is found mechanically and accumulates silently |
| the shape of `pitfalls.md` entries (Looks like / Actually / Why it matters / Caught by) | a template, not a judgment |
| a `## What to add here` section in every file | the acceptance criterion for new entries is part of the base itself |
| issues closed since the last revision carrying `conflict-semantic` or `slice-regressed` events | a list of harvest candidates, not the harvest |

Left to the model: an entry that was wrong from the start; a lesson worth
rephrasing; a finding that will change nothing in a future run and is therefore
not knowledge.

The boundary with `/pd:close`: `close` proposes additions from **one** issue,
right after the merge, while the details are alive. `/pd:knowledge` is a periodic
revision of **everything**, and its input is facts rather than recent memory.

`pdkit knowledge export --json` prints the base for an external memory store. The
bridge is one-way: writing is done by the skill, and there is no reverse import —
otherwise two sources of truth diverge and `knowledge/` stops being portable.

---

**In practice** — [`workflows/`](../../workflows/README.md):

- [Revising what the plugin thinks it knows](../../workflows/reference/knowledge.md)

← [`/pd:review-pr`](review-pr.md) · [Contents](../README.md) · [5 · Agents and model routing](../05-agents.md) →
