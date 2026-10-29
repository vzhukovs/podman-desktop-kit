# Calibrating the thresholds

[Workflows](../README.md) › [Reference](README.md)

Four numbers in `config.yaml` were common sense: two quickfix bounds, the stale
window, and the attempt ceiling. `pdkit stats` measures the population they are
about — what upstream actually merges:

```
pdkit stats --limit 100
pdkit stats --limit 100 --author <you>    # once you have merged pull requests
```

It prints distributions of files changed, lines changed, time to merge and how long
open pull requests stay quiet, then puts each configured value beside what the
population did. It recommends nothing and writes nothing.

Read the sampling window it prints. `gh pr list` orders by creation date, so a
hundred merged pull requests are the last few weeks of work rather than a hundred
merges — which under-represents slow ones precisely because they are slow, and that
is the tail the stale threshold is about.

---

**The design** — [13 · Status](../../specification/13-status.md)

← [Receipts](receipts.md) · [Reference](README.md) · [One session per phase](sessions.md) →
