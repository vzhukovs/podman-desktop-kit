# `/pd:pr` — the only place that writes to GitHub

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:pr`

```
1. pdkit slice verify --all              # red means stop
2. for each slice, in topological order:
   a. pdkit slice materialize --slice <i>
   b. pdkit preflight <n> --slice <i>    # pass 1: everything that does not read the body
   c. render the PR body, taking (b) into account
   d. pdkit preflight <n> --slice <i> --body-only --body <f>   # pass 2
   e. SHOW the human: branch, the exact push command, the whole body
   f. wait for explicit confirmation IN THE SAME TURN
   g. pdkit gate open --branch <b> --kind push --ttl 10m
   h. git push origin <b> && gh pr create --base <base> --head <b> …
   i. pdkit gate close; pdkit pr register --issue <n> --pr <k> --slice <i>
```

Step i is not bookkeeping. Without the record in `prs.json` the number of an
opened pull request exists only in human text, and then no stage-4 question has
an answer. So `pdkit pr create` performs the registration itself: a step that can
be forgotten is equivalent to an absent one.

**The loop goes slice by slice rather than collecting every branch and asking
once.** A token is issued per branch, and confirmation for slice #1 is not
confirmation for #2. Showing three PR bodies in a row and asking once turns the
gate into exactly the reflex it exists to prevent. The PR base comes from the
graph: `main` for an independent slice, the predecessor's branch for a stacked
one. `pdkit pr create` reads it there and passes it, and it records the base the
write came back with rather than the one it was given — for the same reason
receipts are captures.

**A stack cannot be published from a fork, and that is a property of GitHub
rather than of the graph.** The base of a pull request is a branch of the
repository it opens against; a slice branch is in the fork. So `pr create`
checks upstream for a non-default base and refuses before the token is spent
when it is not there, naming the two ways past: merge the slice below first, or
open against `main` with `--base main` and state in the body that the diff
carries the other slice until it lands. `slice set` warns at the cut, which is
where independence is still cheap.

The first multi-slice live run found this the expensive way. Slice #2 was
verified, preflighted and shown to the user against slice #1's branch — two
files, +130/−2 — and opened against `main` at four files, +435/−10, with a body
that said it changed no product code. Every check had judged a different diff
from the one the reviewer got.

**Why two passes.** Eight checks read the PR body, and the body depends on
preflight — `Notes for reviewers` is mandatory exactly when preflight flagged
something CI cannot judge. One pass cannot close that loop. The break is in the
ordering: pass 1 does not see the body and honestly returns `skip` with a reason
for those checks (not `pass` — a check reporting success where it checked nothing
devalues the entire gate). Its findings go into the body. Pass 2 sees the body,
and all six become real. **`preflight-green` is set only by pass 2**, and that is
the state `gate open` issues from.

The body is built as a tool for the reviewer, but **inside upstream's frame
rather than instead of it**. podman-desktop has a `PULL_REQUEST_TEMPLATE.md` with
four sections, and a reviewer scans by those headings; a body built on ours makes
them hunt.

| Upstream section | What goes inside |
|---|---|
| `What does this PR do?` | what changed and why + `Where to look` + `Not in this PR` |
| `Screenshot / video of UI` | `/pd:validate` artefacts. No UI change means an explicit `n/a` with a reason, not an empty section |
| `What issues does this PR fix or reference?` | `Closes #N` (last slice of a stack) or `Part of #N` + the R-ID coverage table |
| `How to test this PR?` | `Steps to check` + `Notes for reviewers` + upstream's test-coverage checkbox |

The body closes with an attribution line naming the plugin and the person who
reviewed it before it was opened. The login is resolved from the fork slug the
clone already knows; when none can be established the clause naming a person is
left out rather than rendered empty.

---

**In practice** — [`workflows/`](../../workflows/README.md):

- [§3 — A feature, cut into several pull requests](../../workflows/03-feature-in-several-prs.md)
- [The push gate](../../workflows/reference/push-gate.md)

← [`/pd:slice`](slice.md) · [Contents](../README.md) · [`/pd:pr-status`](pr-status.md) →
