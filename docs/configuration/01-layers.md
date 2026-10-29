# Layers

[Configuration](README.md) › 1 of 8

```
defaults/config.yaml        shipped with the plugin
  ↓ overridden by
$PDKIT_HOME/config.yaml     your settings
  ↓ overridden by
<repo>/.pdkit.yaml          per-repository
```

Put `.pdkit.yaml` in `.git/info/exclude`, **not** `.gitignore`. The fork's
`.gitignore` is upstream's file; editing it puts a stray line in every pull
request you open.

Maps merge key by key, so overriding `slicing.max_files_per_slice` leaves
`slicing.strategy` alone. **Lists are replaced whole**, never merged: a
`never_rewrite` or `layer_order` assembled from two halves is a list nobody
wrote, and both decide whether a command runs and in what order slices merge.

That has a cost worth knowing about. A list `init` copied verbatim and you never
edited stays at the value shipped that day, so a later change to the default
never reaches you — silently, because the pinned value is still perfectly valid.
`doctor` reports it as `config:arrays`. Delete the key to follow the default
again, or extend it deliberately.

## The YAML subset

`lib/yaml.js` reads nested maps, block and inline sequences, scalars, quotes
and comments. It refuses anchors, multiline scalars (`|`, `>`), tags and
multi-document files with the line number. This is deliberate: a reader that
skipped a construct it did not understand would hand you a config that looks
loaded and is missing a key, and the loss would surface later as a wrong
decision somewhere unrelated.

One departure from YAML 1.1: `on` and `off` stay strings, because the config
uses them as enum members next to `auto` (`mcp.playwright: auto | on | off`).

---

**The design** — [9 · Configuration](../specification/09-configuration.md), [11 · Known weaknesses](../specification/11-known-weaknesses.md)

[Contents](README.md) · [`$PDKIT_HOME`](02-pdkit-home.md) →
