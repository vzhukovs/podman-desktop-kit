## The package map

[Configuration](README.md) › 4 of 8

`init` generates `package-map.json` from `pnpm-workspace.yaml`, so it cannot
drift from the workspace. Regenerate it whenever the workspace file changes —
`doctor` warns when the map is older.

```bash
pdkit packages                                   # everything, grouped by layer
pdkit packages --of packages/main/src/index.ts   # which package owns a path
```

---

**The design** — [9 · The package map](../specification/09-configuration.md#the-package-map)

← [What each key does](03-keys.md) · [Contents](README.md) · [Model selection](05-models.md) →
