# Measuring what a cycle costs

[Workflows](../README.md) › [Reference](README.md)

A token total for one issue says nothing on its own: an issue with fourteen tasks
is supposed to be dearer than a one-task fix. `pdkit cost` reads Claude Code's
transcripts and puts each issue's cost beside the size of the work:

```
pdkit cost                          # every issue in the journal, grouped by route
pdkit cost --issue 12345            # one cycle, split by phase
pdkit cost --since 2026-10-01       # only calls in a window
pdkit cost --snapshot               # also write $PDKIT_HOME/cost/<date>.json
pdkit cost --compare 2026-10-16     # that snapshot beside the issues journalled since
```

Run it from the podman-desktop clone, or pass `--repo`: the transcripts are found
under `~/.claude/projects/` by the repository's path (and under
`$CLAUDE_CONFIG_DIR/projects` when that is set), worktrees included.
`--transcripts <dir>` names the directory outright.

What it prints, per issue: API calls (parent session and subagents apart), the
four token counters, cost units, average and peak context, sessions,
compactions, the Opus share, agent runs, a split by phase at the state
transitions, and the cost per task, slice, requirement, changed line, merged
pull request and agent run. A denominator that is not known says so and why.

The scale is **cost units**: `input + 0.1·cache-read + 1.25·cache-write +
5·output`, times five on Opus. They are list-price ratios, so a "before" and an
"after" months apart are on the same scale. Dollars are printed beside them for
orientation; compare in units, or a price change will read as an improvement.

Read the caveats it prints:

- **Attribution is approximate.** A call belongs to the issue of the nearest
  earlier journal entry within six hours, and the share of calls that matched
  nothing is always printed. Work before an issue's first journal entry is not
  counted as its triage.
- **Changed lines include lockfiles and generated output**, as in `pdkit stats`.
- **Routes are not compared.** A quickfix and a multi-slice cycle differ in kind,
  so each route is a separate group.
- `--compare` counts as "after" only the issues the snapshot did not contain.

It recommends nothing and exits 0: what the numbers mean for how to work is your
call.

---

**The design** — [13 · Status](../../specification/13-status.md)

← [One session per phase](sessions.md) · [Reference](README.md) · [Decision points that stay yours](decision-points.md) →
