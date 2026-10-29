# 5. Agents and model routing

[Specification](README.md) › Section 5

| Agent | Model | Tools | Role |
|---|---|---|---|
| `pd-scout` | sonnet | Read, Grep, Glob, Bash (ro) | reconnaissance, ≤ 40 lines, every claim `file:line`, proposes nothing |
| `pd-implementer` | sonnet | everything except push/gh | one task, only files from `Owns`, a receipt with real output |
| `pd-auditor` | opus | Read, Grep, Glob, Bash (ro) | diff against plan, fresh context |
| `pd-plan-critic` | opus | Read, Grep, Glob | adversarial review of the **plan**, before code |
| `pd-slicer` | sonnet | Read, Grep, Bash | the slice graph, from the finished diff |
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

**A skill's `model:` holds for its first turn; the session's model runs the
rest of the phase, and it survives `/clear`.** So the frontmatter routes the
phase only if the person types `/model` at the start of the session — which
is why `pdkit next` prints the `/model` line before the command, and why the
`UserPromptSubmit` hook says so when the session is on the wrong one. `effort:`
sits beside `model:` in the same frontmatter: `high` for `triage`, `plan`,
`plan-review`, `audit` and `pr-sync`, `low` for `editor` and `open`, `medium`
for the rest. Nothing reminds about it; `/effort` is typed per session. The
model and effort to type before each phase are in
[`workflows/reference/sessions.md`](../workflows/reference/sessions.md#which-session-which-model).

**Honestly about token economics.** "Opus plans, Sonnet implements" saves less
than it appears: to plan well, Opus has to understand the code, which causes a
double investigation — first the scouts, then itself. The real saving comes from
three other things: the scouts compressing the map (Opus reads 40 lines instead
of 4000), fresh context per task (no accumulation of failed attempts), and
receipts instead of diffs at acceptance. The model split is a consequence, not a
cause. On a tight budget, keep Opus on `plan` and on `pd-auditor`, and run
everything else on Sonnet.

---

**In brief** — [`architecture/`](../architecture/README.md): [2 · The pieces](../architecture/02-pieces.md)

← [`/pd:knowledge`](04-contracts/knowledge.md) · [Contents](README.md) · [6 · Hooks](06-hooks.md) →
