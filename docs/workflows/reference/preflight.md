# What preflight actually runs

[Workflows](../README.md) › [Reference](README.md)

`pdkit preflight <issue>` runs twenty-three checks, and on podman-desktop it takes
minutes, because it runs the repository's real scripts. Script names are resolved
from the repository's own `package.json` — there is no `pnpm lint` there, and
`pnpm test` drags in the e2e suite.

Four results, and the difference between them matters:

| | Meaning |
|---|---|
| **pass** | the check ran and was satisfied |
| **skip** | the check did not run, and the summary says why |
| **warn** | an advisory check found something; it does not block |
| **fail** | blocking, unless the check is advisory (`debug-leftovers`, `maintainer-rules`, `quickfix-size`, `pr-body-size`) |

A skip is never a pass. `steps-to-check` skipping because no PR body exists yet
means that check has not run at all.

**`working-tree` is first, and red there invalidates the rest.** The file checks
read the committed diff; the command checks run whatever is on disk. On a clean tree
those are one thing. On a dirty one the report mixes two, and it can go green on a
diff that will not be pushed.

## The two passes

Eight checks read the PR body, and the body depends on preflight — `Notes for
reviewers` is mandatory exactly when preflight flags something CI cannot judge, and
equally when validation could not demonstrate a step. One pass cannot close that
loop, so:

```
pdkit preflight 12345                                   # pass 1, no body
pdkit render prBody --issue 12345 --values v.json --strip-comments > body.md
pdkit preflight 12345 --body-only --body body.md        # pass 2
```

Green on pass 2 is what the gate is issued from. Pass 1 alone is not enough, and
`--body-only` without `--body` is refused rather than reported green.

---

**The design** — [7 · Preflight](../../specification/07-preflight.md), [architecture · The slicer](../../architecture/04-slicer.md)

← [16 · Starting one issue over](../16-starting-over.md) · [Reference](README.md) · [The push gate](push-gate.md) →
