# podman-desktop-kit — design specification

The design behind the plugin: what it is for, what each piece guarantees, and
why the guarantees are drawn where they are. It is a design document rather
than a manual — [`workflows/`](../workflows/README.md) is the manual — and it is written
for someone deciding whether to trust a step, extend it, or argue with it.

Two conventions matter for reading it:

- **Section numbers are stable.** Roughly eighty comments across `lib/` cite
  "section 7", "section 2.2", "invariant 1". They mean the sections below.
- **Claims are scoped deliberately.** Where a guarantee is narrower than it
  sounds, the narrowness is the design, and the text says so rather than
  rounding up. [Section 13](13-status.md) lists what has never been executed at all.

---

Each section is a file of its own and can be opened directly. A file carries its
section number in its name and its title, so "section 7" in a comment is
[`07-preflight.md`](07-preflight.md), and "section 2.2" is a heading inside
[`02-plugin-structure.md`](02-plugin-structure.md#22-state-outside-the-repository).
Section 4 is a directory with one file per command. Every file ends with links to
the previous and next section, and, where they exist, to the matching part of
[`architecture/`](../architecture/README.md) and of
[`workflows/`](../workflows/README.md).

## Contents

| § | Section | What it answers |
|---|---|---|
| 0 | [What is taken from the references, and what is rejected](00-references.md) | what came from spec-kit, ccpm, flow-next and wshobson/agents, what did not, and the one structural divergence: state outside the repository |
| 1 | [Domain model](01-domain-model.md) | what an issue is, the state machine and its edges (`answered`, `rework`, `re-cut`, none into `new`), how the next command is named, the hard rule behind the push gate |
| 2 | [Plugin structure](02-plugin-structure.md) | the plugin tree and what `lib/` holds; 2.1 what planning got wrong; 2.2 state under `$PDKIT_HOME` and the five invariants; 2.3 the journal |
| 3 | [Commands](03-commands.md) | every `/pd:*` command with its input, output, state, model and gate; the phrase-triggered skills |
| 4 | [Contracts of the key commands](04-contracts/README.md) | what each command does step by step, what the machine decides and what is left to the model — one file per command, [listed below](#section-4-contracts-of-the-key-commands) |
| 5 | [Agents and model routing](05-agents.md) | every agent with its model and tools, why `tools:` is the only lever, where models are set, token economics |
| 6 | [Hooks — where a prompt does not guarantee](06-hooks.md) | the hook table and every rule the handlers apply, command recognition, where the gate stands aside, the two kinds of token, one consent for two writes, receipts |
| 7 | [Preflight — the deterministic gates](07-preflight.md) | the twenty-three checks, pass / skip / warn / fail, and how the base, the ref and the script names are resolved |
| 8 | [MCP servers: what actually makes a difference](08-mcp-servers.md) | which servers to take and which not, why no `.mcp.json` ships; 8.1 e2e tests as an output; 8.2 how Playwright reaches the Electron application |
| 9 | [Configuration](09-configuration.md) | the three layers and how they merge, the YAML subset, what each key decides, the package map |
| 10 | [Scenario coverage](10-scenarios.md) | the route for each of the brief's scenarios, and scenarios 6–15 the brief did not name |
| 11 | [Known weaknesses of this design](11-known-weaknesses.md) | twelve places the design is known to be weak, stated rather than discovered later |
| 12 | [Delivery order](12-delivery-order.md) | stages 0–5, what each gives and its readiness signal; skills rather than commands |
| 13 | [Status: what has been verified, and what has not](13-status.md) | what has run against live upstream and its evidence, what has never been executed, and the lessons and measurements behind both |

### Section 4: contracts of the key commands

| Command | Contract |
|---|---|
| [`/pd:triage`](04-contracts/triage.md) | the entry point that cannot be skipped; the `redo` route; batch mode with no number |
| [`/pd:plan`](04-contracts/plan.md) | the plan as the only handoff artefact |
| [`/pd:plan-review`](04-contracts/plan-review.md) | reviewing the plan before any code |
| [`/pd:validate`](04-contracts/validate.md) | evidence instead of claims |
| [`/pd:audit`](04-contracts/audit.md) | the diff against the plan |
| [`/pd:slice`](04-contracts/slice.md) | the part no reference has |
| [`/pd:pr`](04-contracts/pr.md) | the only place that writes to GitHub |
| [`/pd:pr-status`](04-contracts/pr-status.md) | the dashboard, and how a red CI is measured here |
| [`/pd:pr-sync`](04-contracts/pr-sync.md) | feedback from review |
| [`/pd:resume`](04-contracts/resume.md) | coming back after a break |
| [`/pd:close`](04-contracts/close.md) | the end of the cycle |
| [`/pd:reset`](04-contracts/reset.md) | starting one issue over |
| [`/pd:review-pr`](04-contracts/review-pr.md) | reviewing somebody else's pull request |
| [`/pd:knowledge`](04-contracts/knowledge.md) | revising what everything else leans on |

## Reading order

The files follow the order of the original single document, and the links at the
foot of each one walk it front to back. For a first reading:
[section 0](00-references.md) for where the design comes from,
[section 1](01-domain-model.md) for the machine everything else moves along, and
[section 2](02-plugin-structure.md) for where things live and the invariants a
change must not break. After that, sections 3–9 can be read in any order, and the
contract of a command can be opened on its own. Sections 11 and 13 are best read
last: they say where the rest is weaker than it sounds.

## Where to look

| If you want to know… | Read |
|---|---|
| why state lives outside the repository | [0 · References](00-references.md), [2.2 · State](02-plugin-structure.md#22-state-outside-the-repository) |
| which states an issue moves through, and who may advance it | [1 · The state machine](01-domain-model.md#the-state-machine) |
| what `answered` is, and why it is not terminal | [1 · The `answered` branch](01-domain-model.md#the-answered-branch--an-issue-whose-deliverable-is-not-a-diff) |
| what happens when a reviewer rejects the approach | [1 · The `rework` edge](01-domain-model.md#the-rework-edge) |
| how an approved slice graph is cut again | [1 · The `re-cut` edge](01-domain-model.md#the-re-cut-edge), [`/pd:slice`](04-contracts/slice.md#pdslice-issue--the-part-no-reference-has) |
| what `preflight-green` is earned from | [1 · The hard rule](01-domain-model.md#the-hard-rule) |
| what each module in `lib/` is responsible for | [2 · What `lib/` holds](02-plugin-structure.md#what-lib-holds) |
| the five invariants a change must not break | [2.2 · State, outside the repository](02-plugin-structure.md#22-state-outside-the-repository) |
| what the journal records, and who writes it | [2.3 · The journal](02-plugin-structure.md#23-the-journal) |
| what a command takes, produces, and which model runs it | [3 · Commands](03-commands.md) |
| how a route is chosen, and when a quickfix escalates | [`/pd:triage`](04-contracts/triage.md) |
| what a plan must contain | [`/pd:plan`](04-contracts/plan.md) |
| what `pass`, `fail` and `unverified` mean for validation | [`/pd:validate`](04-contracts/validate.md) |
| what a green, red or inconclusive slice means | [`/pd:slice`](04-contracts/slice.md) |
| why publishing goes slice by slice, and why preflight runs twice | [`/pd:pr`](04-contracts/pr.md) |
| how a red CI is told apart: ours, inconclusive, flake | [`/pd:pr-status`](04-contracts/pr-status.md) |
| what `pdkit reset` keeps and what it removes | [`/pd:reset`](04-contracts/reset.md) |
| which model an agent runs on, and why there is no `routing:` block | [5 · Agents and model routing](05-agents.md) |
| why `git push` is denied, and what lets it through | [6 · Hooks](06-hooks.md), [6 · Two kinds of token](06-hooks.md#two-kinds-of-token) |
| why a task cannot be completed without a receipt | [6 · Receipts, and why the ceiling holds](06-hooks.md#receipts-and-why-the-ceiling-holds) |
| what each preflight check does, and whether it blocks | [7 · Preflight](07-preflight.md) |
| how Playwright attaches to the running application | [8.2 · How Playwright reaches an Electron application](08-mcp-servers.md#82-how-playwright-reaches-an-electron-application) |
| how the config layers merge | [9 · Configuration](09-configuration.md) |
| which route a scenario takes | [10 · Scenario coverage](10-scenarios.md) |
| where the design is known to be weak | [11 · Known weaknesses](11-known-weaknesses.md) |
| what has been proven against live upstream, and what has not | [13 · Status](13-status.md) |

## Other documents

| Document | What it answers |
|---|---|
| [`architecture/`](../architecture/README.md) | the same design in five minutes, one part per file |
| [`workflows/`](../workflows/README.md) | every use case, with the commands and the decision points |
| [`configuration/`](../configuration/README.md) | the three config layers and what every key decides |
