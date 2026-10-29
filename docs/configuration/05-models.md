# Model selection

[Configuration](README.md) › 5 of 8

Not in `config.yaml`. Models are set by `model:` in `skills/*/SKILL.md` and
`agents/*.md`.

This is deliberate: a skill's own model can only be set in its frontmatter, so a
config key would control the subagents and not the skill — a lever that half
works is worse than no lever. Opus is kept where no machine re-checks the
verdict: `triage`, `plan`, `plan-review`, `pr-sync` and the agents
`pd-auditor`, `pd-plan-critic`, `pd-review-synth`. The rest is Sonnet.
`pr-sync` came back to Opus in 0.9.0: a machine checks that a review fix
compiles and passes, not which of a reviewer's alternatives to take, nor
whether a reply answers what was asked. Its resolvers stay on Sonnet — they
carry out a decision the person has already approved.

A skill's `model:` and `effort:` hold only until the end of the turn it was
invoked in (see CONTRIBUTING.md). After the first reply from you or from a
background agent, the session's own model and effort level take over. Two
settings outside this repository therefore decide most of what a phase costs,
and they are yours to change, not the plugin's:

- **The model.** Start each phase in its own session (`pdkit next <n>` prints
  the command) and pick the model there: `/model opus` before `triage`, `plan`,
  `plan-review` and `pr-sync`; `/model sonnet` before the rest. When you
  forget, the prompt hook says so on the `/pd:` command, in a line shown to
  you: it reads the model from the session's transcript, and after `/clear`
  from the previous transcript of the same `claude` process. It cannot switch
  the model — nothing outside the session can.

  `pdkit init` also writes `"model"` into the fork's
  `.claude/settings.local.json`, so a fresh `claude` there starts on the model
  most orchestrating skills declare (today `sonnet`) instead of your global one.
  The value is counted from the skills' `model:` frontmatter, not set by the
  plugin, and project settings win over `~/.claude/settings.json`. Only the
  local file is written: `.claude/settings.json` belongs to podman-desktop and
  is tracked by git. Existing keys are kept; a `model` already there is left
  alone unless you pass `--force`. `pdkit doctor` warns (`settings:model`) when
  the written value no longer matches the frontmatter — a skill moved to
  another model after init ran — or when there is none.
- **The effort level.** A global `"effortLevel": "xhigh"` in
  `~/.claude/settings.json` applies to every turn the skill's own `effort:` no
  longer covers — including `pdkit state <n>` and the other mechanical turns of
  `exec`, `preflight`, `slice` and `pr`. Reasoning tokens are paid as
  output, and output is the dearest token there is. Recommended: leave
  `effortLevel` unset or at `medium`, and raise it with `/effort high` in the
  sessions for `triage`, `plan`, `plan-review` and `pr-sync`. `pdkit init` does not write
  `effortLevel` into the fork's settings: nothing confirms Claude Code reads it
  at project level, and an unknown key is accepted without a word. Set the
  level per session with `/effort`, or `claude --effort` at launch.
  `CLAUDE_CODE_EFFORT_LEVEL` overrides even the skill's `effort:`, so do not set
  it globally either.

---

**The design** — [5 · Agents and model routing](../specification/05-agents.md), [workflows · Which session, which model](../workflows/reference/sessions.md#which-session-which-model)

← [The package map](04-package-map.md) · [Contents](README.md) · [MCP servers](06-mcp-servers.md) →
