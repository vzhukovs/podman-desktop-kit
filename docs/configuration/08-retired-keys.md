# Retired keys

[Configuration](README.md) › 8 of 8

`pdkit init` copies the shipped config whole, so a key the plugin stops reading
survives in your own file looking exactly like a setting you chose.
`/pd:doctor` reports any it finds under `config:gates`, naming the key and what
to do. The fix is always the same: delete it.

---

**The design** — [9 · Configuration](../specification/09-configuration.md)

← [Hooks other tools install](07-hooks-from-other-tools.md) · [Contents](README.md)
