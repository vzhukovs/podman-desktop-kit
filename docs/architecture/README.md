# Architecture

The short version. The full design — the reasoning, the measurements and the
rejected alternatives — is in [`specification/`](../specification/README.md).

Each part below stands on its own and can be opened directly. Every part ends
with links into the specification for the full reasoning and, where one
exists, into the manual for the commands.

## Contents

| # | Part | What it answers |
|---|---|---|
| 1 | [The constraint everything follows from](01-constraint.md) | why state lives outside the tree, why there are no scratch issues, why there is a gate |
| 2 | [The pieces](02-pieces.md) | what each directory of the plugin is for, and why what must be true is kept apart from what requires judgment |
| 3 | [The lifecycle, and its two ways out](03-lifecycle.md) | the state machine an issue moves through: the usual path, `rework`, `answered`, and why `pdkit reset` is not a transition |
| 4 | [What the slicer is, in one paragraph](04-slicer.md) | how a slice is verified before any branch exists, and how preflight knows the verdict is still about this diff |
| 5 | [What validation promises, and what it does not](05-validation.md) | what PASS means, and why `unverified` does not block the transition |
| 6 | [Why hooks rather than instructions](06-hooks.md) | the push gate and its tokens, file ownership, receipts, the SessionStart summary, how the gate reads a command |
| 7 | [Known weaknesses](07-known-weaknesses.md) | where the design is known to be weak, stated rather than discovered later |

## Reading order

Start with [part 1](01-constraint.md): the rest follows from it.
[Part 2](02-pieces.md) names the pieces the other parts refer to. Parts 3–6
can then be read in any order, and [part 7](07-known-weaknesses.md) is best
read last.

## Where to look

| If you want to know… | Read |
|---|---|
| why no state is kept in the working tree | [1 · The constraint](01-constraint.md) |
| where a rule belongs, and where judgment does | [2 · The pieces](02-pieces.md) |
| which states an issue moves through, and who may advance it | [3 · The lifecycle](03-lifecycle.md) |
| what happens when a reviewer rejects the approach rather than the diff | [3 · The lifecycle](03-lifecycle.md) |
| what `answered` is, and why it is not terminal | [3 · The lifecycle](03-lifecycle.md) |
| what `pdkit reset` removes, and what it leaves alone | [3 · The lifecycle](03-lifecycle.md) |
| what a green or a red slice means | [4 · The slicer](04-slicer.md) |
| what PASS proves, and what `unverified` is | [5 · Validation](05-validation.md) |
| why `git push` and `gh pr create` are denied, and what a `push` and a `reply` token are | [6 · Hooks](06-hooks.md) |
| why a worker cannot write outside its task's `Owns` set | [6 · Hooks](06-hooks.md) |
| why a task cannot be completed without a receipt | [6 · Hooks](06-hooks.md) |
| why a session per phase is cheap | [6 · Hooks](06-hooks.md) |
| where the design is known to be weak | [7 · Known weaknesses](07-known-weaknesses.md) |

## Other documents

| Document | What it answers |
|---|---|
| [`specification/`](../specification/README.md) | the design: what each piece guarantees, and why the guarantees stop where they do |
| [`workflows/`](../workflows/README.md) | every use case, with the commands and the decision points |
| [`configuration/`](../configuration/README.md) | the three config layers and what every key decides |
