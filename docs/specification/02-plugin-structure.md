# 2. Plugin structure

[Specification](README.md) › Section 2

```
podman-desktop-kit/                  # repository root = plugin root
├── .claude-plugin/
│   ├── plugin.json                  # name: "pd", displayName: "Podman Desktop Kit"
│   └── marketplace.json             # one entry, source: "./"
├── bin/pdkit                        # the only file in bin/; +x, #!/usr/bin/env node
├── lib/                             # ESM, zero-dependency, stdlib only
├── skills/                          # 18 orchestrating + 3 phrase-triggered
├── agents/                          # 14, prefixed pd- (agent names are not namespaced)
├── hooks/hooks.json                 # thin: 6 entries on bin/pdkit, logic in lib/hooks/
├── templates/                       # the shape of every artefact
├── knowledge/                       # the constitution, shipped with the plugin
├── defaults/config.yaml             # section 9 defaults
├── test/                            # node --test, zero-dependency
└── docs/
```

## What `lib/` holds

| Module | Responsibility |
|---|---|
| `cli.js` | argv parsing, exit codes, `--json` |
| `commands/` | `support.js`: what more than one command handler needs — exit codes, `--json` output, the repository a command works on, the refusal that holds a command to its issue's tree |
| `doctor.js` | environment checks; separate from `cli.js` so two hundred lines of probes do not live in a command dispatcher |
| `config.js` | three layers: `defaults/config.yaml` ← `$PDKIT_HOME/config.yaml` ← `<repo>/.pdkit.yaml` |
| `yaml.js` | a reader for a deliberate subset of YAML (see [section 9](09-configuration.md#the-yaml-subset)) |
| `state.js` | the [section 1](01-domain-model.md#the-state-machine) machine on disk; validates transitions |
| `active.js` | which task is running **in which working tree**; one file per tree |
| `ids.js` | R-IDs, task IDs, slice IDs; allocation and freeze |
| `globs.js` | path matching for `Owns` (`**`, `*`, `?`), pure strings, no disk access |
| `artefacts.js` | reads `plan.md` and `tasks/T*.md` back, plus the mechanical plan checks |
| `archaeology.js` | facts about a previous attempt; owns `archaeology.json`; reaches no verdict |
| `attempts.js` | how many times a task has been tried; **derived** from the journal, never stored |
| `audit.js` | facts for `pd-auditor`, including every file changed outside every `Owns`; no verdict |
| `backlog.js` | facts about a set of candidate issues; produces an order, not a choice |
| `repo.js` | package map from `pnpm-workspace.yaml`, git primitives |
| `stats.js` | measures the population the thresholds are about; recommends nothing |
| `slice.js` | the slice graph, topological sort, standalone verification, materialisation, cascade, joining; owns `slices.json` |
| `contracts.js` | which IPC channels a file's changed lines belong to; facts for `slice set`, no verdict |
| `worktree.js` | creates, lists, removes trees and prepares the verification tree |
| `pr.js` | pull requests as entities; CI verdicts; the merge rollup; owns `prs.json` |
| `threads.js` | facts about review threads: bot or human, thread → file → slice → task → R-ID; no verdict |
| `validation.js` | validation steps and their evidence, launching the app under CDP, the e2e run series; owns `validation.json` |
| `review.js` | facts about somebody else's pull request; no verdict |
| `knowledge.js` | revision of `knowledge/`: dead links, drift from the package map, entry shape |
| `drift.js` | composition: a slice's branch point, upstream commits after it, overlap with lines the plan cites |
| `gh.js` | `gh` wrappers (REST + GraphQL), read-only by default |
| `gate.js` | issues, verifies and revokes consent tokens; TTL; token kind |
| `journal.js` | append-only, sliced by month |
| `render.js` | `templates/*.md` → text |
| `upstream.js` | shared primitives for upstream rules: SPDX, conventional commits, `Signed-off-by`. Used by **both** hooks and preflight so a rule lives in one place |
| `evidence.js` | raw capture of command output for receipts |
| `hooks/` | `events.js` (event → handler table), `rules.js` (deny rules as data), `dispatch.js`, `command-parse.js`, `owns.js`, `post-write.js`, `session-start.js`, `task-completed.js` |
| `preflight/` | `index.js` runner plus one file per check under `checks/` |

## What is deliberately absent from the tree

- **`.mcp.json`** — a plugin's MCP servers load with the plugin as a whole, and
  [section 8](08-mcp-servers.md) requires Playwright and context7 to be optional. Configuration is
  documented instead, and `/pd:doctor` checks it.
- **`commands/`** — the skills-versus-commands fork was settled in favour of
  `skills/`. Two sources of truth for one behaviour is not a trade.
- **`scripts/`** — every hook goes through the single `bin/pdkit` binary.

## 2.1 What planning got wrong, and how

The tree above is the result of checking the original design against Claude
Code's actual documentation, and then against the code as it was built. The
corrections are worth keeping because the same shape recurs.

Nine mismatches came out of the documentation check. The load-bearing ones:

| Was | Became | Why |
|---|---|---|
| `name: "podman-desktop-kit"`, directories `skills/pd-triage/` | `name: "pd"`, `displayName`, directories `skills/triage/` | Plugin skills are invoked as `/<plugin>:<skill>`. The original pair produces `/podman-desktop-kit:pd-triage`, not `/pd:triage` |
| Hook matchers of the form `Bash(git push*)` | One `matcher: "Bash"` → `bin/pdkit hook pre-bash`, parsing in `lib/hooks/` | The `matcher` field is compared **only against the tool name**, never against the command string. This also closes wrapper bypasses more reliably than a substring list ever could |
| `lib/*.js` as ESM with no manifest | A root `package.json` with `"type": "module"` | Node reads an extensionless `bin/pdkit` as CommonJS, and `import` fails |
| MCP servers understood as a property of an agent | Servers are session-level; scope comes from `tools:` in agent frontmatter | Plugin agents support neither `mcpServers` nor `hooks` nor `permissionMode` in frontmatter |
| Model set both by frontmatter and by a `routing:` config block | Frontmatter only | A skill's own model is switchable only in frontmatter, so a config key would control the subagents and not the skill — a lever that half works |

**Then a pattern appeared, once per stage, always in a new place: an entity had
no owner.**

- Stage 2 found there was no notion of an **active task**. `state.json` knew that
  `T1` owns three files; nothing could tell that `T1` is what is running *here*.
  Three of the four stage-2 items depended on that one missing pointer.
  `lib/active.js` introduced it, `lib/globs.js` the path matching that `lib/`
  did not have at all.
- Stage 3: `worktrees.*` had been in the config since stage 0, "five worktrees
  see one state" had been an argument since [section 0](00-references.md), and nothing could create
  a tree. `lib/repo.js` was the wrong home — it answers questions *about* the
  tree it was called in, and its consumers are hooks, which must not depend on
  the config being right. Creating trees depends on the config entirely.
- Stage 4: a slice could become a branch and `/pd:pr` could open one pull
  request per slice, and the **number of the opened pull request went nowhere**
  except human text in a transition reason. So no stage-4 question had an
  answer: which PR belongs to which slice, which slice a thread is about, what
  to re-check after a review fix. `lib/pr.js` introduced the record.
- Stage 5: `validation.md` had been in the state tree since the first version
  and nothing answered "was this validated, and by what evidence". The symptom
  was visible in the machine: `validated` was the one state an issue could enter
  only by hand, because nothing could produce the transition.
- Stage 6 ([scenario 6](10-scenarios.md#scenarios-the-brief-did-not-name)) found the cycle had no **entrance**. Every stage began at
  `/pd:triage <issue>` — with a number somebody had already chosen.

Two modules broke the pattern by *not* needing an owner. `lib/attempts.js`
derives the attempt count from the journal rather than storing it: storing would
mean either a second writer for `state.json` (a direct breach of [invariant 1](#22-state-outside-the-repository)) or
a new state file for one integer, and the journal is append-only by construction
and already records what happened. `lib/stats.js` measures rather than owns.

## 2.2 State, outside the repository

```
$PDKIT_HOME/                     # default: ~/.pdkit/podman-desktop
├── config.yaml
├── package-map.json             # generated by pdkit init from pnpm-workspace.yaml
├── gates/                       # ephemeral consent tokens, TTL
├── active/                      # what is running in which working tree; one file
│                                #   per tree, named by a hash of its path
├── issues/12345/
│   ├── state.json               # the machine, timestamps, who approved what
│   ├── preflight.json           # every run, both passes; what `preflight-green` is earned from
│   ├── issue.md                 # issue snapshot + prior context + verdict + R-set
│   ├── archaeology.json / .md   # facts about a previous attempt, and their reading
│   ├── research.md              # the scouts' compressed map, file:line only
│   ├── plan.md                  # the plan; R-IDs are frozen here
│   ├── plan-review.md
│   ├── tasks/T1.md …
│   ├── receipts/T1.md …         # real command output
│   ├── validation.json / .md    # steps, evidence, e2e run series; .md is rendered
│   ├── validation/V1.md …       # raw run output, receipt format
│   ├── audit.md
│   ├── findings.md              # for an issue whose deliverable is an answer
│   ├── slices.json / .md        # the PR graph; .md is rendered from .json
│   ├── verify/S1.md …           # raw slice-verification output, receipt format
│   ├── prs.json, prs/2871.md    # open pull requests; .md is rendered
│   └── amendments/A1.md         # plan amendments arising from review
├── archive/12345/2026-08-20-1114/   # what `pdkit reset` moved out of the way
├── journal/YYYY-MM.md           # global, append-only, sliced by month
├── cost/YYYY-MM-DD.json         # `pdkit cost --snapshot`: the baseline a later run compares to
└── reviews/2903.md              # reviews of other people's PRs, tied to no issue
```

`archive/` sits beside `issues/` rather than inside it, and the reason is
mechanical rather than tidiness: two commands find an issue by reading the names
in `issues/` and calling `Number.parseInt` on them, which answers `12345` for
`12345.reset-2026-08-20`. An archive kept next to its original would be read back
as the issue it is a copy of.

`$PDKIT_HOME` is created at runtime by `pdkit init` and is **not part of the
plugin tree**: the plugin's path changes on every update, so state cannot be
written there. Keeping it in its own private git repository is worthwhile —
`pdkit` commits after each transition — but it must be a **separate** repository,
never the fork.

**Five invariants, each covered by tests.**

1. **Only `lib/state.js` writes `state.json`.** [Section 1](01-domain-model.md#the-state-machine) transitions are
   permitted by it, not by an agent and not by a skill.
2. **The journal is append-only.** `lib/journal.js` can neither overwrite nor
   delete.
3. **A run's verdict is produced by `pdkit`, never supplied by an agent.** There
   is no input through which "standalone: ✅" or "CI is green" could be handed
   in: the `Standalone` and `Patch comes off` columns in `slices.md` and the CI
   status in `prs/<k>.md` are rendered from `slices.json` and `prs.json`, which
   only `lib/slice.js` and `lib/pr.js` write, and only from a run.
4. **Merge is a property of a pull request, not of an issue.** `prs.json` knows
   which PR merged; `state.json` does not. An issue may enter `merged` only on
   the rollup "every PR closed by merge", and `/pd:close` performs it.
5. **PASS requires an attached artefact.** A validation step's outcome is
   **derived** from what is attached rather than declared: a capture exiting zero
   is `pass`, non-zero is `fail`, an artefact with an observation and no run is
   `observed`, nothing is `unverified`. `pdkit validate attach` has no
   `--status` — and until the flag table below, "has no" meant only that nothing
   read one. The CLI took it and ignored it, so the invariant was enforced by
   this paragraph and by nothing else.

**Every command declares the flags it reads, and the dispatcher refuses the
rest.** `parseArgs` accepts any `--word`; before the table, whether anything read
it was nobody's question. `pdkit issue fetch <n> --body` exited zero and printed
a summary with no body, twice under two spellings, on the first live run. The
worse case is a command that writes: `--force` and `--confirm` are one letter
from flags that exist on a neighbouring command, and a misspelling reads as the
safe thing having been asked for.

The table is per command rather than per subcommand, so `pdkit gate close --ttl`
is accepted and ignored — a narrower error for a much larger table, and the
wrong trade. `hook` is exempt: it is invoked by the host, and refusing an
argument a future host adds would take the gate down to report a typo nobody
made. Two structural tests keep the table honest, and the second is the load-
bearing one: a flag a handler reads but does not declare is a working feature the
dispatcher now refuses before the handler sees it.

`active/` is separate from `state.json` deliberately, and does not breach
invariant 1. `state.json` describes an **issue**. "What is running right now" is
a question about a **working tree**: five worktrees share one state, and two of
them can drive the same issue on different slices. One field on the issue record
cannot express that, and two writers of `state.json` would breach invariant 1
directly. The shape is the same as `gates/`: a file per unit, one owner, no index
that can fall out of sync.

Invariant 4 is not symmetry. `merged` is terminal, and upstream merges slices one
at a time: the first merged slice of three would lock the issue, and slice #2
would never reach `preflight-green`.

Invariant 5 comes with a statement of its own boundary, and the boundary matters
more than the invariant. A slice's verdict is machine-readable all the way down —
it is an exit code. A validation outcome is not: "the contrast is now 4.6:1" is
an **observation**, and no code can confirm it was read correctly. Stretching the
invariant over what it does not hold would be worse than not having it, because a
check reporting on work it did not do devalues the whole gate.

All of this is the device that closed receipts at stage 2: **the discipline rests
on the absence of a parameter, not on the strictness of a check.** The agent
participates where it belongs — which files form which slice and why, what a
reviewer meant, what appeared on screen — and does not participate where a run or
an API produces the answer.

## 2.3 The journal

One journal for everything, sliced by month. One line per entry, machine-readable
prefix:

```
2026-07-30T14:02:11Z  issue:12345  slice:2  event:plan-approved   R1,R2,R3 frozen
2026-07-30T15:41:03Z  issue:12345  slice:2  event:conflict-semantic  upstream a3f21e touched exec.ts; plan amended A1
2026-07-31T09:12:44Z  issue:12908  —        event:triaged  one-line conversion, cause and fix named by the reporter
```

The per-issue view is generated, not stored: `pdkit journal --issue 12345`.
Re-anchoring on `SessionStart` injects the filtered view rather than the file —
otherwise the journal starts eating context within a month. The monthly slicing
exists so `--since` never reads a gigabyte.

Things that happened elsewhere land here too: a merge a reviewer performed in the
browser reaches the plugin by exactly one route, `pdkit pr refresh`. An entry is
written once, on a state change; a second refresh of the same state writes
nothing.

**`agent-done` counts the machinery.** The `SubagentStop` hook is the only place
that sees every subagent finish — the scouts of `/pd:plan`, the plan critic, the
auditor, the slicer, the reviewers — and it writes one entry per completion,
before it decides anything about the claim being made. Counting only the accepted
completions would make the record cheapest exactly where the work went worst.

It answers "how much machinery did this issue take", which is the question that
survives comparison between issues when a bare cost does not: an issue with seven
tasks and two slices is supposed to be dearer than a one-task fix, and the two
are told apart by `pdkit journal --issue <n> --event agent-done`. `pdkit cost`
uses it as a denominator, but counts agent runs from the subagent transcripts
rather than from this entry, and prints the journal's count beside it: a count
that depends on a hook firing reads as zero for every issue before the hook did.

Which agent ran is recorded when the host says so: `SubagentStop` carries
`agent_id` and `agent_type` (`pd:pd-scout`, `general-purpose`), and the entry
reads `agent task <agent_id>; <agent_type>`. When a field is absent the entry
leaves it out rather than inventing it. Until 0.4.0 the hook was registered on
`TaskCompleted`, which Claude Code raises for task-list items and agent-team
teammates and never for a subagent returning, so neither this count nor the
receipt gate [below](06-hooks.md#receipts-and-why-the-ceiling-holds) ever ran; `pdkit doctor` now warns when `agent-done` has been
silent for 30 days. The issue comes from the active task pointer when there is one
and from the branch name when there is not — `DESKTOP-<issue>/<slug>` is a name
this plugin wrote — and from nothing else: an entry with no issue is honest,
while one attributed by guess is not. The branch is held to the same test as the
SessionStart summary: when another issue in progress was moved after the
branch's issue (its state.json `updatedAt`), the branch is only where the last
piece of work left the checkout, and the entry is written with no issue and
`not filed under <n>: the tree is on <branch>, and <m> moved since`. On
DESKTOP-18915 every subagent of an afternoon spent in a main checkout left on
18967's branch was filed under 18967, and `pdkit cost`, which attributes calls
by the nearest entry, followed them.

**Almost every entry is written by whatever produced the fact. There is one
exception, and it exists because a conflict cannot be observed.** A receipt is a
capture, a slice verdict is a run, a merge is an API answer — each closed to
agents precisely because a machine produces it. What upstream rewrote underneath
a plan was seen only by whoever resolved it, and an unrecorded resolution
disappears: six months later the diff shows what was chosen and nothing shows why.

Hence `pdkit journal conflict --issue <n> --kind mechanical|semantic --file <p>
--resolution <why>`. **The vocabulary is closed**: two event names and no third.
A command that could write an arbitrary event would let `preflight-green` be
typed beside the one preflight measured, and a reader cannot tell a typed event
from a produced one. `--resolution` is required for the same reason `--reason` is
required on `task unblock` and `issue adopt`, and an unknown issue number is
refused: the journal is append-only, and nothing takes a mistaken entry back.

**A deferral is written the same way, and for a second reason on top of the
first.** `pdkit defer` records what a review thread set aside — what it was, who
raised it, on which pull request — and `pdkit defer resolve|drop` records what
settled it. Nothing can observe a decision to defer, so it needs a person to
write it; that is the argument a conflict already makes. What is particular here
is *where* it has to survive. An issue that merges reaches a terminal state, and
a promise made to a reviewer does not end when the work does. Storing it on the
issue would put it in a record whose whole purpose is to say the issue is
finished, and would need a second writer for `state.json`. The journal is
append-only, so an entry outlives the state it was written under — which is the
only property that makes the promise worth recording at all. The vocabulary is
closed the same way: `deferred`, `deferral-resolved`, `deferral-dropped`, and
`--reason` is required to drop one, because that sentence is the only record of
why something a reviewer raised is not being done.

What the journal adds over state: **`state.json` knows *where*, the journal knows
*why*.** "Why is slice #2 stacked rather than branched from main" is recoverable
six months later only from here.

---

**In brief** — [`architecture/`](../architecture/README.md): [1 · The constraint](../architecture/01-constraint.md) · [2 · The pieces](../architecture/02-pieces.md)

**In practice** — [`workflows/`](../workflows/README.md):

- [Where the state lives](../workflows/reference/state.md)

← [1 · Domain model](01-domain-model.md) · [Contents](README.md) · [3 · Commands](03-commands.md) →
