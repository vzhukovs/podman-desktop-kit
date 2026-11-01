# The lifecycle, and its two ways out

[Architecture](README.md) › 3 of 7

An issue moves through a state machine that only `pdkit` may advance. The usual
path runs triage → plan → exec → validate → audit → slice → preflight → pull
request, and ends at `merged` once every pull request has landed.

Two branches off it are worth knowing about, because both are ordinary outcomes
that the first version of the machine could not express.

**A reviewer can reject the approach rather than the diff.** `pr-open` and
`review-in-progress` lead back to `triaged` through `pdkit issue rework`. The pull
request stays open and the branch stays put; the route is chosen again and
planning starts from the issue rather than from the diff that was refused. Without
that edge the only moves were to push again — which assumes the design survived —
and to abandon an issue still worth doing.

**An issue can end in an answer rather than a diff.** When the bug is real and the
cause lives outside the repository, the deliverable is a reproduction, a detector
command and a workaround. `answered` is that state, and it is deliberately **not**
terminal: at the moment the findings are posted you are waiting on the reporter.
Three exits — `resolved` when somebody confirms, back to `planned` when the answer
implies product work, `abandoned` when it goes quiet. Entry is guarded by a
capture, for the same reason [PASS](05-validation.md) is: a workaround nobody
ran is a suggestion, and a suggestion posted in the voice of a finding costs the
reporter their evening.

**There is no way back to the start, and `pdkit reset` is not one.** A cycle that
went wrong early cannot be re-entered by a transition: `new` has no predecessor,
and giving it one would write a trip into the history that the work never took —
destroying the distinction between artefacts that were never produced and
artefacts that were lost. So the reset *removes the record* instead. With no
`state.json` the machine reads its own blank, whose only exit is `triaged`, and
the next cycle is forced to start where a cycle starts. It clears one issue's
artefacts, consent tokens and active pointers, leaves every neighbor alone, and
leaves the journal alone too — an issue back at `new` with no history would be
indistinguishable from one nobody ever worked on.

---

**In depth** — [`specification/`](../specification/README.md):

- [§1 — The state machine](../specification/01-domain-model.md#the-state-machine)
- [§1 — The `answered` branch](../specification/01-domain-model.md#the-answered-branch--an-issue-whose-deliverable-is-not-a-diff)
- [§1 — The `rework` edge](../specification/01-domain-model.md#the-rework-edge)
- [§1 — There is no edge into `new`](../specification/01-domain-model.md#there-is-no-edge-into-new-and-starting-over-does-not-add-one)

**In practice** — [`workflows/`](../workflows/README.md):

- [§6 — An issue that ends in an answer](../workflows/06-ends-in-an-answer.md)
- [§9 — The reviewer rejected the approach, not the diff](../workflows/09-approach-rejected.md)
- [§16 — Starting one issue over](../workflows/16-starting-over.md)

← [The pieces](02-pieces.md) · [Contents](README.md) · [The slicer](04-slicer.md) →
