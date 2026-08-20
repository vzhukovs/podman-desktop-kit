# podman-desktop-kit — design specification

The design behind the plugin: what it is for, what each piece guarantees, and
why the guarantees are drawn where they are. It is a design document rather
than a manual — [`workflows.md`](workflows.md) is the manual — and it is written
for someone deciding whether to trust a step, extend it, or argue with it.

Two conventions matter for reading it:

- **Section numbers are stable.** Roughly eighty comments across `lib/` cite
  "section 7", "section 2.2", "invariant 1". They mean the sections below.
- **Claims are scoped deliberately.** Where a guarantee is narrower than it
  sounds, the narrowness is the design, and the text says so rather than
  rounding up. Section 13 lists what has never been executed at all.

---

## 0. What is taken from the references, and what is rejected

Four projects solve neighbouring problems, and the plugin is largely an
assembly of their answers with one structural change.

| Source | Taken | Why it works | Not taken |
|---|---|---|---|
| **github/spec-kit** | The **constitution**: a set of project rules every phase refers to. `[NEEDS DECISION]` markers in a plan instead of silent assumptions. Phase gates with explicit human verification at each seam. | podman-desktop's upstream rules — SPDX, conventional commits, `generate:schemas`, husky and `Signed-off-by` — *are* a constitution. They cannot live in a prompt: both planning and preflight have to reference the same file. | The Python CLI and `specify init` copying templates into your repository. Ours is a fork of somebody else's project; nothing may be littered into it. |
| **automazeio/ccpm** | The **context firewall**: subagents read a lot and return little. Explicit `parallel` / `conflicts_with` / `depends_on` in task metadata. A worktree per unit of work. Local state, synced outward as a separate step. | It addresses exactly what is most expensive here: Opus context, and write collisions between parallel workers. | **GitHub Issues as the database.** ccpm owns its repository and writes epics and sub-issues into it. We work in somebody else's upstream, where service issues and comments are not ours to create. The source of truth is local files. |
| **gmickel/flow-next** | The most important source. **R-IDs**: requirements numbered once, never renumbered, traced spec → task → commit → PR coverage table. **Re-anchoring**: a worker re-reads the plan, the task and git state before starting. **Receipts**: "done" means attached command output, not narrative. **Adversarial gates**: plan and implementation reviewed by a separate instance with fresh context. **PR-as-cognitive-aid**: the body is a tool for the reviewer. **Source tagging** (`[user]` / `[paraphrase]` / `[inferred]`) on requirements. **Auto-blocking** a task after N attempts. **A thin deterministic CLI with the agent as the intelligence.** | It is a set of answers to failures that had already been observed: planning without reading code, "done" without proof, a model agreeing with its own plan, drift over a long session. | **Autonomous overnight runs.** For a fork that opens upstream pull requests this is unnecessary and dangerous: the cost of a mistake is public noise in a project you do not own. **Cross-model review** through an external CLI — a separate dependency; replaced with fresh-context review, with the caveat in section 11. |
| **wshobson/agents** | Per-agent model selection in frontmatter as routing rather than manual terminal juggling. Narrow reviewer specialisation by axis, run in parallel and synthesised afterwards. | Reviewing somebody else's pull request is exactly a parallel multi-axis read. | Auto-delegation by `description`. For a workflow plugin that is a source of surprise activations; every orchestrating skill here is `disable-model-invocation: true`. |

**The one structural divergence from all four.** Each assumes you own the
repository and can keep state inside it — `.flow/`, `.claude/epics/`,
`.specify/`. We work in a fork that upstream pull requests leave from, so
service state in the working tree is a risk of it reaching a diff and then a
pull request. **State therefore lives outside the repository**, in
`$PDKIT_HOME`, keyed by issue number. That also settles worktrees: five
worktrees see one state rather than five copies of it.

---

## 1. Domain model

The unit of work is an **upstream issue**. Not an epic, not a spec, not a PRD.
An issue has:

- a **nature** (bug / feature / enhancement / tech-debt / dep-bump / docs) and a
  **size** (trivial / standard / multi-slice), both decided at triage, and
  together they pick the route;
- an **R-set** — numbered requirements `R1..Rn`, frozen once the plan is approved;
- a **plan** — how it will be built, with a file-ownership map and executable
  done-criteria;
- a **slice graph** — how one change set becomes N atomic pull requests;
- a **set of pull requests**, each with its own lifecycle (CI, review threads, merge).

### The state machine

Transitions are permitted by `pdkit`, never by an agent.

```
new
 └─ triage ──────────────► triaged
                            ├─ (trivial) ──────► quickfix ──┐
                            └─ plan ──► planned              │
                                         │                   │
                              plan-review│                   │
                                         ▼                   │
                                   plan-approved  ◄── human  │
                                         │                   │
                                      exec                   │
                                         ▼                   │
                                   implemented               │
                                         │                   │
                                   validate                  │
                                         ▼                   │
                                    validated                │
                                         │                   │
                                     audit                   │
                                         ▼                   │
                                     audited                 │
                                         │                   │
                                     slice                   │
                                         ▼                   │
                                sliced ─► slices-approved ◄── human
                                         │                   │
                                  preflight ◄────────────────┘
                                         ▼
                                 preflight-green
                                         │
                                    pr (GATE)  ◄── human, in the same turn
                                         ▼
                                   pr-open ──► review-in-progress ⇄ pr-sync
                                         ▼
                                     merged | abandoned

     triaged ─┐
     planned ─┴─► answered ──► resolved | planned | abandoned
                (the answer is published; we are waiting on the reporter)
```

### The `answered` branch — an issue whose deliverable is not a diff

It happens more often than it sounds. The bug is real and reproducible, and the
cause lives in a dependency, in the host, or across a version boundary the
product merely triggers. The work then produces a reproduction, a detector
command and a workaround, published as a comment.

Entry is guarded by the same rule as PASS: **`answered` cannot be entered while
nothing has been captured.** What is checked is the presence of a capture under
`validation/` — a file only a real run produces, since `lib/evidence.js` has no
input through which text could be handed to it. The same device holds ordering
on the `redo` route through `archaeology.json`. The guarantee is narrow and is
stated narrowly: a capture happened. That the workaround *works* is not
something code can confirm, and promising it would buy a check that reports on
work it did not do.

**`answered` is not terminal**, and that is a correction a live run made to the
design. A terminal "settled without a diff" was the obvious shape, and it is
wrong: at the moment the findings are posted the issue is not settled, it is
**waiting on the reporter**. The machine could already wait on a reviewer
(`review-in-progress`, `awaiting-review` by domain) and could not wait on a
reporter. Hence three exits, all of which happen: confirmed → `resolved`; the
answer implies product work → back to `planned`; nobody answers → `abandoned`.

`resolved` is deliberately separate from `merged` and from `abandoned`. The
first claims a change landed when none did; the second says the work was
dropped, when here the work *was* the entire deliverable. Either reading would
be false, and nothing on disk would correct it.

### The `rework` edge

From `pr-open` and `review-in-progress` there is an edge back to `triaged`. A
reviewer rejecting the *approach* rather than a detail is an ordinary outcome of
review in somebody else's repository, and without this edge there were two
exits: push again (which assumes the design survived) and abandon an issue still
worth doing.

The edge leads to `triaged` rather than `planned` on purpose: the route is
chosen again, and planning starts from the issue rather than from the rejected
diff — the same ordering `escalate` imposes, for the same reason. The pull
request stays open, the branch stays put, and `--reason` is required.

### There is no edge into `new`, and starting over does not add one

A run can go wrong early — the triage reads the issue as something it is not,
the scouts map the wrong package — and then every later step inherits the
mistake, because every later step reads what the earlier ones wrote. The machine
had no answer for that: `new` has no predecessor, so nothing could return an
issue to the state its own artefacts had never been produced in.

Adding such an edge would be the wrong fix, and the reason is the same one
`adopted` exists for. A transition writes history, so an issue that travelled
back to `new` would carry a trip the work never took, and "these artefacts were
never produced" would stop reading differently from "these artefacts were lost" —
which is the distinction every downstream check depends on.

So `pdkit reset <issue>` **removes the record instead of moving it**. With no
`state.json`, `state.read` returns `blank()`, which is the machine's own
representation of nothing has happened here, and `new -> triaged` is the only way
out of it. The contract is in section 4.

### The machine names the next command, not only the next state

`pdkit state` has always been able to say where an issue may go next, and until
0.29 that was all it said: `next: implemented`. That is a **state**, and a state
name in the position where a next action belongs is one that gets typed.

Seven of the eight states in the chain are spelled like the command that reaches
them — `triaged`/`triage`, `planned`/`plan`, `validated`/`validate`,
`audited`/`audit`, `sliced`/`slice`, `preflight-green`/`preflight`,
`pr-open`/`pr`. The eighth is `implemented`, reached by `/pd:exec`. A session on
DESKTOP-18832 finished a plan review, read `next: implemented`, applied the
pattern that holds seven times out of eight, and told the user to run
`/pd:implement` — which does not exist.

Nothing in the plugin had contradicted it. Every skill in the chain ended on a
`pdkit state --to` call and named nothing after it: the forward links did not
exist, so `/pd:plan` pointed at `/pd:plan-review`, `/pd:plan-review` pointed back
at `/pd:plan`, and past that the chain simply stopped.

So `lib/state.js` carries `ADVANCES`, a state → skill table, and `nextStep()`
resolves it against the record — against the record rather than the state,
because one answer depends on the route: a `triaged` issue on the quickfix route
goes to `/pd:quickfix`, and sending it to `/pd:plan` is what `escalate` exists to
undo. Three places print it: the transition, the record, and the SessionStart
summary. The skills say it too, but the table is what is printed by the command
the model has just run, whether or not it read anything — the same argument
section 6 makes for hooks.

Two states answer with a sentence rather than a command, and deliberately.
`sliced` and `planned`-after-review wait on an approval that is a person's to
give, and naming a skill there would name one that must not run yet.

### The hard rule

**`pdkit gate` lets `git push` and `gh pr create` through only from
`preflight-green`, and only for a branch present in the approved graph.**
Everything else is denied at the hook, not at the prompt.

---

## 2. Plugin structure

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

### What `lib/` holds

| Module | Responsibility |
|---|---|
| `cli.js` | argv parsing, exit codes, `--json` |
| `doctor.js` | environment checks; separate from `cli.js` so two hundred lines of probes do not live in a command dispatcher |
| `config.js` | three layers: `defaults/config.yaml` ← `$PDKIT_HOME/config.yaml` ← `<repo>/.pdkit.yaml` |
| `yaml.js` | a reader for a deliberate subset of YAML (see section 9) |
| `state.js` | the section 1 machine on disk; validates transitions |
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
| `slice.js` | the slice graph, topological sort, standalone verification, materialisation, cascade; owns `slices.json` |
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

### What is deliberately absent from the tree

- **`.mcp.json`** — a plugin's MCP servers load with the plugin as a whole, and
  section 8 requires Playwright and context7 to be optional. Configuration is
  documented instead, and `/pd:doctor` checks it.
- **`commands/`** — the skills-versus-commands fork was settled in favour of
  `skills/`. Two sources of truth for one behaviour is not a trade.
- **`scripts/`** — every hook goes through the single `bin/pdkit` binary.

### 2.1 What planning got wrong, and how

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
  see one state" had been an argument since section 0, and nothing could create
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
- Stage 6 (scenario 6) found the cycle had no **entrance**. Every stage began at
  `/pd:triage <issue>` — with a number somebody had already chosen.

Two modules broke the pattern by *not* needing an owner. `lib/attempts.js`
derives the attempt count from the journal rather than storing it: storing would
mean either a second writer for `state.json` (a direct breach of invariant 1) or
a new state file for one integer, and the journal is append-only by construction
and already records what happened. `lib/stats.js` measures rather than owns.

### 2.2 State, outside the repository

```
$PDKIT_HOME/                     # default: ~/.pdkit/podman-desktop
├── config.yaml
├── package-map.json             # generated by pdkit init from pnpm-workspace.yaml
├── gates/                       # ephemeral consent tokens, TTL
├── active/                      # what is running in which working tree; one file
│                                #   per tree, named by a hash of its path
├── issues/12345/
│   ├── state.json               # the machine, timestamps, who approved what
│   ├── issue.md                 # issue snapshot + triage verdict + R-set
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

1. **Only `lib/state.js` writes `state.json`.** Section 1 transitions are
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
   `--status`.

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

### 2.3 The journal

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

## 3. Commands

Every orchestrating skill is `disable-model-invocation: true`. Nothing starts on
its own.

| Command | In | Out | State | Model | Gate |
|---|---|---|---|---|---|
| `/pd:doctor` | — | environment report | — | sonnet | — |
| `/pd:sync` | — | fork and worktree status | — | sonnet | — |
| `/pd:triage [<issue>]` | number/URL, or nothing | with a number: `issue.md`, draft R-set, route. Without: a backlog shortlist, and nothing is written | `triaged` / — | opus | — |
| `/pd:plan <issue>` | issue | `research.md`, `plan.md`, open questions | `planned` | opus + sonnet scouts | human: approval |
| `/pd:plan-review <issue>` | issue | `plan-review.md` | — | opus, fresh | — |
| `/pd:exec <issue> [T*]` | issue/task | code, commits, `receipts/*` | `implemented` | sonnet workers | — |
| `/pd:validate <issue>` | issue | `validation.md` + artefacts | `validated` | sonnet | — |
| `/pd:audit <issue>` | issue | `audit.md` | `audited` | opus, fresh | — |
| `/pd:slice <issue>` | issue | `slices.md` — the PR graph | `sliced` | opus, fresh | human: approval |
| `/pd:preflight <issue\|slice>` | issue/slice | pass/fail + output | `preflight-green` | sonnet | — |
| `/pd:pr <issue> [slice]` | issue | branches, PR bodies, open PRs | `pr-open` | opus | **push gate** |
| `/pd:pr-status` | — | dashboard across open PRs | — | sonnet | — |
| `/pd:pr-sync <pr#>` | PR | plan amendment → fixes → replies | — | opus + sonnet resolvers | human: the amendment; **push gate** |
| `/pd:resume <issue>` | issue | drift analysis, rebase, amendment | — | opus | — |
| `/pd:review-pr <pr#>` | PR | `reviews/<pr>.md` | — | opus + 4 sonnet axes | — |
| `/pd:quickfix <issue>` | issue | fix + PR | `pr-open` | sonnet | **push gate** |
| `/pd:close <issue>` | issue | knowledge harvest, worktree cleanup | `merged` | sonnet | — |
| `/pd:reset <issue>` | issue | what would go and what would stay; with `--confirm`, one issue forgotten | record removed, so `new` | sonnet | human: `--confirm` |
| `/pd:knowledge` | — | revision of `knowledge/` | — | opus | — |

### Phrase-triggered skills

Three skills carry no slash discipline and fire by meaning:

- `package-map` — "which package owns X", "which layer is responsible for Y"
- `upstream-rules` — fires when a commit or a new file enters the context;
  reminds about SPDX, scope, and squashing with `git reset --soft`
- `worktree-kit` — create / list / switch / clean up, copying `.env`, sharing the
  pnpm store

They live in the same directories as the orchestrating skills, so they can also
be invoked explicitly (`/pd:package-map`). The only difference is frontmatter:
they carry no `disable-model-invocation`.

---

## 4. Contracts of the key commands

### `/pd:triage <issue>` — the entry point that cannot be skipped

Half the value of the plugin is here: it decides **whether planning is needed at
all**.

1. `pdkit issue fetch <n>` — body, labels, comments, linked pull requests.
2. **Dedup**: open pull requests referencing the issue; closed ones (a revert
   means the `redo` route, and `pd-archaeologist`).
3. Two or three `pd-scout` runs in parallel locate the affected packages. Reading
   the code wholesale is forbidden — a map only.
4. Nature and size. The `trivial` threshold: an estimated diff of ≤ 20 lines,
   ≤ 3 files, no `packages/extension-api`, no schema changes, no new dependencies.
5. A draft R-set with a **source tag** on every requirement: `[issue]` verbatim,
   `[paraphrase]` reworded, `[inferred]` supplied by the agent, `[review]` stated
   by a reviewer. The fourth tag appeared during a rework: for an issue returning
   from review the strongest requirement comes from a maintainer's objection
   rather than from the issue, and there was no tag for it. A read-back is
   mandatory: the `[inferred]` list is shown separately, before the file is
   written. It is a cheap defence against "the plugin invented the requirements".
6. Verdict: `ROUTE: quickfix | standard | multi-slice | redo | invalid`.

**On the `quickfix` route tracing goes by issue number and no R-IDs are
allocated.** A single `R1` on a one-line fix is ceremony for the sake of
uniformity. Three consequences follow, and all three are implemented:

- the PR body carries `Fixes #12345` instead of a coverage table, and
  `Steps to check` stays mandatory regardless of diff size;
- preflight skips the R-ID coverage check and **nothing else**;
- **escalation.** If the fix outgrows the thresholds, the route is raised to
  `standard` and **R-IDs are allocated at that moment** — from requirements
  recovered out of the issue, not out of the code already written. The ordering
  is the point: R-IDs derived from a finished diff describe what was built rather
  than what was needed, and the whole trace becomes self-confirming.
  `pdkit issue escalate <n>` rolls the state back to `triaged`.

The `invalid` route is also a result: duplicate, already fixed, does not
reproduce. Its output is a draft comment; publishing is a human action.

#### The `redo` route

The machine goes first, as everywhere. `pdkit issue history <n>` collects facts
and reaches no verdict.

| Mechanically, `pdkit issue history` | Left to `pd-archaeologist` |
|---|---|
| which PR landed it, when, whose, what it touched | why it was reverted — in the revert's own words, not a paraphrase |
| which PR reverted it, and which regression issue that one cites | whether the objection was to the approach or to details |
| how many days the change lived in the base branch | whether the objection still applies today |
| what reviewers said: `CHANGES_REQUESTED` and blocking threads, bots collapsed | what this attempt must do differently |
| what merged in the same files **after** the revert | |
| what could not be established (`gaps`) | |

Two things here are not obvious, and both were found on a live issue:

- **A revert references the pull request, not the issue.** Asking the issue's
  timeline is not enough: `#17829 revert: #16294` does not appear in the timeline
  of issue #12775, which that PR closed. So every merged PR gets a second
  question — "who references you".
- **The attempt and its revert are established as a pair, not picked by date.**
  The newest merge on an issue can easily post-date the revert, and then the
  report shows an attempt its own revert precedes: a lifetime of zero days and
  review comments from an unrelated pull request.

**The ordering is not advice.** Section 10 requires archaeology before any
implementation. Until it was implemented that ordering was held by a sentence in
a prompt; now `state.transition` refuses to leave `triaged` on the `redo` route
while `archaeology.json` is absent, and that file is written only by a real
lookup. Same device as receipts: not a stricter check, but the absence of a way
to do without the input.

#### Batch mode: `/pd:triage` with no number

A different question — not "how do I do this issue" but "which one". The machine
goes first here too: `pdkit issue list [--label a,b] [--limit 20]` returns the
open backlog with the facts that say whether an issue can be started at all.

| Mechanically, `pdkit issue list` | Left to the model |
|---|---|
| pull requests referencing the issue **in this repository**; an open one means work is under way | whether the requirement is clear enough to plan against |
| assignee: somebody has taken it | whether behaviour is described concretely enough to check |
| whether a maintainer replied (`MEMBER`/`OWNER`/`COLLABORATOR`), **excluding the issue author** | how big this looks |
| whether a bug report carries a reproduction: a `Steps to reproduce` section with content, not `_No response_` | whether it is worth taking now |
| which upstream template the body follows, or none | |
| how many days since a **human**, not a bot, touched it | |
| a merged PR plus a revert — a `redo` candidate; closed without merge — the attempt was already rejected | |

One GraphQL request for the whole list rather than one per issue: `gh issue list
--json comments` returns empty arrays, so the obvious shape would cost twenty
round trips and still need a second call. One request is about 1.3 s, and gives
every issue the same instant in time.

Three things here are not tidiness, and each was found by a live run:

- **A linked PR must be in this repository.** A cross-reference can arrive from
  anywhere on GitHub; on #18381 it was a merged pull request in a stranger's
  prototype repo.
- **Idle time is measured from human activity, not `updatedAt`.** The stale bot
  moves the timestamp, so sorting by it floats precisely the abandoned issues to
  the top.
- **The issue author is not "the project answering"**, even when they are a
  `MEMBER`.

The output is an **order over facts, not a recommendation**: blocked last, then
by number of signals, then by human recency, then by issue number so two runs
print the same list — an order that reshuffles cannot be discussed. There is
deliberately no `score` field: what actually decides is not in the table, and a
number would look measured.

**Batch mode writes nothing and moves nobody.** A listing that triaged for you
would be a listing that chose for you, and choosing is the one non-mechanical
part of the scenario.

### `/pd:plan <issue>` — the plan as the only handoff artefact

**Phase 1, reconnaissance.** At least three `pd-scout` runs **in parallel**, on
different questions: where the logic is, which reusable patterns exist, how the
area's tests are built. The scout's response format is strict — ≤ 40 lines, every
claim carrying `file:line`. The host does not read files broadly itself.

**Phase 2, forks in the road.** Anything the scouts flagged as a choice goes to
the human. A question not asked becomes `[NEEDS DECISION]` in the plan, and that
blocks approval.

**Phase 3, the plan** by `templates/plan.md`. Eight requirements; a breach means
a rewrite:

1. Each task owns its files **exclusively**. Overlap is a planning error.
2. `Done when` is an executable command with expected output. Prose is forbidden.
3. Interfaces between tasks are hoisted into `Frozen interfaces` as real signatures.
4. A task is 1–3 files.
5. Every context item cites `file:line` from the reconnaissance.
6. Every task declares `satisfies: [R1, R3]`. A requirement with no task and a
   task with no requirement are both errors.
7. `Upstream compliance` is filled in from `knowledge/upstream-rules.md`.
8. `Slice hypothesis` — a preliminary guess at the cut.

Item 8 is the non-obvious one and it is critical. Plan without slicing in mind
and the diff comes out interleaved, and cutting it into atomic pull requests
afterwards is impossible without rewriting the work.

### `/pd:plan-review <issue>` — reviewing the plan before any code

Fresh context, through `pd-plan-critic`. **The ordering matters more than the
content: machine first, then model.**

1. `pdkit plan check <n> [--json]` — mechanical failures. Template sections
   present; `Owns` exclusive between tasks; `Done when` a command in backticks
   rather than prose; every R-ID closed by at least one task and every task
   citing an existing R-ID; `e2e coverage` filled in; `Slice hypothesis`
   non-empty; no `[NEEDS DECISION]` left.
2. `pd-plan-critic` receives the plan **and that report**, and spends itself on
   the question code cannot check: is this task needed at all, and does a utility
   for it already exist.

The split rests on the same argument as the API-surface grep in section 7: this
is not a heuristic for an agent, it is a grep. An Opus looking for an overlap
between `Owns` lists is an Opus that may not find it; `pdkit plan check` cannot
fail to.

The output is `plan-review.md`, and the state does not move: a red `plan check`
means the plan is rewritten, not that approval is refused, and the human decides.

### `/pd:validate <issue>` — evidence instead of claims

The only phase that must **look at the running application**. The order is: bring
it up, explore, codify what was seen into a test, and only the run of the
codified test counts as proof.

1. `pdkit validate steps` — what is subject to checking: the R-set, the tasks
   with their `Done when`, the `e2e coverage` decision, and what is already
   attached.
2. `pdkit validate launch` brings the built application up under CDP. The shape
   is taken from upstream itself
   (`tests/playwright/src/runner/chrome-dev-tools-protocol-runner.ts`): the binary
   is spawned with `--remote-debugging-port` and readiness is decided by a reply
   on `/json/version`. Playwright MCP attaches to that endpoint.
3. `pd-validator` drives the application and attaches artefacts:
   `pdkit validate attach --evidence <file> --observed "<what is visible>"`.
4. The same scenario is codified into a `tests/playwright` spec, and
   `pdkit validate run` runs it. **The run is the basis for `pass`**; exploration
   screenshots are an attachment to it, not a substitute.

   That command must run **exactly that spec**. Appending a path to a resolved
   suite script is not narrowing if the script already carries a path of its own:
   podman-desktop's `test:e2e:run` ends in a directory, so Playwright receives two
   positional filters and runs all forty-four specs. Resolution order:
   `preflight.scripts.e2e_spec` with `{spec}` → the Playwright runner directly
   when the repository has a config for it → the script plus the spec, but only if
   the script names no path. Otherwise it refuses: a command that runs the whole
   suite under the name of one spec is worse than no command.
5. `pdkit e2e stability` — `validation.e2e_stability_runs` green runs in a row.
6. `pdkit validate finish` computes the outcome and moves the state.

Three outcomes, and the third is not leniency:

| Outcome | When | What follows |
|---|---|---|
| `pass` | every step has an artefact, no non-zero exits | the normal path |
| `fail` | a capture with a non-zero exit | not `validated`; fix it |
| `unverified` | steps without artefacts: no Playwright, the app will not build, the scenario is unreachable | the transition is **allowed**, but the gap must reach the reviewer |

`unverified` does not block `implemented → validated` on purpose: a gate that is
expensive to pass gets routed around, and without Playwright the pipeline would
stall outright. But the gap is not allowed to evaporate either:
`validation-evidence` in preflight requires every artefact-less step to be named
under `Notes for reviewers`. Same device as `inconclusive` for slices and CI:
blocking over something the change did not do teaches people to work around the
gate, and staying silent is a lie.

**Validation runs in the issue's working tree, not in the verification tree.**
The verification tree gets `reset --hard` and `clean -fdx` before every run, and
would eat the build validation exists to look at.

### `/pd:audit <issue>` — the diff against the plan

`pd-auditor` sees the diff and the plan and **does not see the implementer's
reasoning** — that is what makes it capable of disagreeing. The machine goes
first here too. `pdkit audit <n> [--base main] [--json]` collects facts and
reaches no verdict:

| Collected | Why |
|---|---|
| state, route, R-set and whether it is frozen | without the freeze, tracing means nothing |
| tasks with their `Owns` and `satisfies` | the map the diff is checked against |
| receipts: absent / invalid / non-zero exit | "done" without proof is visible before reading any code |
| changed files `base...HEAD` | |
| **files outside every `Owns`** | the auditor's third question, answered mechanically |
| R-IDs with no task, tasks with no R-ID | the first and second questions, at the level of the map |

Files outside `Owns` are the insurance against the hole in `pre-write`: the hook
says nothing when there is no active task, so an implementer launched around
`pdkit task start` is unconstrained. The hook catches it in time; the audit
catches it for certain.

What is left to the model: a requirement with code against it that is the wrong
code; code answering no requirement that nevertheless looks reasonable; a change
inside `Owns` that the task did not ask for. None of the three is greppable.

### `/pd:slice <issue>` — the part no reference has

Works from a **finished diff**, in fresh context (`pd-slicer`). Input:
`git diff main...HEAD --stat`, `plan.md`, `package-map.json`.

Two different graphs, not to be confused:

- **file independence** — slices do not share files. Checked mechanically.
- **symbol dependence** — slice B references a symbol slice A introduced. Not
  visible in the file lists at all.

A criterion, not an opinion: `pdkit slice verify` raises a worktree from `main`,
applies **only this slice**, and runs the repository's own typecheck, lint and
scoped tests there. **Green standalone → the slice is independent and branches
from `main`. Red → it needs a stack, and `base` is the preceding slice.**
Independence is preferred; a stack is the exception.

**A slice is a base plus a set of files, not a set of commits.** The form it is
verified and materialised through is one and the same:

```
git diff --binary --find-renames <base>...<ref> -- <the slice's files>
```

The reason is ordering. `slice verify --all` is step 1 of the `/pd:pr` flow — that
is, **before** any branch exists and before any squash. The slice's commits do
not exist at that moment, and the only thing that does is the diff restricted to
its files. `--from-pr` follows from the same shape: somebody else's published diff
is substituted for the local one and the slicer is unchanged.

Materialisation is the inverse of that diff: a branch from the base,
`git apply --index --binary`, one commit. **The original working branch is not
destroyed** — if the graph turns out to be wrong there is nothing to roll back.

**Freshness is checked by digest.** `slices.json` stores, per slice, the `sha256`
of that exact diff and the base SHA. `slice-standalone` in preflight recomputes
it in place: a mismatch is a **`fail` demanding a re-run, not a `pass`**. A green
verification of yesterday's diff is exactly the proof `lib/evidence.js` was
written against. As a side effect this also checks materialisation: a slice
branch's diff must match, byte for byte, what was verified.

| Mechanically, `pdkit slice set` | Left to `pd-slicer` |
|---|---|
| no two slices share a file | whether a slice stands on its own **in meaning**, without the next one |
| the union of slices is the whole diff; a changed file in no slice is an error | whether a slice is groundwork that must be acknowledged in the PR body |
| `base` is `main` or another slice; the graph is acyclic | which files make a meaningful slice at all |
| a slice whose standalone run is red cannot branch from `main` | the wording of `Why separate` and `Where to look` |
| `extension-api` files are in one slice, first, with no other layer | |
| a slice's R-IDs are derived from the tasks owning its files; the union covers the frozen set | |
| `max_files_per_slice`, and a slice spanning layers — a warning, not a refusal | |

`slices.md` is **rendered from `slices.json`**, never printed by an agent.

### `/pd:pr` — the only place that writes to GitHub

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
one, and `--base` in `gh pr create` must repeat it or upstream sees somebody
else's changes in the diff.

**Why two passes.** Six checks read the PR body, and the body depends on
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

### `/pd:pr-status` — the dashboard, and how a red CI is measured here

`pdkit pr list` returns facts for every registered pull request: slice, branch,
base, review decision, unresolved thread count, how far behind the base, how long
since anything moved. All reads; no state moves.

**The age of the reading is a column too.** Every field is what the last refresh
saw, and a ten-PR sweep costs 37 seconds, so nobody refreshes everything before
every glance: a stale row is the normal case. A three-day-old verdict used to
print identically to a one-second-old one; the row now ends in `read:<age>`, with
`←` past six hours. Same principle as `inconclusive` below: a measurement must say
what it did not see.

**There is no cache here, and that is a measurement rather than an omission.**
`pr refresh` costs 3 GraphQL points and 2.3 s on a green PR, 4 and 7.2 s on a red
one; a sweep of ten is 32 points against an hourly budget of 5000. Seconds are the
constraint, not the budget. The conditional refetch keyed on `updatedAt` that
suggested itself is refuted on its own terms: on eight of eight upstream PRs with
recent runs, CI finished **after** `updatedAt`, by 2.5 to 37 minutes. The
timestamp follows people, so that refetch would skip exactly the pull requests
whose CI verdict just changed.

The only non-trivial part is a red job. **A red CI has two possible causes and
they are told apart by measurement, not by reasoning:**

| Outcome | How it is reached |
|---|---|
| `fail` — we broke it | red here and green across the peers |
| `inconclusive` — red without us | the same job red on **other people's open upstream PRs**. Warn, not fail: blocking over what the change did not do teaches people to route around the gate |
| `flake` | the same job on the same commit reached different conclusions in different runs |
| `pass` | green |

**The baseline is the peer population, not the base branch, and that too is a
measurement.** podman-desktop runs `pr-check` on the `pull_request` event, so
those jobs never run on `main` at all and a base comparison would return "no such
job on the base" for every check — that is, `inconclusive` on everything. One
`gh pr list --json statusCheckRollup` over fifteen open PRs costs about two
seconds and shows immediately that `windows-11-arm update e2e tests` is red for
several independent authors at once.

**And what is left to the model is answered by the failure text, not the job
name.** Returning a verdict and a link asks the model to tell a platform
difference from a regression by the word "Windows" — exactly the reasoning-
instead-of-reading this plugin exists to replace. `pdkit pr ci` fetches
`--log-failed` for the jobs the measurement calls **ours**: `inconclusive`
describes somebody else's problem and `flake` is already the finding, so neither
pays for a request.

**The window is anchored on the error marker, and that is a measurement too.**
The first version took the tail. On #18590 the `##[error]` marker sits fifty lines
from the end of a 245-line log, and everything after it is the runner removing
credentials: a forty-line tail showed all cleanup and nothing about the failure,
confidently and with no sign of a miss. The real cause was
`E: Package 'qemu-user-static' has no installation candidate` — infrastructure,
which no reading of the diff would ever have found. What falls outside the window
is counted at **both** ends: a window that reports what it cut from the front and
stays silent about the back implies the log ended there. With no marker to anchor
on, the report says the window is the end of the file and may not be the failure.

The log is not stored. It expires, and a stale copy beside the verdict would
carry the verdict's standing — the freshness problem slices answered with a
digest rather than by keeping more.

### `/pd:pr-sync <pr#>` — feedback from review

1. `pdkit pr threads <n>` — unresolved threads, top-level comments, and review
   submission bodies through GraphQL.
2. **Bot filter.** Known bots collapse to one line with a link — collapse, not
   drop. A match against `review.bot_escalate` (security, data loss, correctness)
   expands the thread back.
3. **Clustering**, and mapping each thread to an R-ID / slice / file. A thread
   that maps to nothing is a signal: either the reviewer found a requirement the
   plan did not have, or they did not understand the PR. Both are valuable.
4. **Classification**: `accept` (fix it) / `discuss` (needs an answer, not a fix)
   / `defer` (separate issue) / `reject` (reasoned disagreement). A `defer` is
   recorded by `pdkit defer new`, not by the reply that mentions it — see 2.3.
5. If an `accept` changes the plan, `amendments/A<k>.md` is generated with the new
   or changed R-ID and the affected slices, **and it goes to the human for
   approval** — `pdkit amendment approve` or `reject --reason`. Approval moves no
   state: the plan becomes what the amendment says and the work continues against
   it, and what finds the work done against the previous version is `pdkit audit`.
   Until somebody decides, the amendment is a proposal and the plan has not
   moved, which is what `pdkit amendment list` says out loud.
6. `pd-thread-resolver` per thread, in parallel, each within its own files.
7. Cascade: if a fix touched a slice others are stacked on, `pdkit slice cascade`
   rebases the dependents and re-runs verification; whatever stopped being
   standalone is flagged.
8. Preflight → gate → push → replies and `resolve` through GraphQL.

| Mechanically, `pdkit pr threads` | Left to the model |
|---|---|
| bot or human, by account type | what the reviewer meant |
| thread → file → slice → task → R-ID | `accept` / `discuss` / `defer` / `reject` |
| a thread matching no slice is flagged | whether a plan amendment is needed |
| a `bot_escalate` match is marked "read in full" | the wording of the reply |

**The asymmetry in the last row is deliberate.** A word match **raises** a thread
and never lowers one. Mechanically discarding a security finding because it did
not contain the right word is precisely the mistake the bot filter exists to
prevent, not to commit.

**The unit of consent here is different from push.** A push token is per branch,
because each branch is a separately published artefact. Draft replies are read by
a human in one go, and one token for that showing is exactly what they approved;
a token per thread would mean confirming eight times in a row, and a gate that is
expensive to pass gets routed around. Hence `pdkit gate open --pr <k> --kind
reply`, eligible from `pr-open` and `review-in-progress`.

### `/pd:resume <issue>` — coming back after a break

1. `/pd:sync`: fetch upstream, update `main`.
2. `pdkit drift <issue>` — which upstream commits since the branch point touched
   our slices' files.
3. Rebase. Conflicts are classified by `pd-conflict-analyst`: **mechanical**
   (imports, formatting, a file moved) are resolved immediately, each resolution
   journalled; **semantic** (upstream rewrote what the plan stood on) means
   **stop**, analyse the new commits, and take a plan amendment to approval.
4. After the rebase, `preflight` and `slice verify --all` again. A previous green
   means nothing.
5. Hand off to `/pd:pr-sync` for accumulated threads.

**Each slice has its own branch point.** It is the `merge-base` of the slice's
branch with its base, and for a stacked slice the base is the predecessor's
branch, not `main`. Measuring drift from `main` for a stacked slice shows
somebody else's commits in it — the same error that stage 3 closed with "the
preflight base comes from the graph".

What `pdkit drift` adds over a commit list is a separate column: did the commit
touch **the lines the plan cites** (`file:line` from task context). A commit in
the file is a candidate for a mechanical conflict; a commit in the cited lines is
a candidate for a semantic one. It is a hint, not a verdict, and it must not turn
into permission to skip reading the new commits.

This is the only place `git push --force-with-lease` is permitted — through the
gate, on your own branch. `--force` without a lease is denied at the hook always.

**Work that predates the plugin is adopted, not replayed.** The ordinary case is
the reverse of scenario 5: a branch and a pull request exist while `state.json`
says `new`. Walking it through the whole chain so the record "agrees" would mean
writing a plan nobody planned and freezing requirements nobody stated — inventing
exactly the artefacts the machine exists for. `pdkit issue adopt <n> --pr <k>
--branch <b> --reason <why>` records what exists and stops: state, route, PR
number, and an `adopted` field with the reason. The artefacts of the states it
never passed stay missing, and `adopted` explains why — an issue with no plan
because nobody wrote one and an issue whose plan was lost are different things.
Adoption is possible only from `new`: overwriting a live record would erase the
one history that cannot be rebuilt.

### `/pd:close <issue>` — the end of the cycle

`pdkit close --issue <n>` collects facts: what merged and when, what amendments
there were, which drift and regression events the journal recorded, which checks
went red on the way. Which of that is knowledge worth adding to `knowledge/` is
the human's call; `close` writes nothing there itself.

Two mechanical steps: cleaning up the issue's working trees (`worktree remove`,
refusing on an unmerged branch), and **the transition to `merged` only on the
`prs.json` rollup**. An unclosed PR produces a refusal listing the numbers.

**Deferrals still open are named, and do not block.** Closing is the last step,
so there is no later gate to catch them at — which reads as an argument for
refusing until the other half is weighed: a gate standing between a finished
issue and its terminal state is paid every time and earns its keep almost never,
and that is the reasoning `unverified` already settled. What keeps the promise is
not the gate but the journal: `pdkit defer list` still answers after the issue is
`merged`.

### `/pd:reset <issue>` — starting one issue over

The failure it closes is ordinary and had no answer: a cycle that went wrong
early, where continuing means every later step inherits the mistake because every
later step reads what the earlier ones wrote. Before this command the only route
out was `rm -rf` on a directory whose neighbours share a parent — a thing nobody
should have to type carefully at midnight.

Shaped like `close`: bare, it reports and changes nothing; `--confirm` acts. The
two are the only commands standing where the question is whether a cycle is over,
and both are read by someone who wants the consequences before agreeing to them.

**Four stores hold something about an issue, and they are not treated alike.**

| Store | What happens | Why |
|---|---|---|
| `issues/<n>/` | archived to `archive/<n>/<timestamp>/`, or deleted on `--purge` | this is the research the next cycle must not inherit. Archived by default because a gate that is expensive to pass gets routed around, and an undo that is one `mv` makes `--confirm` cheap to grant |
| `gates/` | tokens carrying this issue's number are revoked | consent must not outlive the record that justified it. Matched on the `issue` field inside the token, not on its key: a reply token's key names a pull request, which says nothing about the issue unless you already hold `prs.json` — which is inside the directory about to move |
| `active/` | pointers naming a task of this issue are cleared, in every working tree | otherwise a hook is left enforcing an `Owns` set for a task whose file has gone |
| `journal/` | **kept**, and one `reset` entry appended | invariant 2. It is also what makes the reset legible: an issue back at `new` would otherwise be indistinguishable from one nobody ever worked on |

Two consequences follow from the journal being kept, and both are printed rather
than left to be discovered. **Deferrals survive**, because they are derived from
the journal precisely so a promise to a reviewer outlives the issue — and it
equally outlives us deciding to start again. **Nothing upstream moves**: an open
pull request is forgotten, not closed. That last one is the item worth reading
twice, and the design self-heals around it — dedup is the first step of triage,
so the next cycle rediscovers from GitHub what this one forgot.

Working trees are a fifth case and sit outside `$PDKIT_HOME`. A branch carrying
unpushed commits is *work*, not a record of work, so removal is `--worktrees`
rather than the default, and still goes through the check that refuses a tree
holding a branch which has not landed. A command called "start over" must not be
the thing that silently drops commits.

**One consumer had to change.** Attempt counts are derived from the journal, and
task numbering restarts with the record — so the T1 of the new cycle would
inherit the failures of the T1 of the old one and could be born blocked. The walk
now stops at the last `reset` entry, cut by position rather than by timestamp: the
journal is second-resolution, and a reset and the first capture after it can share
one.

### `/pd:review-pr <pr#>` — reviewing somebody else's pull request

The machine goes first here as well. `pdkit review fetch <k> [--json]`:

| Collected | Why |
|---|---|
| the diff `merge-base...refs/pull/<k>/head`, locally | against the tip of `main` it would carry every commit landed since, and the review would ask the author about work they never did |
| files → packages → layers | how many layers are mixed in one PR is the main cause of slow review |
| whether `extension-api.d.ts` is touched; diff exports found in it | the `RunOptions` trap in somebody else's PR is the same trap as in ours |
| schemas changed without `generate:schemas` | an upstream rule, living in `lib/upstream.js` |
| SPDX on added files | the same |
| the linked issue and its text | without it, `Requirement fit` is filled with nothing but guesses |
| review threads that already exist | so four axes do not repeat what reviewers said last week |
| CI status | a red CI is not a reviewer's finding, but it is context for one |

**Commit scope is not checked here.** Upstream does not require it; scope is our
own discipline, and spending an author's attention on a rule their project does
not have is how a review loses the standing to raise the ones it does.

Then four axes in parallel, each its own agent, each seeing the diff and the
target files:

| Axis | Agent | Looks for |
|---|---|---|
| Architecture fit | `pd-review-architecture` | does it sit in existing patterns; does it duplicate a utility; correct layer; coupling and dependency direction |
| API & compatibility | `pd-review-api-compat` | `extension-api.d.ts`; backwards compatibility; `Disposable` and leaks; schema changes without regeneration |
| Tests & quality | `pd-review-tests` | are the claimed edge cases covered; workarounds (`skip`, weakened asserts, `any`, `@ts-ignore`); test determinism |
| Product & UX | `pd-review-product` | fit to the issue; i18n, a11y, contrast; error and empty states; regressions in neighbouring flows |

`pd-review-synth` (opus) deduplicates, prioritises and reaches a verdict.

**Reviewer discipline, straight from experience: a reviewer told to find problems
will find them in correct code.** So the axis prompts forbid reporting style,
demanding defensive code for impossible cases, and "this could be more abstract".
**An empty section is a valid result.** And `What I could not verify` is
mandatory, against false confidence.

The report lands in `reviews/<pr>.md` and **is not published**. A comment on
somebody else's PR is an outward write, which needs a `reply` token, and a review
of a foreign PR is tied to no issue and therefore to no state such a token could
be issued from. A human publishes it, in their own words and under their own
account.

### `/pd:knowledge` — revising what everything else leans on

`knowledge/` ships with the plugin and is read by every subsequent issue. A base
nobody weeds is a base people stop believing; and "re-read four files" is reading,
not revision.

The mechanical half, `pdkit knowledge check [--json]`:

| Checked | Why it is a grep |
|---|---|
| paths and `file:line` that no longer exist in the fork | a link to a vanished file is literally "an entry that is now wrong" |
| `package-map.md` against `package-map.json` and `slicing.layer_order` | drift is found mechanically and accumulates silently |
| the shape of `pitfalls.md` entries (Looks like / Actually / Why it matters / Caught by) | a template, not a judgement |
| a `## What to add here` section in every file | the acceptance criterion for new entries is part of the base itself |
| issues closed since the last revision carrying `conflict-semantic` or `slice-regressed` events | a list of harvest candidates, not the harvest |

Left to the model: an entry that was wrong from the start; a lesson worth
rephrasing; a finding that will change nothing in a future run and is therefore
not knowledge.

The boundary with `/pd:close`: `close` proposes additions from **one** issue,
right after the merge, while the details are alive. `/pd:knowledge` is a periodic
revision of **everything**, and its input is facts rather than recent memory.

`pdkit knowledge export --json` prints the base for an external memory store. The
bridge is one-way: writing is done by the skill, and there is no reverse import —
otherwise two sources of truth diverge and `knowledge/` stops being portable.

---

## 5. Agents and model routing

| Agent | Model | Tools | Role |
|---|---|---|---|
| `pd-scout` | sonnet | Read, Grep, Glob, Bash (ro) | reconnaissance, ≤ 40 lines, every claim `file:line`, proposes nothing |
| `pd-implementer` | sonnet | everything except push/gh | one task, only files from `Owns`, a receipt with real output |
| `pd-auditor` | opus | Read, Grep, Glob, Bash (ro) | diff against plan, fresh context |
| `pd-plan-critic` | opus | Read, Grep, Glob | adversarial review of the **plan**, before code |
| `pd-slicer` | opus | Read, Grep, Bash | the slice graph, from the finished diff |
| `pd-validator` | sonnet | Bash + Playwright MCP tools | drives the built application, collects evidence |
| `pd-archaeologist` | sonnet | Read, Bash (git log/blame) | history: reverts, regressions, who and why |
| `pd-conflict-analyst` | opus | Read, Grep, Bash | mechanical conflict or semantic |
| `pd-thread-resolver` | sonnet | Read, Edit, Bash | one review thread → fix + draft reply |
| `pd-review-*` (4) | sonnet | Read, Grep, Glob | the review axes |
| `pd-review-synth` | opus | Read | synthesis into one verdict |

**The Tools column is the `tools:` field in agent frontmatter, and there are no
other levers.** Plugin agents support neither `mcpServers` nor `hooks` nor
`permissionMode` in frontmatter. Two consequences follow:

- **An MCP server lives at session level, not agent level.** Playwright is not
  "granted" to `pd-validator`; the user connects the server, and `tools:` decides
  which agents can see its tools.
- **The `pd-implementer` restriction is `tools` plus `disallowedTools` plus the
  global Bash hook**, not `permissionMode`. A prompt does not hold that, which is
  why it is duplicated by a hook.

**Model routing is set by `model:` in frontmatter** — in `skills/*/SKILL.md` and
`agents/*.md`. That is the single source of truth; the config deliberately has no
`routing:` block. Changing `pd-auditor`'s model changes the properties of
acceptance, and that should not switch on an unnoticed parameter.

**Honestly about token economics.** "Opus plans, Sonnet implements" saves less
than it appears: to plan well, Opus has to understand the code, which causes a
double investigation — first the scouts, then itself. The real saving comes from
three other things: the scouts compressing the map (Opus reads 40 lines instead
of 4000), fresh context per task (no accumulation of failed attempts), and
receipts instead of diffs at acceptance. The model split is a consequence, not a
cause. On a tight budget, keep Opus on `plan`, `slice` and `audit`, and run
everything else on Sonnet.

---

## 6. Hooks — where a prompt does not guarantee

Instructions in skills are advisory. Hooks are deterministic.

**The constraint that shapes the whole construction.** The `matcher` field in
`hooks.json` is compared **only against the tool name** (`Bash`, `Write`,
`Edit`) — never against the command string. `Bash(git push*)` cannot be written
as a matcher: such a hook either never fires or fires in the wrong place. So
`hooks.json` stays thin — six entries, all on one binary — and the conditions on
the command string are applied by code in `lib/hooks/`.

| Event | Matcher | Handler |
|---|---|---|
| `PreToolUse` | `Bash` | `bin/pdkit hook pre-bash` |
| `PreToolUse` | `Write\|Edit` | `bin/pdkit hook pre-write` |
| `PostToolUse` | `Write\|Edit` | `bin/pdkit hook post-write` |
| `TaskCompleted` | — | `bin/pdkit hook task-completed` |
| `SessionStart` | — | `bin/pdkit hook session-start` |
| `PreCompact` | — | `bin/pdkit hook pre-compact` |

The rules the handlers apply:

| Handler | Rule | Behaviour |
|---|---|---|
| `pre-bash` | `git push`, `gh pr create` | deny without a valid **`push`** token for that branch; otherwise allow and spend the token |
| `pre-bash` | `gh pr edit/review/merge/comment`, `gh api` with a mutation | deny without a valid **`reply`** token for that PR. Such writes belong to no branch, and the token is not spent: the unit of consent is the batch |
| `pre-bash` | `gh issue comment`, `gh issue create/edit/close` | **deny always.** No state authorises a write to the tracker, and the one route that produces issue text says a human posts it. A gate that cannot open is worse than a refusal that says what to do |
| `pre-bash` | `git push --force` without `--force-with-lease` | deny always |
| `pre-bash` | `git add -A`, `git add .` | deny always, with a hint to list paths |
| `pre-bash` | `git rebase -i` | deny, hint `git reset --soft <base>` — husky's `commit-msg` appends `Signed-off-by` and then rejects the duplicate it created |
| `pre-bash` | `git commit --no-verify` | deny |
| `pre-write` | a path outside the active task's `Owns` | deny |
| `pre-write` | no active task in this working tree | allow — the restriction belongs to executing a planned task, not to having the plugin installed |
| `post-write` | a new file without the SPDX header | exit 2 with the text to paste |
| `post-write` | `*.ts` under schemas | remind about `generate:schemas`, mark `schemas_dirty` |
| `task-completed` | no `receipts/<TASK_ID>.md`, or it fails `validateReceipt` | exit 2 with the exact command to run |
| `task-completed` | a real receipt with `exitCode ≠ 0` | exit 2: the `Done when` command did not pass |
| `task-completed` | this is the `exec.max_attempts`-th failure in a row | exit 2, with a **different** message: the task is blocked, and the question is not "fix it and capture again" but "what changed between the second attempt and the third" |
| `session-start` | — | inject the summary: active issue, state, next step. This is re-anchoring |
| `pre-compact` | — | flush the active state to the journal so compaction does not eat the task context |

**Command recognition is not substring search.** `lib/hooks/command-parse.js`
strips leading assignments, splits on `&&`, `||`, `;`, `$()` and backticks, sees
into subshells and brace groups, resolves a program named by path, unquotes
argv[0], and strips **wrapper programs**. That last one is not about any
particular tool: hooks on the Bash tool are global, so a wrapper can appear in
this project without this project being told, and the question is never "did
somebody mean to wrap it" but "what is going to run".

Two consequences of the rules living in code rather than in JSON: they are
versioned with the plugin, and they are unit-tested. For a circuit where a
mistake costs public noise in somebody else's repository, that is not a luxury.

### Two kinds of token

Until stage 4 every outward write was tied to a branch, and `gate.open` required
a branch name parsed as `DESKTOP-<n>/…`. A reply to a review thread and a
`resolve` are also writes into somebody else's repository, but they have no
branch at all, and at that moment the issue sits in `review-in-progress` rather
than `preflight-green`. No token of that shape could be issued.

Hence `--kind push` (per branch, only from `preflight-green`) and `--kind reply`
(per PR, from `pr-open` and `review-in-progress`). The eligible states live in
code (`state.GATE_ELIGIBLE`, a map by kind), not in the config: the only thing a
config key could do is widen the list, and a widened push list is a token issued
before preflight.

**This also closed a hole nobody had seen.** For commands with no branch of their
own, `dispatch.js` fell back to the current branch. So the token issued to push
slice #1 also authorised a review reply, a comment in somebody else's tracker,
and any `gh api` mutation: one confirmation, given for publishing code, working
for writes nobody was asked about. Token kinds remove that not by adding a check
but by making keys of different kinds unfindable for one another.

A hand-written `gh api graphql` mutation is a separate case: the PR number is
nowhere in it, so there is nothing to check a token against. Such a command is
refused with a hint to use `pdkit pr reply --pr <n>` rather than matched against
whatever token happens to be lying around.

### Receipts, and why the ceiling holds

The two `task-completed` rows rest not on the strictness of the validator but on
**who produces the receipt**. `pdkit` does: `pdkit receipt write --issue <n>
--task T1` reads the command out of the task's `## Done when`, runs it through
`lib/evidence.js` (by spawning it directly, so nothing can sit between the
command and its output), and records what it printed. There is no parameter
through which an agent could hand over text — the "summarise the run
convincingly" path is closed by the absence of an input, not by a check. The
validator catches the remainder: a file edited by hand (the digest over the
`## Output` block stops matching) and a truncated capture (`complete: false`).

**The attempt ceiling holds by the same device.** What increments the count is a
capture with a non-zero exit — the same input that decides everything else about
completion. There is no input through which an agent could declare "this was the
first attempt". Two things reset it, and both mean somebody went through the
task: a green capture, and an explicit unblock with a reason. The config
(`exec.max_attempts`) can only weaken it — zero switches blocking off entirely —
and that is deliberate: somebody who decides a fourth attempt is sensible says so
once, rather than learning to scroll past a message.

The separation of duties is strict: `validateReceipt` answers only "is this a
real capture", not "did the run succeed". A red `pnpm test:main` produces a
**valid** receipt — it is the proof that matters most — and the hook decides "the
task is not done" by reading `exitCode`. A validator that rejected evidence for
proving a failure would return us to receipts it is profitable not to attach.

---

## 7. Preflight — the deterministic gates

`pdkit preflight [--slice N]` returns a machine-readable report. Twenty checks:

| Check | How | Blocking |
|---|---|---|
| **working tree** | `git status --porcelain` is empty. First in the report: without it the rest are ambiguous | ✅ (untracked files ⚠️) |
| **quickfix size** | diff lines counted separately for code and tests, against `quickfix.max_changed_lines` and `max_files`. Only on the `quickfix` route | ⚠️ never blocks |
| tests | `pnpm test:<project>` per affected package, falling back to `pnpm test:unit` | ✅ |
| lint | `pnpm lint:check` | ✅ |
| typecheck | `pnpm typecheck:<package>` for affected packages, falling back to `pnpm typecheck` | ✅ |
| SPDX | every added file carries the header in the repository's house format — the Apache block with the copyright line, the identifier inside it | ✅ |
| conventional commits | every commit on the branch: a type from the list in `CONTRIBUTING.md`. **Scope is not required by upstream** — its absence is ⚠️, not ❌ | ✅ on type, ⚠️ on scope |
| Signed-off-by | exactly one per commit | ✅ |
| schemas | `pnpm generate:schemas` produces no diff | ✅ |
| extension-api | if `extension-api.d.ts` is touched, the body must carry a backwards-compatibility and disposal section | ✅ |
| **API-surface grep** | every new or changed exported type is grepped in `extension-api.d.ts`; found means it is public API, not an internal utility | ✅ |
| slice standalone | the `pdkit slice verify` result from `slices.json` plus a digest comparison. A stale result is `fail`, not `pass`; a red run against a red baseline is `warn`, marked inconclusive | ✅ for slices with `base: main` |
| branch name | matches `DESKTOP-<n>/[<i>-]<slug>` | ✅ |
| steps-to-check | ≥ 3 steps, each with an expected result. Applies on `quickfix` too | ✅ |
| R-ID coverage | every R-ID closed by a task and named in the body. On a sliced issue, **this slice's** R-IDs, not the whole frozen set. **Skipped on `quickfix`** | ✅ (except quickfix) |
| e2e stability | a new `tests/playwright` test passed `validation.e2e_stability_runs` times in a row; the series is tied to a digest of the spec, and a stale one is `fail` | ✅ if e2e was added |
| e2e environment | a test needing an environment CI does not have requires a `Notes for reviewers` entry | ✅ |
| **validation evidence** | a validation step with no attached artefact is named in `Notes for reviewers`. Skipped on `quickfix` and when `validation.require_evidence: false` | ✅ |
| debug leftovers | `console.log`, `.only`, `.skip`, `@ts-ignore`, `any` in the diff | ⚠️ warn, listing them |
| CI blind spots | the diff touches build, packaging, platform-specific behaviour or the **dependency graph** — CI will not check it; a `Notes for reviewers` entry is required, worded per the area that fired | ✅ |

Three results, and the difference between them matters: **pass** (the check ran
and was satisfied), **skip** (it did not run, and the summary says why), **fail**
(blocking, unless the check is advisory). A skip is never a pass.

**API-surface grep** is a direct codification of the `RunOptions` trap: the type
lives in `packages/main/src/plugin/util/exec.ts` and looks like an internal
utility, but it is also declared in `extension-api.d.ts`, making it public API.
This is not a heuristic for an agent, it is a grep, and it belongs in preflight
rather than in a prompt.

**The dependency-graph area of `ci-blind-spots` is keyed on the lockfile, not on
`package.json`.** The difference is measurable: a manifest edited on its own — a
renamed script, a version field — installs exactly what was installed before, and
demanding a paragraph for it would price the gate where there is no risk. The
lockfile (plus `pnpm-workspace.yaml`, `.npmrc`, `patches/`) is a statement that
the resolved graph changed, and that is precisely what unit tests on one platform
do not exercise: the breakage arrives transitively, a level below the diff.

That check's requirement is worded **by the area that fired**. It used to ask
about the platform whatever the finding was, and a requirement naming the wrong
thing gets answered with the wrong thing — after which the check passes on a note
about nothing. The same defect was fixed in `steps-to-check` and in the config
arrays message: **a message wider than its measurement**.

**validation evidence** is what makes `unverified` different from silence. It
does not require validation to have passed; it requires the unverified to be
**named** to the reviewer. The form is taken from `ci-blind-spots` and the
argument is the same: in both cases something exists that the gate did not check,
and silence about it reads as checked.

Both of those read the PR body, and both must be listed in `BODY_DEPENDENT` —
six checks are: `extension-api`, `steps-to-check`, `r-coverage`,
`ci-blind-spots`, `e2e-environment`, `validation-evidence`. A check that depends
on the body without declaring it stays forever at its first-pass result, `skip` —
the worst possible outcome, because it looks like a check that ran.

**working tree** was not added out of tidiness. The checks in this table read two
different states: file checks (`spdx`, `api-surface`, `debug-leftovers`) look at
the committed diff `base...ref`, while command checks (`tests`, `lint`,
`typecheck`) run whatever is on disk. On a clean tree those are one thing. On a
dirty one the report mixes two and can go green on a diff that will not be
pushed. Not hypothetical: the first full run on the fork produced a red
`test:renderer`, caused by uncommitted work in `packages/preload` that the
renderer tests pick up — while the file checks were reading a commit without it.

**The base is a ref, not a branch name.** `repo.base_branch` names a branch, and
on a fork the local branch of that name is a copy of the base as fresh as the
last pull. First live run: a local `main` 491 commits behind turned a two-file
diff into an 805-file one, and preflight reported four blocking failures about
other people's work — a licence header on a file we never touched, 87 commits
with the wrong sign-off, eight public API symbols. Nothing looked wrong. The base
now resolves to `<upstream_remote>/<base_branch>` when that ref exists, and **the
report prints which ref it read, at what sha and from what date**: a
remote-tracking ref goes stale too, and a measurement has to say what it saw.

**And the ref comes from there too.** Taking the base from the graph was half the
rule: the ref stayed `HEAD`, so the report was about the slice exactly when
preflight was run from the slice's own worktree. From anywhere else every file
check read an unrelated change without a sign, because `HEAD` always resolves. So
the ref is now the slice's branch; if the branch does not exist yet the run
**refuses**, because the flow materialises before preflight and answering about
`HEAD` would answer a question nobody asked. An empty diff under a slice is also
refused: every check passes on nothing, and a green report would open the gate on
a branch with nothing on it.

**The base comes from the graph, not from the config.** Every file check reads
`base...ref`, and for a stacked slice the base is the predecessor's branch. From
`main` the stack's diff contains the previous slice's changes, and `spdx`,
`api-surface`, `debug-leftovers` and `conventional-commits` start reporting on
somebody else's work — confidently, with no sign they are reading the wrong
thing.

**Script names are not hard-coded.** The "How" column above shows a shape, not a
constant: preflight resolves the name from the repository's own `package.json`,
walking a candidate chain and taking the first that exists. The package for
`<project>` / `<package>` comes from `package-map.json`. The reason is direct:
podman-desktop has no `pnpm lint`, and its `pnpm test` drags in the e2e suite, and
upstream renames scripts without notice. A hard-coded name, after a rename,
becomes a check that silently does not run — the worst possible outcome for a
gate. If no candidate is found the check returns **`skip` with an explanation,
not `pass`**. The override is the `preflight:` block in the config, empty by
default: the config is the emergency exit, not the first source.

**conventional commits** is calibrated against the real repository.
podman-desktop's `commitlint.config.cjs` is a bare `config-conventional`, and its
`CONTRIBUTING.md` writes the format as `<type>[optional scope]`; commits without
a scope reach `main` regularly. Requiring a scope as blocking would reject valid
pull requests. We still write scopes — they tell a reviewer which area they are
being asked about — but that is our discipline, not upstream's rule, and it is
never raised in a review of somebody else's PR.

---

## 8. MCP servers: what actually makes a difference

A deliberately short list. Each server is tokens in the context and one more
point of failure.

| Server | Role | Verdict |
|---|---|---|
| **Playwright MCP** | `/pd:validate`: walk scenarios in the running application, capture screenshots as evidence | **Take it.** The only way to close "manual validation" with evidence rather than claims. `pdkit` brings the application up (8.2); the server attaches to its CDP endpoint |
| **GitHub MCP** | issues, PRs, review threads, GraphQL resolve | **Optional.** The default is `gh` through `pdkit`: more deterministic, cheaper in tokens, easy to restrict to reads |
| **context7** (or an equivalent docs MCP) | a question about somebody else's library: API, configuration, what changed between versions | **Take it as optional.** A hint about a library is needed in planning and in reviewing somebody else's PR, and a model's knowledge of library versions goes out of date without saying so |
| **basic-memory** | a personal knowledge layer | **Optional, one-way bridge.** The source of truth is the `knowledge/` files, or the plugin is not portable to anybody else. There is no reverse import — two sources of truth would diverge |
| Chrome DevTools MCP | — | **No.** Covered by Playwright |
| sequential-thinking / memory-graph and similar | — | **No.** Orchestration is set by the skills and by `pdkit`; a separate "thinking" server only spends tokens |

**The plugin ships no `.mcp.json`, and that is the point:** a plugin-level MCP
declaration loads for everyone who enables the plugin, which would make optional
servers mandatory. `/pd:doctor` checks what is present and degrades gracefully —
no Playwright means `/pd:validate` produces a human checklist instead of a run,
and says explicitly that PASS was not recorded.

### 8.1 e2e tests as a first-class output

Since upstream welcomes e2e coverage, `/pd:validate` stops being only "run it and
capture evidence" and gains a second output: **a candidate for
`tests/playwright`**. That changes three things.

1. **`Done when` gets stronger.** A manual checklist is verified once, by one
   person, today; an e2e test is verified by CI on every pull request that
   follows. Where e2e fits, the done-criterion is a test run rather than steps in
   a description.
2. **The plan must decide it in advance.** `templates/plan.md` carries
   `e2e coverage: required | optional | no — <reason>`. The decision is made at
   planning, not afterwards: an e2e invented after implementation usually tests
   what was written rather than what was required.
3. **The e2e test is a slice candidate in its own right.** The `tests` layer is
   already last in merge order. The fork in the road: a test in the same PR as
   the feature proves the feature and simplifies review; a test as a separate PR
   gives a smaller diff but leaves the first PR unproven. **The default is that
   the test travels with the feature**, and it is split out only for bulk
   mechanical changes where one test covers the whole series.

A caution that cannot be dropped: podman-desktop's e2e tests are expensive and
flake-prone, and **a flake carried into somebody else's repository is the worst
thing this workflow can deliver.** Therefore: on the `quickfix` route e2e is not
added by default; a new e2e must pass three runs in a row locally before preflight
can go green; and a test needing an environment CI does not have is recorded in
`Notes for reviewers` rather than hidden.

### 8.2 How Playwright reaches an Electron application

The one question the delivery plan held open as needing a proof of concept, and
it was answered by upstream's own code.
`tests/playwright/src/runner/chrome-dev-tools-protocol-runner.ts` spawns the
podman-desktop binary with `--remote-debugging-port=<port>`, waits for a reply on
`http://127.0.0.1:<port>/json/version`, and connects with
`chromium.connectOverCDP`. The application exposes an ordinary CDP endpoint, and
Playwright MCP knows how to attach to one (`--cdp-endpoint`).

The division of labour follows directly:

- **`pdkit` brings the application up.** `validate launch` resolves the binary
  (`validation.app.binary`, then `PODMAN_DESKTOP_BINARY`, then
  `node_modules/.bin/electron .` after `pnpm build`), spawns it with the port,
  waits for readiness and records the pid and port in `validation.json`.
  Packaging is not required for this and costs noticeably more.
- **The user connects the server.** No `.mcp.json` ships, deliberately, and the
  plugin cannot grant a server to one agent. `/pd:doctor` checks that the server
  is configured **with `--cdp-endpoint` and at the right port**, and says what to
  fix rather than just "Playwright is missing".

**Verified end to end on 2026-08-02, against a live application.** `validate
launch` brought up the development build (`PodmanDesktop/1.30.0-next
Electron/42.3.3`), CDP answered on `/json/version`, `@playwright/mcp` with
`--cdp-endpoint` attached, and `browser_snapshot` returned an 11.9 KB real
accessibility tree — navigation buttons, search.

Two findings came with it. **Pointing the server at nothing is safe:** a server
with a `--cdp-endpoint` leading nowhere starts normally and offers all its tools,
because it connects lazily on the first call. So it can be registered once per
machine rather than per run. And **restarting the application breaks the first
Playwright call** — three times out of three — after which it recovers on its
own; `validate launch` warns about this rather than leaving it to be discovered
mid-scenario.

What remains unmeasured: behaviour under a headless display, and the stability of
a CDP session over a long scenario. One snapshot on a fresh application says
nothing about the twentieth minute. Both are measured by running them, not by
reasoning, and neither blocks: the degradation is already described.

---

## 9. Configuration

Three layers, each overriding the previous per key:

```
defaults/config.yaml        shipped with the plugin
  ↓
$PDKIT_HOME/config.yaml     your settings
  ↓
<repo>/.pdkit.yaml          per-repository
```

**Maps merge key by key; lists are replaced whole, never merged.** A
`layer_order` assembled from two halves is a list nobody wrote, and it decides
the order in which slices merge. The cost is stated rather than hidden: a list
`init` copied and you never edited stays at the value shipped that day, so a
later change to the default never reaches you — silently, because the pinned
value is still perfectly valid. `doctor` reports it as `config:arrays`.

### The YAML subset

`lib/yaml.js` reads nested maps, block and inline sequences, scalars, quotes and
comments. It **refuses** anchors, multiline scalars (`|`, `>`), tags and
multi-document files, naming the line. This is deliberate: a reader that skipped
a construct it did not understand would hand back a config that looks loaded and
is missing a key, and the loss would surface later as a wrong decision somewhere
unrelated. One departure from YAML 1.1: `on` and `off` stay strings, because the
config uses them as enum members next to `auto`.

### What the keys decide

| Key | Effect |
|---|---|
| `repo.upstream` | checked against the git remotes by `init` and `doctor` |
| `repo.fork` | the same, but ships **empty** and is filled by `init` from the `origin` remote — a file that ships to everyone cannot know whose fork you cloned |
| `repo.upstream_remote`, `repo.fork_remote` | which remote names carry them |
| `repo.path` | optional; work on this repository regardless of the working directory |
| `state.root` | where `$PDKIT_HOME` lives, unless the environment says otherwise |
| `branches.single`, `branches.sliced` | branch name templates; `{issue}`, `{index}`, `{slug}` |
| `slicing.layer_order` | merge order for slices, and the layer each package is filed under. A package no entry claims is **reported** rather than filed under the nearest match |
| `slicing.strategy` | `prefer-independent` by default |
| `slicing.max_files_per_slice` | a warning threshold, not a refusal. Size is a conversation |
| `slicing.verify.worktree` | `reuse` keeps one tree per issue so `node_modules` survives; `ephemeral` rebuilds and pays a full install per slice |
| `slicing.verify.install` | `on-lockfile-change` (default), `always`, `never`. The marker recording which lockfile is installed lives **inside** `node_modules`, so wiping one wipes the other |
| `worktrees.root` | beside the fork, never inside it: a checkout under the repository shows up in `git status` and eventually in a pull request |
| `worktrees.copy_files` | copied into every new tree, and again after each verification reset — `git clean` takes them |
| `quickfix.max_changed_lines`, `quickfix.max_files` | thresholds above which a quickfix escalates back to triage |
| `gates.push_ttl` | how fast consent goes stale. **Which states a token may be issued from is not configurable** — see `state.GATE_ELIGIBLE` |
| `validation.e2e` | `prefer`, `required`, `off`. The per-issue decision is made at planning |
| `validation.e2e_stability_runs` | consecutive green runs a new e2e test needs |
| `validation.require_evidence` | when false, `validation-evidence` skips. It exists for a repository where the application cannot be driven at all, not as a way past a step you would rather not demonstrate |
| `validation.app.binary` | a packaged application to drive; empty by default |
| `validation.app.debug_port` | where CDP listens. `validate launch` refuses a port something else already answers on rather than fighting it |
| `validation.app.startup_timeout` | how long to wait for `/json/version` |
| `preflight.scripts.*` | overrides for script-name resolution. **Empty by default**: names resolve from the repository's own `package.json`, and that is the right source. Filling one in is worth doing exactly when the resolver got it wrong — which is a reason to fix the resolver |
| `exec.max_attempts` | how many failed captures block a task; zero switches blocking off |
| `review.bots_collapsed`, `review.bot_escalate` | which accounts collapse, and which words expand one back |

There is **no `routing:` block** and no model selection here at all: a skill's own
model can only be set in its frontmatter, so a config key would control the
subagents and not the skill.

### The package map

`init` generates `package-map.json` from `pnpm-workspace.yaml`, so it cannot
drift from the workspace. `doctor` warns when the map is older than the workspace
file.

---

## 10. Scenario coverage

| Scenario | Route |
|---|---|
| 1. Bug fix | `triage` → `plan` → `plan-review` → `exec` → `validate` → `audit` → `slice` (usually 1) → `preflight` → `pr` |
| 2. One-line fix | `triage` → **`quickfix`** → `preflight` → `pr`. Planning is skipped deliberately |
| 3. New feature | the full path; `slice` will almost certainly produce 2–5 pull requests |
| 4. Improving something that exists | the full path; `plan` must separate the refactor from the new behaviour — they become separate slices |
| 5. Resuming after a break | `sync` → **`resume`** → `pr-sync` → `preflight` → `pr` |
| Reviewing somebody else's PR | `review-pr` — outside the issue lifecycle entirely |

### Scenarios the brief did not name

| # | Scenario | How it is covered |
|---|---|---|
| 6 | **Choosing an issue from the backlog.** Not "I am taking this issue" but "which one" | `/pd:triage` with no number → `pdkit issue list`. Readiness to start is measured mechanically; clarity of the requirement stays with the model, and the choice with the human |
| 7 | **Dependency bump.** A mechanical diff whose real risk is breaking changes in transitive dependencies | **Struck by measurement.** In this repository bumps are dependabot's work: of 200 merged pull requests, 88 are bots (dependabot alone: 84), and of the 112 human ones exactly three concern dependencies — all three within `quickfix` thresholds. A fifth route for 2.7% of human pull requests, each already served, is a key with no work behind it. What remains and fires for anyone: the lockfile is a `ci-blind-spots` area, so a PR that moved dependencies cannot reach review without saying what was checked; `dep-bump` remains a **nature** at triage, because a nature describes the issue rather than the way of doing it |
| 8 | **Bulk mechanical refactor** across independent packages | **No special machinery, and none is being built.** In the same sample the largest human pull request is 32 files and lives inside one layer; so do the mechanical ones. `max_files_per_slice` turns a large set into a conversation rather than a refusal, and proposing a graph by hand was never blocked. Per-package slicing and "equivalence of build output" are struck as mechanisms for a scenario the upstream population does not contain |
| 9 | **CI red, local green.** Upstream's CI is multi-platform; Windows/macOS-only failures are normal | `/pd:pr-status` measures whose the red job is and fetches the failure text for the ones that are ours; a separate `ci-triage` lane distinguishes platform difference / flake / real regression. "Re-run it" is not an answer — it hides the information the lane exists for |
| 10 | **The PR was closed by a maintainer, or the change was reverted.** A redo needs archaeology | the `redo` route. The machine half is `pdkit issue history <n>`; the ordering "archaeology before any implementation" is held by the state machine, not by a prompt |
| 11 | **The issue turned out to be invalid** | the `invalid` route: a draft comment, published by hand |
| 12 | **A change to the public extension API** | not a separate command but a mandatory sub-mode, triggered by the fact that `extension-api.d.ts` was touched. It adds backwards-compatibility and disposal checks, and is always carved into a separate first slice |
| 13 | **Upstream asks for an already-open PR to be split** | `slice suggest --from-pr <n>`: the same slicer, with a published diff as its input; the output is a graph plus a plan for migrating review threads into the new pull requests |
| 14 | **There is an answer, and no diff.** The bug is real and reproducible, and the cause lives outside the repository — in a dependency, in the host, or across a version boundary the product merely triggers | the `answered` state plus `findings.md`: reproduction, detector command, workaround, and the question "what would have kept this from reaching a user". Entry requires a capture: a workaround nobody ran is a suggestion, and a suggestion posted in the voice of a finding costs the reporter their evening. A human publishes it; `gh issue comment` is denied by the hook from every state |
| 15 | **The cycle itself went wrong.** Not the diff and not the review — the triage read the issue as something it is not, or the scouts mapped the wrong package, and everything after inherits it, because everything after reads what came before | `/pd:reset <n>`: one issue forgotten, none of its neighbours touched, and the record **removed rather than transitioned**, so the machine reads `new` and triage is the only exit. Deliberately distinct from the three outcomes it is easy to confuse with — `rework` (a reviewer refused the approach; their objection is the most valuable thing the review produced, and a reset would throw it away), `redo` (it was tried and reverted; the archaeology is the whole point) and `abandoned` (the work was dropped, and why is worth keeping). Nothing upstream moves and the journal keeps everything, so what is forgotten is our reading of the issue, not the issue's history |

Scenario 13 is worth holding in mind when reading the slicer: it must work not
only from the local `HEAD` but from an arbitrary diff. And "work" means in
**every** command the cut passes through, not just the one that draws the draft.
A dry run found the substitution living in `slice suggest` alone, so a proposal
drawn from a published PR was checked by `slice set` against `main...HEAD` and
rejected one file at a time. A flag that redirects the source in one command of a
chain is not half a feature; it is a feature that does not work.

---

## 11. Known weaknesses of this design

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

## 12. Delivery order

Not everything at once. By decreasing return, each stage independently useful.

| Stage | What | Gives | Readiness signal |
|---|---|---|---|
| **0** | the `pdkit` skeleton: `state`, `ids`, `init`, `doctor`; the `plan.md`, `receipt.md`, `pr-body.md` templates; `knowledge/upstream-rules.md` | the frame everything else hangs on | `pdkit doctor` green on a real fork |
| **1** | the single-PR backbone: `sync`, `triage`, `plan`, `exec`, `preflight`, `pr` (gate + hooks), `quickfix` | scenarios 1 and 2 end to end | one real bug fix carried to an open upstream pull request |
| **2** | quality: `plan-review`, `audit`, the `Write`/`Edit` hook on `Owns`, receipts as a hard gate | drift from the plan stops reaching a pull request | the auditor caught a divergence the implementer did not notice |
| **3** | **slicing**: `slice`, standalone verification, worktrees, `slice cascade` | the key feature: one change set → N atomic PRs | one change set cut into 3 PRs, each standalone green |
| **4** | the PR lifecycle: `pr-status`, `pr-sync`, `resume`, `close`, `--from-pr` | scenarios 5 and 13; pull requests stop rotting | a stale PR carried to re-review without unpicking threads by hand |
| **5** | `validate` + Playwright + e2e generation, `review-pr`, `knowledge` | evidence instead of claims; e2e as a useful by-product; reviews of other people's PRs | an e2e test written by the plugin survived three runs and travelled upstream with the feature |

**Stage 3 cannot precede stage 1.** Slicing without a working single-PR backbone
is not verifiable: there is nothing to verify it on.

One fork in the road had to be settled before any code: **skills or commands.**
The direction of the ecosystem is skills, and the answer was `skills/` only —
orchestrating ones with `disable-model-invocation: true`, knowledge ones
phrase-triggered. Shipping `commands/` as well would be two sources of truth for
one behaviour.

---

## 13. Status: what has been verified, and what has not

The section exists so that "the plugin is tested" is not read more widely than it
is — the same discipline as `What I could not verify` in a review report. It has
one rule, learned the hard way after it fell three versions behind: **a row is
removed by the same thing that puts one there — a journal entry, or an artefact
you can point at.**

### Verified against live upstream, with its evidence

| What | Evidence |
|---|---|
| **The `quickfix` route end to end**, from "I'll take it" to a published pull request ([#18561](https://github.com/podman-desktop/podman-desktop/pull/18561)) | journal 17:11–17:52 on 2026-08-01: `triaged` → `worktree-create` → `quickfix` → `preflight-green` → `gate-open`/`gate-spent` → `pr-registered` → `pr-open`, then a reply token to edit the body |
| **The `standard` route end to end**, to pull request [#18562](https://github.com/podman-desktop/podman-desktop/pull/18562) | issue 17221, journal 18:42–21:39: `adopted` → `rework` → `planned` → `requirements-frozen` (R1–R4) → `plan-approved` → two tasks with `task-start`/`task-receipt`/`task-stop` (and one `task-attempt` with a non-zero exit) → `implemented` → `validated` → `audited` → `slices-set` → `slice-verified` → `slices-approved` → `slice-materialized` → `preflight-green` → gate → PR |
| **`validate` with Playwright and a codified test** | `validation.json` for 17221: the spec `experimental-feature-feedback.spec.ts`, its digest, **four green runs in a row**; separately `app-launched` with a CDP endpoint and an accessibility-tree snapshot |
| **Replacing a PR through `rework`** | #17577 closed as superseded by #18562, with the issue itself left unfinished |
| **`review-pr` on other people's pull requests** | `reviews/18464.md` (`REQUEST_CHANGES`) and `reviews/18556.md` (`APPROVE_WITH_NITS`), both with a confidence line and a filled `What I could not verify` |
| **The gate as a hook, not as a function** | a `denied` journal entry on 2026-08-02 for `git push --dry-run`: the refusal came from a handler the host launched, not from a test |
| **Scenarios 12 and 13 and the machine half of `redo`**, by dry run against other people's upstream PRs | `slice suggest --from-pr 18434` → a five-slice graph by layer with a `merge-base` base; both public-API refusals fired on a real `extension-api.d.ts` diff; `issue history 17873` produced the correct pair #17976 ↔ #18323 and reviewer quotes from the real attempt |
| **The plugin loads as a plugin, and a skill is invocable as `/pd:*`** | 2026-08-10: `claude --plugin-dir . -p "/pd:doctor"` against the fork returned the full doctor report, so the manifest loads, the skill body runs, and `bin/` reaches the Bash tool's `PATH` — `pdkit` resolved as a bare command. `claude plugin validate . --strict` passes |
| **`close --finish`, the invariant-4 rollup, and the transition to `merged`** | 18248, 2026-08-12: `pr refresh` observed a merge made in the browser and journalled `pr-merged #18561 observed by refresh` once; `close --finish` then read the rollup (1 merged, 0 open, 0 closed) and wrote `event:merged 1 pull request(s) merged`, with `pr-open -> merged` in the state history. Worktree removal refused in the same run, correctly: the branch had merged upstream but not into the local base |
| **Flake detection** | 2026-08-13 on [#18779](https://github.com/podman-desktop/podman-desktop/pull/18779): three jobs went red on an Electron install failure, two re-runs turned them green, and `pdkit pr ci` reports `flake` on five — the three plus two whose red run nobody had noticed. It had never fired before because it could not: three separate defects sat between it and its data (below) |
| **Skills run as `/pd:*`, and agents dispatched by name** | 18832, 2026-08-18: `/pd:doctor`, `/pd:sync`, `/pd:plan` and `/pd:plan-review` all ran through a session, from the plugin as enabled in `settings.json` rather than from `--plugin-dir`. `/pd:plan` dispatched four `pd:pd-scout` agents on different questions and `/pd:plan-review` dispatched `pd:pd-plan-critic`; `research.md`, `plan.md`, seventeen task files and `plan-review.md` are what they produced |
| **The adversarial gate changing an outcome, twice** | 18832 on 2026-08-18 and again on 2026-08-19: both times `plan check` was green and `pd-plan-critic` returned three must-change findings anyway, and both times the issue went back through `triaged` to be replanned. Six blockers in total, no two the same, and none of them of a kind `plan check` looks for — a task made unimplementable by the plugin's own `Owns` exclusivity rule (found twice, under two different architectural answers), a fix that reintroduced the bug it was fixing one layer up, a step rewriting a test that already existed. The second run also showed the synthesis half working against its own agent: the critic proposed extracting a shared abstraction for a third future consumer, and the host checked, found the third consumer does not use the field at all, and dropped the finding |
| **The gate under deliberately widened permissions** | 2026-08-18: a session started with `--allowedTools Bash` was refused `git push --dry-run origin main` by the `pre-bash` handler the host launched, journalled as `event:denied`. Granting a tool does not disable the hook — which is the question that had to be answered before any run was given write access |
| **A deferral raised and retracted outside review** | 18832: `defer new` recorded a postponement decided at *planning* time, with no `--pr` to hang it on, and `defer drop` retracted it with a reason once `plan-review` disproved the argument it rested on. Both are journal entries; the machinery is not specific to a review thread |

### Never executed, in order of risk

| What | Why it is not a detail |
|---|---|
| **The plugin as installed from a catalogue over the network.** It now loads from a marketplace entry in `settings.json` — but that entry's source is a local directory | Half the row closed on 18832: the manifest is found through `extraKnownMarketplaces` plus `enabledPlugins`, not only through `--plugin-dir`, and skills and agents resolve from it. What is still untested is the fetch: a marketplace pulled from a remote repository, which is the path every other user takes |
| **Eighteen of the twenty-two skills.** `doctor`, `sync`, `plan` and `plan-review` have been invoked through a session | Each skill body is prose, and prose is the half of this plugin that is not covered by anything. A skill that names a flag `pdkit` no longer has fails at the moment somebody is depending on it |
| **Four of the six hook events.** `pre-bash` has two genuine firings in the journal, and `pre-write` is exercised by `owns:selftest` through the manifest | The self-test spawns the handler the way the host does, which proves the handler works and not that the host calls it. `post-write`, `task-completed`, `session-start` and `pre-compact` have never been triggered by the host. On 18832 a session *did* write plan and task files through the host's `Write` tool, so `post-write` was almost certainly called — and left no trace either way, because a handler that passes silently is indistinguishable from one that was never wired up. That is the same shape as the flake verdict below, and it is why this row needs an artefact rather than an absence of complaints |
| **Cutting into N slices, stacking, and `cascade`.** The only live graph was `1 slice(s)`; there is no `slice-cascade` event in the journal | The key feature of stage 3 and the densest machinery in the plugin. Untested: a stacked base taken from the graph, rebasing dependents, the loss of standalone, preflight from a predecessor's branch |
| **`pr-sync` as a whole**, and specifically `replyToThread` with both GraphQL mutations | The reply token is verified further than it was — issued from `pr-open` for `gh pr edit`, and from `merged` for `gh pr comment` on #18561 — so what is left is narrower and harder: the mutations need somebody else's *thread*, and synthetic material there is self-confirmation, since the same person would be writing both the threads and the filter that reads them |
| **The `redo` route carried through to code** | The facts of a previous attempt are now collected correctly and `archaeology.json` is written by a real query, but no redo has reached a diff: that is a separate issue, not a separate task |
| **Scenarios 12 and 13 on our own work** | Run against somebody else's diff, and that is the boundary: `--from-pr` is verified from fetch to graph, while materialising a foreign PR hit the repository's own pre-commit hook on an old checkout. Branches from a foreign diff, and thread migration into new pull requests, remain unexecuted |
| **`resume` with a real conflict** | 17221 was handled through `rework` rather than a rebase, and the drift measurement on its branch shows zero: in four days upstream touched none of its files. So `pd-conflict-analyst` never ran, no semantic conflict occurred, and there is still nothing to journal — not for want of trying, but for want of material |

None of these blocks the work: each closes with the next issue of the right kind
rather than with a dedicated task.

### A verdict that could not be reached, in three layers

Flake detection sat in the "never executed" table from the first version, and the
reason was assumed to be a shortage of flakes. It was not. Between the check and
its data were three defects, each of which alone was enough to silence it, and
each found only by watching the real thing fail to happen on #18779.

1. **The data was never requested.** `checkRunsForCommit` read a commit's check
   runs without `filter=all`, and that endpoint defaults to `filter=latest` — one
   run per check name. After a re-run the failure is simply absent. Measured on
   one commit: `latest` returns 1 run for `k8s sanity e2e tests`, `all` returns 3.
2. **The data was requested only when it could not help.** `refresh` fetched the
   per-commit runs only when some check was *currently* red — that is, it asked
   "did this job answer twice" exactly when the answer had to be no, because the
   ordinary flake is red, re-run, green, and nothing is red by the time anyone
   looks.
3. **The verdict was unreachable even with the data.** `judge` returned `pass` on
   a green conclusion before it ever compared the runs, so the only flake it
   could have reported was one still red — while the comment beside it named the
   opposite case, "a re-run that went green is exactly what hides this".

The test that should have caught the first was present and named for it, and it
stubbed the response: it proved the parser kept two runs, never that the request
asked for them. That is the second time here a test proved its own fixture rather
than the behaviour it was named for.

The general shape is worth keeping, because it has now cost three findings in one
day: **a check that never fires is not evidence that the condition never occurs.**
Silence is the one result that looks identical whether the mechanism works or was
never wired up, which is why section 13 requires an artefact to *remove* a row and
not merely the absence of complaints.

### Measurements that settled a question by refusing to buy something

Two open items were closed by measuring them, and both measurements ended in
buying nothing.

- **The honest form of `Patch comes off`** costs 152 s per slice on a warm tree
  (`test:unit` 85 s, `typecheck` 36 s, `test:main` 24 s, `lint:check` 3 s,
  `typecheck:main` 3 s) — that is, +100% per slice, or +26% narrowed to
  typecheck. Affordable, and still the wrong purchase, for the reason in
  section 11 item 8. What the measurement produced instead was the rename: the
  caveat had been living in an HTML comment while a green tick rendered under a
  header reading `Reverts cleanly`. A comment is not visible in what a person
  reads, and the tick claimed more than the check did.
- **The GraphQL cost of the dashboard** is 32 points out of an hourly 5000 for a
  ten-PR sweep, and 37 seconds. Seconds are the constraint, not the budget, so no
  cache was introduced — and the answer the item had proposed for the day the
  limit was hit turned out to be wrong on its own terms, since CI completion does
  not move `updatedAt`. What the measurement produced instead was the finding
  that the dashboard never said **when** it had read a row.

### Calibration of the guessed thresholds

Four numbers in the config were common sense. `pdkit stats` measures the
population they are about: upstream's median merged pull request is 2 files and
34 lines, p90 is 10 files, and time to merge is p90 two days. The `quickfix`
thresholds therefore cover not a rare case but the majority — 71% of merged pull
requests touch ≤ 3 files and 40% fit in 20 lines. A fourteen-day stale window
looks generous against that population (20 of 78 open pull requests are past it),
**but the sample is sorted by creation date and is never wider than eleven days**,
so it under-counts precisely the slow tail the threshold is about. What to do
with the numbers stays with the owner: the command recommends nothing and writes
nothing.
