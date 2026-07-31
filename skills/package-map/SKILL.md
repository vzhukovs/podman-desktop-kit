---
name: package-map
description: "Explains which podman-desktop package owns a piece of functionality and which layer is responsible. Use when asked where something lives, which package to change, or what a layer is for."
when_to_use: "Triggers on questions like \"where does X live\", \"which package handles Y\", \"what layer is responsible for Z\"."
---

Two sources, and they answer different halves of the question.

```
pdkit packages --of packages/main/src/plugin/exec.ts   # which package owns a path
pdkit packages                                          # every package, by layer
```

The generated map (`$PDKIT_HOME/package-map.json`, built by `pdkit init` from
`pnpm-workspace.yaml`) knows what exists. `knowledge/package-map.md` holds what
a generator cannot know: intent, boundaries, and why the layer order is what it
is. Answer from the first, explain from the second.

## What a complete answer contains

Not just the package — the **layer**, and what the layer implies:

```
extension-api → main → preload → renderer + ui → extensions/* → tests → website/docs
```

That order does two jobs at once. It is merge order, because upper layers depend
on lower ones. And it is **reviewer selection**: the people who review a public
API change are not the people who review a UI change, so a change spanning both
waits for both. That is why layers decide slicing, and why "which layer" is
usually the more useful half of the answer.

## The boundary that catches people

Utilities get duplicated between `packages/main` and `packages/renderer`. Before
concluding that a helper needs writing, look in both — reviewers do, and they
push back on it.

The other one: `packages/extension-api` is a public contract. A type that looks
like an internal utility can be declared there too, which makes changing it a
compatibility question rather than a refactor. `preflight` greps for exactly
this; do not rely on the file's location to tell you.

## When the map cannot answer

- **No map** — `pdkit init` has not run in this repository.
- **Layer `other`** — `packages/api`, `packages/webview-api` and `storybook`
  match no rule in `slicing.layer_order`. Say so rather than guessing a layer:
  merge order for those three is genuinely undecided, and it is an open question
  in section 13 of the spec.
- **The path is not in any package** — say that too. Repository-root files
  (`.github/`, config, scripts) belong to no layer and are reviewed by whoever
  owns the area they configure.
