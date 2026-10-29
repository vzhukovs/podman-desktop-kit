# 3. Commands

[Specification](README.md) › Section 3

Every orchestrating skill is `disable-model-invocation: true`. Nothing starts on
its own.

| Command | In | Out | State | Model | Gate |
|---|---|---|---|---|---|
| `/pd:doctor` | — | environment report | — | sonnet | — |
| `/pd:sync` | — | fork and worktree status | — | sonnet | — |
| `/pd:editor [<issue>]` | issue, or the current branch's | the issue's worktree opened in `editor.path` | — | haiku | — |
| `/pd:open home\|issue\|tree [<issue>]` | target, issue | `$PDKIT_HOME`, `issues/<n>` or the worktree opened in the file manager | — | haiku | — |
| `/pd:triage [<issue>]` | number/URL on the first line, any further lines as prior context; or nothing | with a number: `issue.md` including what came with the command, draft R-set, route. Without: a backlog shortlist, and nothing is written | `triaged` / — | opus | — |
| `/pd:plan <issue>` | issue | `research.md`, `plan.md`, open questions | `planned` | opus + sonnet scouts | human: approval |
| `/pd:plan-review <issue>` | issue | `plan-review.md` | — | opus, fresh | — |
| `/pd:exec <issue> [T*]` | issue/task | code, commits, `receipts/*` | `implemented` | sonnet workers | — |
| `/pd:validate <issue>` | issue | `validation.md` + artefacts | `validated` | sonnet | — |
| `/pd:audit <issue>` | issue | `audit.md` | `audited` | opus, fresh | — |
| `/pd:slice <issue>` | issue | `slices.md` — the PR graph | `sliced` | opus, fresh | human: approval |
| `/pd:preflight <issue\|slice>` | issue/slice | pass/fail + output | `preflight-green` | sonnet | — |
| `/pd:pr <issue> [slice]` | issue | branches, PR bodies, open PRs | `pr-open` | opus | **push gate** |
| `/pd:pr-status` | — | dashboard across open PRs | — | sonnet | — |
| `/pd:pr-sync <pr#>` | PR | decision table → plan amendment → fixes → `pr diff` → replies | — | opus + sonnet resolvers | human: the decisions, the amendment; **push gate** after the diff; replies |
| `/pd:resume <issue>` | issue | drift analysis, rebase, amendment | — | opus | — |
| `/pd:review-pr <pr#>` | PR | `reviews/<pr>.md` | — | opus + 4 sonnet axes | — |
| `/pd:quickfix <issue>` | issue | fix + PR | `pr-open` | sonnet | **push gate** |
| `/pd:close <issue>` | issue | knowledge harvest, worktree cleanup | `merged` | sonnet | — |
| `/pd:reset <issue>` | issue | what would go and what would stay; with `--confirm`, one issue forgotten | record removed, so `new` | sonnet | human: `--confirm` |
| `/pd:knowledge` | — | revision of `knowledge/` | — | opus | — |

## Phrase-triggered skills

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

← [2 · Plugin structure](02-plugin-structure.md) · [Contents](README.md) · [4 · Contracts of the key commands](04-contracts/README.md) →
