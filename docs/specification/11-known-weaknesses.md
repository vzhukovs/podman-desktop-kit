# 11. Known weaknesses of this design

[Specification](README.md) › Section 11

Stated here rather than discovered later.

1. **A fresh-context auditor of the same model is not a different model.**
   Different models fail differently, and the divergence is the signal. Fresh
   context catches drift from the plan; it does not catch blind spots the model
   shares with itself. Mitigation: the auditor sees only the diff and the plan,
   never the implementer's reasoning. If a genuine second opinion is ever wanted,
   there is exactly one extension point: `pd-auditor`, through an external CLI.

2. **Slicing after the fact costs more than it looks.** Cutting an interleaved
   diff into atomic pull requests is comparable work to implementing it again.
   Hence `Slice hypothesis` in the plan and the task ordering that follows from
   it. If the hypothesis was never stated, `/pd:slice` will honestly return
   "slicing requires rewriting the history of tasks T2–T4" — and that is the
   right answer, not a failure.

3. **A stack of pull requests is fragile.** After slice #1 merges, #2 needs its
   base switched and rebased, and its review threads start pointing at moved
   lines. Hence `prefer-independent` as the default; a stack is the exception and
   every stacked slice must carry a justification.

4. **`validate` without Playwright is a checklist, not a check.** The plugin must
   not pretend it validated. The rule is explicit in the skill: PASS may never be
   set from reading source.

5. **Overhead on small things is the main risk of the whole idea.** The
   `quickfix` threshold is a defence against ceremony, not an optimisation: if
   the diff fits in one sentence, planning is not needed at all.

6. **The consent gate degrades into a reflex.** In a month you will be pressing
   yes without reading. Mitigation: the gate prints the exact PR body and branch
   list rather than a yes/no prompt — the thing worth reading — and the ten-minute
   TTL means consent cannot be accumulated.

7. **State outside the repository can be lost.** `$PDKIT_HOME` should be its own
   git repository; `pdkit` commits after each transition.

8. **`Patch comes off` is a textual check, and is named for what it measures.**
   Whether the build survives a revert costs +100% per slice (+26% narrowed to
   typecheck) and is deliberately not bought: a revert lands weeks later against
   a tree that has moved, so a build proved green on the day of slicing answers
   about a tree that will not exist. What does not decay is whether the diff is
   self-contained enough to come off.

9. **Lists in the config replace rather than merge**, so a list copied by `init`
   and never edited stops tracking the shipped default. `doctor` reports it;
   nothing prevents it, because silently re-extending a list somebody edited
   would be worse.

10. **In a type-change refactor the flip cannot be cut, but the groundwork can —
    and only if the cut owns everything that breaks because of it.** Changing the
    type a store holds happens on one line and every consumer stops typechecking
    at that instant, so no subset of the flip is independently green. What *is*
    separable is the additive half: new fields on the UI type, the converter that
    populates them, **and every existing file that stops compiling when a required
    field appears**. That last clause is the whole of it, and it is measurable
    rather than arguable — adding the field and running the repository's own
    typecheck names the files exactly.

    This item was first written as "the answer is always one slice", and that was
    wrong. It generalised from a plan that claimed a purely additive first slice
    while owning none of the six fixture files the new fields broke; review
    rejected that plan, the next one withdrew to a single slice, and the
    withdrawal was read as a property of the class. A later plan on the same issue
    proposed two slices again with the fixture files inside the first, and the
    measurement backs it: nine typecheck errors, seven files, all of them in that
    slice.

    So the honest rule is narrower and more useful than the one it replaces: an
    additive slice is independent exactly when the set of files it owns is closed
    under "what fails to compile without this change". `/pd:slice` verifies that
    by running the build; the plan is where it has to be got right, because a
    slice hypothesis that claims additivity without the closure is the specific
    error that has now been made once and caught once.

---

**In brief** — [`architecture/`](../architecture/README.md): [7 · Known weaknesses](../architecture/07-known-weaknesses.md)

← [10 · Scenario coverage](10-scenarios.md) · [Contents](README.md) · [12 · Delivery order](12-delivery-order.md) →
