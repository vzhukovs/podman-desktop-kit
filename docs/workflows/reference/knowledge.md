# Revising what the plugin thinks it knows

[Workflows](../README.md) › [Reference](README.md)

```
/pd:knowledge
```

`knowledge/` ships with the plugin and is read by every later issue, so an entry that
quietly stopped being true costs more than a missing one.

```
pdkit knowledge check --json     dead paths, drifted layer order, entry shape
pdkit knowledge export --json    the base, for a one-way push to an external store
```

The check earns its keep immediately: on the machine this was written on it found
`slicing.layer_order` in `$PDKIT_HOME/config.yaml` still pinned to the value
`pdkit init` copied at stage 0, so three layers added two stages later had never
taken effect there. Arrays replace rather than merge — deliberately, so an edited
list is not silently re-extended — and the cost is that an unedited copy freezes.
`pdkit doctor` now reports that as `config:arrays`.

Nothing here writes to `knowledge/`. Additions are proposed and you approve them: a
base that grows on its own is a base people stop reading.

---

**The design** — [`/pd:knowledge`](../../specification/04-contracts/knowledge.md)

← [Decision points that stay yours](decision-points.md) · [Reference](README.md) · [Where the state lives](state.md) →
