# Configuration

## Layers

```
defaults/config.yaml        shipped with the plugin
  ↓ overridden by
$PDKIT_HOME/config.yaml     your settings
  ↓ overridden by
<repo>/.pdkit.yaml          per-repository
```

Put `.pdkit.yaml` in `.git/info/exclude`, **not** `.gitignore`. The fork's
`.gitignore` is upstream's file; editing it puts a stray line in every pull
request you open.

## `$PDKIT_HOME`

Defaults to `~/.pdkit/podman-desktop`. Holds config, the package map, gate
tokens, per-issue state and artefacts, the journal, and review reports.

Keeping it in its own private git repository is worthwhile — `pdkit` commits
after each state transition, so losing the directory loses the reasoning behind
every decision. It must be a **separate** repository, never the fork.

## Model selection

Not in this file. Models are set by `model:` in `skills/*/SKILL.md` and
`agents/*.md`.

This is deliberate: a skill's own model can only be set in its frontmatter, so a
config key would control the subagents and not the skill — a lever that half
works is worse than no lever. To cut cost, edit the frontmatter of `plan`,
`slice` and `audit`, and leave the rest on Sonnet.

## MCP servers

The plugin ships **no** `.mcp.json`, and that is the point: a plugin-level MCP
declaration loads for everyone who enables the plugin, which would make optional
servers mandatory. Configure them yourself.

| Server | Used by | Absent |
|---|---|---|
| Playwright | `/pd:validate` | a human checklist instead of evidence, and no PASS is recorded |
| context7 | dependency bumps | changelog lookups fall back to grep |
| ponytail | `pd-plan-critic`, `pd-review-architecture` | the checklist in `knowledge/review-expectations.md` |

Which agents can see a server's tools is controlled by `tools:` in
`agents/*.md`, since plugin agents cannot declare MCP servers themselves.

**Do not install ponytail as a `SessionStart` hook.** A hook reaches every
agent and bypasses `tools:` scoping entirely, including `pd-implementer`, which
must follow the plan literally rather than minimize it. `/pd:doctor` warns when
it finds such a hook.

## rtk

If you use rtk, order matters: **set up the gate first, then enable rtk.** rtk
rewrites commands before execution, and the gate decides from the parsed
command. `lib/hooks/command-parse.js` canonicalizes wrapped forms, and
`test/command-parse.test.js` covers them — but verify with
`/pd:doctor --gate-selftest` before trusting the combination.

Keep `tools.rtk.readonly_only: true`. Commands whose output becomes a receipt
run with rtk disabled: a compressed test log is a claim, not evidence, and
receipts exist precisely to be more than claims.
