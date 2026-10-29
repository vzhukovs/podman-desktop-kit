# Where the state lives

[Workflows](../README.md) › [Reference](README.md)

`$PDKIT_HOME`, default `~/.pdkit/podman-desktop` — **outside the fork**, so nothing
the plugin records can end up in a pull request.

```
pdkit state 12345             # where an issue is, and where it may go next
pdkit journal --issue 12345   # why it got there
```

`state.json` knows *where*; the journal knows *why*. "Why is slice #2 stacked rather
than branched from main" is recoverable six months later only from the journal, which
is append-only and never rewritten.

Almost every entry is written by whatever produced the fact. The exception is a
conflict, because nothing can observe one:

```
pdkit journal conflict --issue 12345 --kind semantic --file packages/main/src/plugin/exec.ts \
  --commit a3f21e --resolution "upstream replaced the callback the plan built on" --amendment A1
```

Two event names, `conflict-mechanical` and `conflict-semantic`, and no way to name a
third. A command that wrote any event would let `preflight-green` be typed beside the
one preflight measured, and a reader cannot tell a typed event from a produced one.

The append-only rule is what makes [starting over](../16-starting-over.md)
safe to offer. `pdkit reset` clears the issue's artefacts, its consent tokens and
its active pointers — and writes one more journal entry rather than removing any,
so the attempt it forgets is still readable afterwards. Anything derived from the
journal reads it that way too: the attempt count stops at the last reset, because
the T1 after one is a different task from the T1 before it.

---

**The design** — [2.2 · State, outside the repository](../../specification/02-plugin-structure.md#22-state-outside-the-repository), [architecture · The constraint](../../architecture/01-constraint.md)

← [Revising what the plugin thinks it knows](knowledge.md) · [Reference](README.md) · [Where a session works](trees.md) →
