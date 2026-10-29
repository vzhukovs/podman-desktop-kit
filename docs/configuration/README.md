# Configuration

How the plugin is configured: the three config layers, where its state lives,
what every key decides, and the settings that live outside `config.yaml`
because a config key could not hold them — models, MCP servers, other tools'
hooks. Why the keys are drawn where they are is in
[section 9 of `specification/`](../specification/09-configuration.md).

Each part is a file of its own and can be opened directly. Every part ends with
links into the specification for the reasoning and, where one exists, into
[`workflows/`](../workflows/README.md) for the commands.

## Contents

| # | Part | What it answers |
|---|---|---|
| 1 | [Layers](01-layers.md) | the three files and which wins, why lists are replaced whole, `.pdkit.yaml` in `.git/info/exclude`, the YAML subset |
| 2 | [`$PDKIT_HOME`](02-pdkit-home.md) | what it holds and how its location is resolved; creating it with `pdkit init`; one clone with two remotes; how `repo.fork` is filled |
| 3 | [What each key does](03-keys.md) | every key, grouped: repository, slicing, worktrees, triage and the gate, validation, preflight, review |
| 4 | [The package map](04-package-map.md) | where `package-map.json` comes from, and when to regenerate it |
| 5 | [Model selection](05-models.md) | why models are not in `config.yaml`, which phases run on opus, the fork's default model, the effort level |
| 6 | [MCP servers](06-mcp-servers.md) | which servers make a difference and what is lost without them; the one Playwright command to run by hand |
| 7 | [Hooks other tools install](07-hooks-from-other-tools.md) | why a global `Bash` hook cannot get past the gate, and why receipts are unaffected |
| 8 | [Retired keys](08-retired-keys.md) | what `config:gates` reports, and what to do about it |

## Reading order

For a first setup: [part 2](02-pdkit-home.md) to create `$PDKIT_HOME`, then
[part 6](06-mcp-servers.md) for the one Playwright command, then
[part 5](05-models.md) for the two settings outside this repository that decide
most of what a phase costs. [Part 3](03-keys.md) is a reference to open when a
key comes up.

## Where to look

| If you want to… | Read |
|---|---|
| know which file wins when a key is set twice | [1 · Layers](01-layers.md) |
| know why a default the plugin changed never reached you | [1 · Layers](01-layers.md), [2 · `$PDKIT_HOME`](02-pdkit-home.md#creating-it) |
| set up a new machine | [2 · Creating it](02-pdkit-home.md#creating-it), [6 · Playwright](06-mcp-servers.md#playwright-the-one-command-to-run-by-hand) |
| move `$PDKIT_HOME` | [2 · `$PDKIT_HOME`](02-pdkit-home.md) |
| point `pdkit editor` at your IDE | [3 · Worktrees and the editor](03-keys.md#worktrees-and-the-editor) |
| fix every slice coming back inconclusive | [3 · `slicing.verify.prepare`](03-keys.md#branches-and-slicing) |
| drive a packaged application rather than the development build | [3 · Validation](03-keys.md#validation) |
| change the quickfix thresholds or the attempt ceiling | [3 · Triage, quickfix and the gate](03-keys.md#triage-quickfix-and-the-gate), [3 · Preflight and execution](03-keys.md#preflight-and-execution) |
| know which model to run a phase on | [5 · Model selection](05-models.md), [workflows · Which session, which model](../workflows/reference/sessions.md#which-session-which-model) |
| make `/pd:validate` record evidence | [6 · MCP servers](06-mcp-servers.md) |
| know what `doctor` means by `config:arrays`, `config:gates`, `settings:model`, `validate:app` | [1](01-layers.md), [8](08-retired-keys.md), [5](05-models.md), [6](06-mcp-servers.md) |

## Other documents

| Document | What it answers |
|---|---|
| [`specification/`](../specification/README.md) | the design: what each piece guarantees, and why the guarantees stop where they do |
| [`architecture/`](../architecture/README.md) | the same design in five minutes, one part per file |
| [`workflows/`](../workflows/README.md) | every use case, with the commands and the decision points |
