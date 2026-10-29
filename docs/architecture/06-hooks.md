# Why hooks rather than instructions

[Architecture](README.md) › 6 of 7

Three things are enforced rather than requested, and each closes a failure that
was actually observed:

- **The push gate.** `git push` and `gh pr create` are denied without a
  short-lived token for that exact branch. A token knows what it is consent for: a
  `push` token is keyed by branch and issued only from `preflight-green`; a
  `reply` token is keyed by pull request, for writes that belong to no branch.
  Keys of different kinds cannot be found for one another, so consent to publish
  code is not consent to speak in a review — which it silently was before the
  kinds existed. Writes to the issue tracker are denied outright, from every
  state: no gate can be opened for them, because the routes that produce issue
  text all say a human posts it.
- **File ownership.** A worker writing outside its task's `Owns` set fails. This
  turns the ownership map from a request into an invariant and removes a class of
  merge conflicts rather than resolving them.
- **Receipts.** A task cannot be marked complete without captured command output,
  and after three failed captures it is blocked until somebody says in writing
  what changed.

One hook enforces nothing and is still not a convenience. **SessionStart** opens
a session with a dozen lines: the issue, its state and route, the task running
and the files it owns, failed captures, the one command to run next, the phase's
turn budget, and recent journal entries. In a tree with no task running it reads
the issue off the `DESKTOP-<n>/…` branch, which is where every phase but exec
starts. That summary is what makes a session per phase cheap. Context is re-read
whole on every call, so a session costs roughly the square of its length — the
dearest one measured ran 676 calls to 878 k tokens of context, and linear growth
alone accounts for 90 % of its input. Splitting such a session into k sessions
divides its cost by about k, for the same work and the same prompts. A
restart is affordable only if it costs a summary rather than a re-explanation.
That is the same reason [the state lives on disk](01-constraint.md) in the first
place, and why `pdkit next <n>` exists for a session that opens anywhere else.

The gate reads the command rather than matching a substring on it. A hook's
`matcher` can only see the tool name, so the parsing happens in code: leading
assignments, `&&`, `||`, `;`, substitutions, subshells, a program named by path, a
quoted `argv[0]`, and wrapper programs. That last one is not about any particular
tool — hooks on the Bash tool are global, so a wrapper can appear in this project
without this project being told.

---

**In depth** — [`specification.md`](../specification.md):

- [§6 — Hooks](../specification.md#6-hooks--where-a-prompt-does-not-guarantee)
- [§6 — Two kinds of token](../specification.md#two-kinds-of-token)
- [§6 — Receipts, and why the ceiling holds](../specification.md#receipts-and-why-the-ceiling-holds)

**In practice** — [`workflows.md`](../workflows.md):

- [The push gate](../workflows.md#the-push-gate)
- [The ownership hook](../workflows.md#the-ownership-hook)
- [Receipts](../workflows.md#receipts)
- [One session per phase](../workflows.md#one-session-per-phase)

← [Validation](05-validation.md) · [Contents](README.md) · [Known weaknesses](07-known-weaknesses.md) →
