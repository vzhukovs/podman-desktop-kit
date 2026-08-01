---
name: knowledge
description: "Revise the shipped knowledge base against what recent work actually showed."
disable-model-invocation: true
model: opus
---

`knowledge/` ships with the plugin and is read by every later issue. Nobody
re-derives what it states as settled, which is exactly why being quietly wrong
there is expensive.

Periodic, not per-issue. `/pd:close` proposes what one finished issue taught,
while the details are still live; this is the pass over everything.

## 1. What a grep can already answer

```
pdkit knowledge check --json
```

Paths and `file:line` citations that no longer resolve in the fork, a layer
chain that has drifted from `slicing.layer_order`, `pitfalls.md` entries that
stopped following the shape that file declares, a file with no
`## What to add here`, and the issues whose journal recorded something notable.

Do not re-derive any of it by reading the four files. That is the arithmetic
this command exists to do — and it is also the part a re-read is worst at, since
the model re-reading is the one that would have to notice its own earlier
mistake.

## 2. What is left

Three questions, none of which a grep reaches:

1. **Which entry was never true?** A dead path is easy. An explanation that was
   wrong when it was written survives every mechanical check there is.
2. **Which lesson is stated so it will not be acted on?** An entry that reads as
   general advice changes nothing on a future run. `pitfalls.md` has a shape for
   this reason: what it looks like, what it actually is, why it matters, what
   catches it now.
3. **What did recent work teach that never made it in?** Work from the
   candidates above, and be strict — see below.

## 3. The bar for a new entry

A finding belongs here only if it **would change what a future run does**. Not a
narrative of what happened, not "we learned to be careful". A trap that cost
time and would cost it again; a review expectation nobody had written down; a
package boundary that turned out to be different from what a plan assumed.

Each file's `## What to add here` states its own criterion. Read it before
proposing anything for that file — it is part of the base, and ignoring it is
how a base grows entries nobody agreed to.

## 4. Propose, do not write

Show the additions, the removals and the rewrites, and let the user approve
them. `pdkit knowledge check` never edits `knowledge/`, and neither should this
skill without a yes. A base that grows on its own is a base people stop reading,
and once they stop reading it every entry in it is dead weight.

## The bridge outward

```
pdkit knowledge export --json
```

Prints the base for a push into basic-memory, when that server is configured.
One direction only: these files are the source of truth, and an import path
would create a second one that drifts. pdkit prints; the write is yours.
