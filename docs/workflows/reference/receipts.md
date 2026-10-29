# Receipts

[Workflows](../README.md) › [Reference](README.md)

A task is finished when the command in its `Done when` has been run and what it
printed has been recorded:

```
pdkit receipt write --issue 12345 --task T1
```

`pdkit` runs the command itself. There is no parameter for output text — the choice
between "the tests passed" and the test runner's own words is not offered — and the
digest it records over the captured block means a receipt edited afterwards stops
validating.

Completing a task without one is refused. So is completing one whose receipt records
a non-zero exit: that receipt is valid, and what it proves is that the work is not
done.

What it prints is not the run. The receipt holds every byte; the terminal gets its
path, the exit code, the duration and the digest, plus the last 40 lines when the
exit is non-zero — the failing assertion is at the end. `pdkit validate run` and
`pdkit e2e stability` answer the same way. The capture is never shortened, only
what is printed about it.

---

**The design** — [6 · Receipts, and why the ceiling holds](../../specification/06-hooks.md#receipts-and-why-the-ceiling-holds), [architecture · Hooks](../../architecture/06-hooks.md)

← [The ownership hook](ownership.md) · [Reference](README.md) · [Calibrating the thresholds](thresholds.md) →
