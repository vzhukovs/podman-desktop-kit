/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

// Argument parsing, command dispatch, and exit codes for pdkit.
//
// Every command returns an exit code. Nothing here calls process.exit()
// directly: bin/pdkit sets process.exitCode so pending stdout flushes first.

import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { AMENDMENT_STATUSES, parsePlan } from './artefacts.js';
import * as cost from './cost.js';
import * as blocks from './blocks.js';
import { get, load, paths, resolveHome } from './config.js';
import * as evidence from './evidence.js';
import * as gate from './gate.js';
import * as gh from './gh.js';
import { FAIL_CLOSED, HOOK_HANDLERS } from './hooks/events.js';
import * as knowledge from './knowledge.js';
import * as pr from './pr.js';
import * as preflightRecord from './preflight/record.js';
import * as render from './render.js';
import { currentBranch, pickScript, revision, scripts as repoScripts } from './repo.js';
import { reveal } from './reveal.js';
import * as review from './review.js';
import * as state from './state.js';
import * as stats from './stats.js';
import * as threads from './threads.js';
import * as validation from './validation.js';
import {
  EXIT,
  FAILURE_TAIL_LINES,
  LIB_DIR,
  PLUGIN_ROOT,
  counted,
  describeRun,
  issueFlag,
  openPullRequest,
  printJson,
  pullRequestBase,
  readVersion,
  repoContext,
  requireIssueTree,
} from './commands/support.js';
import * as amendmentCommand from './commands/amendment.js';
import * as auditCommand from './commands/audit.js';
import * as branchCommand from './commands/branch.js';
import * as checkpointCommand from './commands/checkpoint.js';
import * as closeCommand from './commands/close.js';
import * as costCommand from './commands/cost.js';
import * as deferCommand from './commands/defer.js';
import * as doctorCommand from './commands/doctor.js';
import * as driftCommand from './commands/drift.js';
import * as editorCommand from './commands/editor.js';
import * as findingsCommand from './commands/findings.js';
import * as idsCommand from './commands/ids.js';
import * as initCommand from './commands/init.js';
import * as issueCommand from './commands/issue.js';
import * as journalCommand from './commands/journal.js';
import * as knowledgeCommand from './commands/knowledge.js';
import * as nextCommand from './commands/next.js';
import * as openCommand from './commands/open.js';
import * as packagesCommand from './commands/packages.js';
import * as planCommand from './commands/plan.js';
import * as preflightCommand from './commands/preflight.js';
import * as receiptCommand from './commands/receipt.js';
import * as renderCommand from './commands/render.js';
import * as resetCommand from './commands/reset.js';
import * as rollbackCommand from './commands/rollback.js';
import * as sliceCommand from './commands/slice.js';
import * as stateCommand from './commands/state.js';
import * as statsCommand from './commands/stats.js';
import * as taskCommand from './commands/task.js';
import * as worktreeCommand from './commands/worktree.js';

const run = promisify(execFile);

// Defined with the helpers every command shares; still exported from here,
// where bin/pdkit and the tests read it.
export { EXIT } from './commands/support.js';
// Moved with `pdkit init`, which is the only command that calls it; exported
// from here for the tests that read it.
export { adoptFork } from './commands/init.js';
// Moved with the handlers that use them; exported from here for the tests that
// read them.
export { FAILURE_TAIL_LINES, describeRun } from './commands/support.js';
export { commentsToShow } from './commands/issue.js';

/**
 * Every command, what it reads, and what runs it.
 *
 * One row per command, and the only place one is registered: COMMANDS and
 * COMMAND_FLAGS below are read off it, and `main` dispatches through it. Four
 * hand-kept lists in one file used to agree only because a test read the source
 * to check they did.
 *
 * Insertion order is COMMANDS order. A row without `flags` is exempt from the
 * unknown-flag check — `hook` alone, for the reason on `unknownFlags`.
 *
 * @type {Record<string, {flags?: string[], run: (args: string[], flags: Record<string, any>) => Promise<number>}>}
 */
export const REGISTRY = {
  init: initCommand,
  doctor: doctorCommand,
  state: stateCommand,
  next: nextCommand,
  ids: idsCommand,
  journal: journalCommand,
  packages: packagesCommand,
  issue: issueCommand,
  branch: branchCommand,
  render: renderCommand,
  task: taskCommand,
  receipt: receiptCommand,
  plan: planCommand,
  audit: auditCommand,
  validate: {
    flags: ['issue', 'build', 'port', 'title', 'run', 'evidence', 'expected', 'observed', 'requirement', 'spec', 'by', 'reason'],
    run: runValidate,
  },
  e2e: { flags: ['issue', 'runs'], run: runE2e },
  review: { flags: ['pr', 'values', 'reveal'], run: runReview },
  knowledge: knowledgeCommand,
  preflight: preflightCommand,
  slice: sliceCommand,
  worktree: worktreeCommand,
  editor: editorCommand,
  open: openCommand,
  gate: { flags: ['issue', 'branch', 'pr', 'kind', 'ttl'], run: runGate },
  pr: {
    flags: ['issue', 'slice', 'branch', 'base', 'title', 'body', 'values', 'thread', 'resolve', 'reason', 'superseded-by', 'by', 'confirm', 'no-logs', 'pr', 'stat'],
    run: runPr,
  },
  // Nothing that skips, forces or extends: see runPublish.
  publish: { flags: ['issue', 'branch', 'title', 'body', 'slice', 'base', 'pr'], run: runPublish },
  drift: driftCommand,
  amendment: amendmentCommand,
  defer: deferCommand,
  findings: findingsCommand,
  close: closeCommand,
  reset: resetCommand,
  checkpoint: checkpointCommand,
  rollback: rollbackCommand,
  stats: statsCommand,
  cost: costCommand,
  hook: {
    run: (args) => {
      if (!args[0]) {
        process.stderr.write('pdkit: hook requires an event name\n');
        return EXIT.ERROR;
      }
      return runHook(args[0]);
    },
  },
  // Answered before the dispatcher, since --version has to work without a
  // command at all; the row is how `main` gets there.
  version: {
    flags: [],
    run: async () => {
      process.stdout.write(`${await versionLine()}\n`);
      return EXIT.OK;
    },
  },
};

/**
 * Every command the dispatcher accepts.
 *
 * Exported because skills tell the model to run these, and a skill naming a
 * command that does not exist fails at the worst moment — mid-flow, with the
 * model improvising a substitute. test/invariants.test.js checks the skills
 * against this list.
 */
export const COMMANDS = Object.keys(REGISTRY);

const USAGE = `pdkit — deterministic helper for the Podman Desktop Kit plugin

Usage:
  pdkit <command> [options]

Commands:
  init                          create $PDKIT_HOME and generate the package map
  doctor [--gate-selftest]      check the environment; --gate-selftest drives
                                every forbidden command through the real hook
  state <issue>                 show the state record
  state <issue> --to <state> [--route <r>]
                                move the issue, if the machine allows it; --route
                                records what triage decided (standard, quickfix,
                                multi-slice, redo)
  next <issue>                  one line: what to run next for this issue. For
                                the start of a fresh session, which is where
                                each phase now begins
  ids requirement|task|slice <issue>
                                ALLOCATE the next ID and spend it — not a
                                lookup. To see an issue's requirements run
                                \`state <issue>\`; its tasks, \`audit <issue>\`
  ids freeze <issue>            freeze the requirement set
  ids branch --issue <n> --slug <s> [--index <i>]
  journal [--issue <n>] [--since <when>] [--event <name>]
                                --since takes a date (2026-08-02) or an age
                                (90m, 2h, 7d, 3w); anything else is refused.
                                --event denied shows what the gate refused
  journal conflict --issue <n> --kind mechanical|semantic --file <p>
                   --resolution <why> [--commit <sha>] [--slice <i>] [--amendment A<k>]
                                record a conflict a rebase produced. The one
                                entry a person writes: nothing can observe what
                                upstream rewrote under a plan, and the two event
                                names are the only ones this command will write
  packages [--of <path>]        the package map, or the package owning a path
  issue list [--label a,b] [--limit <n>]
                                open issues with the facts that say whether one
                                can be started: linked pull requests, assignee,
                                whether a maintainer answered, whether a bug
                                carries a reproduction. An order, not a pick
  issue fetch <n> [--full]      read the upstream issue: the body whole, the newest
                                triage.fetch_comments comments; --full prints them all
  issue history <n>             what was tried before: the merged pull request,
                                what reverted it, what reviewers said, and what
                                has happened in those files since. Required
                                before the redo route may leave triage
  issue adopt <n> --reason <why> [--state <s>] [--pr <k>] [--branch <b>] [--route <r>]
                                take work that predates the plugin into the
                                machine: records what is true, marks the record
                                adopted, and does not invent the artefacts of
                                the states it never passed. Defaults to pr-open
  issue rework <n> --reason <why>
                                the review rejected the approach: back to triage
                                with the pull request left open. Planning runs
                                from the issue, not from the diff that was refused
  issue escalate <n>            send a quickfix back to triage, so R-IDs come
                                from the issue rather than from the diff
  issue block <n> --by <issue> --reason <why>
                                this issue waits on another that must merge
                                first: work a reviewer wants landed before this
                                one, which this issue's slices cannot hold
  issue unblock <n> --by <issue> [--reason <why>]
                                what it waited on has landed, or stopped mattering
  issue draft-blocker <n> --what <text> [--pr <k>] [--raised-by <who>] [--url <u>]
            [--prior <branch>] [--title <text>]
                                draft the upstream issue for work that must merge
                                before this one, into blockers/. Opening it is
                                yours; then issue block with the number it got
  issue blocks <n> [--check] [--all]
                                what it waits on; --check reads each blocker's
                                state from GitHub and lifts nothing
  branch create --issue <n> --slug <s> [--index <i>]
  render <template> --issue <n> --values <file.json> [--path <p>]
                                fill a shipped template; without --path, print it
  render --check <template> --file <f>
                                every section the template declares is present
  task start --issue <n> --task <T1>
                                mark the task this working tree is executing
  task stop | task show         clear it; show what is running where
  task sync --issue <n>         read the Owns sets out of the task files, so the
                                pre-write hook guards what the plan agreed; a
                                task whose Status is withdrawn owns nothing, and
                                start, receipt write and the hook refuse it
  task attempts --issue <n> [--task <T1>]
                                failed captures per task, counted from the
                                journal; at exec.max_attempts the task is blocked
  task unblock --issue <n> --task <T1> --reason <why>
                                let a blocked task be attempted again. The reason
                                is required — it is the only record of why the
                                next try was expected to differ
  receipt write --issue <n> --task <T1>
                                run the task's "Done when" and record what it
                                printed. There is no way to hand it output
  receipt check --issue <n> --task <T1>
  plan check <issue>            the mechanical half of /pd:plan-review
  audit <issue> [--base main] [--ref <r>]
                                the facts /pd:audit works from; no verdict
  validate steps --issue <n>    what is waiting to be validated, and what is done
  validate launch --issue <n> [--port <p>] [--build]
                                start the built application with CDP on, and
                                print the endpoint Playwright MCP attaches to
  validate stop --issue <n>
  validate attach --issue <n> --title <t> [--expected <t>] [--observed <t>]
                  [--evidence <file>] [--run <command>] [--requirement R<k>]...
                                record a step. There is no --status: the outcome
                                comes from what is attached, or is unverified
  validate supersede <Vk> --issue <n> --by <Vn> --reason <t>
                                set a step aside for a later one that showed the
                                same thing. Nothing is deleted, and the reason is
                                a sentence a person writes
  validate codify --issue <n> --spec <path>
                                register the test the scenario became
  validate run --issue <n> [--spec <path>]
                                run that test; the run is the evidence for PASS
  validate finish --issue <n>   the outcome, validation.md, and the transition
  e2e stability --issue <n> [--runs <k>]
                                run the codified test k times in a row
  review fetch <k>              the mechanical half of reviewing someone else's
                                pull request; no verdict
  review render <k> --values <file.json> [--reveal]
                                write reviews/<k>.md. Publishing stays manual.
                                --reveal shows it in the file manager; where
                                there is no desktop it says so and carries on
  knowledge check               dead paths, drifted layer order, entry shape
  knowledge export              the base, for a one-way push to basic-memory
  preflight <issue> [--slice <i>] [--body <file> | --body-from-pr <k>]
                                run the deterministic gates (section 7);
                                --body-from-pr reads the body of a pull
                                request that is already open
                  [--body-only] re-run only the checks that read the PR body
                  [--only a,b]  run just these checks
  slice suggest --issue <n> [--from-pr <k> | --ref <r>] [--worktree <path|name>]
                                the facts a slicer works from, plus a draft
                                grouped by layer. A draft, not a decision.
                                --from-pr slices an already-published pull
                                request instead of local work (scenario 13);
                                pdkit pr threads <k> then says which new slice
                                each existing review thread moves to.
                                Without either, the diff is HEAD of the tree,
                                and a tree that is not the issue's is refused;
                                --ref reads a branch without checking it out,
                                --worktree reads another tree
  slice set --issue <n> --from <f.json> [--from-pr <k> | --ref <r>] [--worktree <w>]
                                validate a proposal and store the graph; pass
                                the same source as to suggest
  slice join --issue <n> --slices <i,j[,k…]> [--slug <s>] [--title <t>]
                                [--ref <r> | --worktree <w>]
                                merge slices into one, published as one commit
                                per slice it was made from. Refuses a slice
                                branch review moved away from the change set.
                                The joined slice records the pull requests it
                                replaces (pdkit pr supersede)
  slice show --issue <n>        the graph and what has been verified
  slice verify --issue <n> [--slice <i>] [--all] [--standalone]
                                build the slice and record what came back
  slice verify --issue <n> --slice <i> --commits
                                build each intermediate commit of a
                                multi-commit slice; recorded, never a gate
  slice render --issue <n> [--values <f>]
                                slices.md from the graph; the verified columns
                                are not yours to type
  slice materialize --issue <n> --slice <i> [--subject <s>] [--force]
                                branch from the slice's base, apply it, commit;
                                a slice with "commits" makes one commit per
                                group with its own subject, and takes no
                                --subject
  slice cascade --issue <n> --from <i>
                                rebase what is stacked on it and verify again
  worktree create|list|remove [--issue <n>] [--name <n>] [--force]
                              [--slug <s> | --branch <b>] [--ref <r>]
                                create names the branch from the slug, so the
                                tree starts on the name preflight and the gate
                                will check. Without one the tree is detached and
                                says so — a branch is still needed before a push
  editor [<issue>]              open the issue's worktree in the IDE at
                                editor.path. Without a number, the issue of the
                                branch this tree is on
  open home|issue|tree [<issue>]
                                open $PDKIT_HOME, the issue's directory in it,
                                or its worktree in the file manager
  gate open --issue <n> (--branch <b> | --pr <k> --kind reply) [--ttl <10m>]
                                push tokens are for a branch and only from
                                preflight-green; reply tokens are for a pull
                                request, and cover the batch of drafts shown
  gate verify (--branch <b> | --pr <k> --kind reply)
  gate close (--branch <b> | --pr <k> --kind reply)
  gate revoke                   drop every outstanding token
  pr create --issue <n> --branch <b> --title <t> --body <file> [--base <b>]
                                opens the pull request and records it. Without
                                --base, a stacked slice opens against its
                                predecessor's branch and everything else against
                                repo.base_branch. A base upstream does not have
                                is refused before the token is spent — which is
                                every stacked slice, when you work from a fork
  publish --issue <n> --branch <b> --title <t> --body <file> [--slice <i>] [--base <b>]
                                /pd:pr step 8 as one command, after the person has
                                read the body: state --to preflight-green (earned,
                                as always), gate open, git push, pr create — in
                                that order, one token for the push and the PR.
                                Asks nothing. Stops at the first refusal and says
                                what is public and what the token has left
  publish --issue <n> --branch <b> --pr <k> [--slice <i>]
                                the same for an open pull request (/pd:pr-sync):
                                push --force-with-lease, then back to pr-open
  pr register <k> --issue <n> [--slice <i>] [--branch <b>]
  pr list [--issue <n>]         every registered PR: CI, review, how idle
  pr refresh <k> [--issue <n>]  read GitHub into prs.json
  pr show <k>                   what is recorded
  pr ci <k> [--no-logs]         the CI verdict, measured against other open PRs,
                                plus the failing steps' log for the jobs the
                                measurement says are yours. --no-logs for a
                                sweep, where a request per broken job is not
                                reading anyone asked for
  pr threads <k>                threads and reviews, bots collapsed, mapped to
                                slices. Nothing is classified here
  pr diff <k> [--stat]          what a push would change on the pull request:
                                its head on GitHub against the local branch, and
                                the files the pull request would then carry
                                outside its slice. Shown before the push gate
  pr render <k>                 prs/<k>.md from prs.json
  pr reply <k> --thread <id> --body <f> [--resolve]
                                needs a reply token for <k>
  pr supersede <k> --by <new> --body <f> [--confirm]
                                close <k> on GitHub with the comment in <f>,
                                pointing at the pull request that replaced it,
                                and record it. Without --confirm it prints what
                                it would post; with it, it needs a reply token
                                for <k>
  pr merged <k> | pr closed <k> [--reason <why>] [--superseded-by <k>]
                                a fact about the PR. The issue does not move.
                                A closed pull request keeps the issue unfinished
                                unless the one that replaced it landed
  drift <issue> [--upstream <ref>] [--ref <branch>] [--files a,b]
                                what landed upstream under each slice since it
                                branched, and what touched lines the plan cites.
                                Without a slice graph the branch comes from the
                                registered pull request, or from a local
                                DESKTOP-<n>/… branch; --ref overrides both
  defer new --issue <n> --what <text> [--pr <k>] [--raised-by <who>] [--url <u>]
            [--kind bug|feature|task] [--title <text>]
                                record something set aside, and draft the issue
                                that would settle it. The record is a journal
                                entry, so it outlives the issue reaching merged.
                                --kind picks which of upstream's issue forms the
                                draft is laid out in, so it can be copied field
                                by field into the template in the GitHub UI
  defer list --issue <n> [--all]
                                what is still outstanding; --all includes what
                                has been settled
  defer resolve <D> --issue <n> --follow-up <issue>
  defer drop <D> --issue <n> --reason <why>
                                a fact about what happened, not a verdict: an
                                issue number that exists, or the only record of
                                why a reviewer's point is not being acted on
  amendment new --issue <n> [--values <f>]
                                allocate an A-ID and render the amendment
  amendment list --issue <n>    every amendment and its status; says how many are
                                still waiting, because until then the plan has not
                                moved and the work runs against the old one
  amendment approve <A> --issue <n> [--by <who>]
  amendment reject <A> --issue <n> --reason <why>
                                take the decision that amendment new says nothing
                                moves without. The issue does not transition: the
                                plan changes and the work continues against it.
                                Approve applies the Requirements affected table to
                                the issue's R-IDs and to plan.md's Requirements line,
                                renders the ### T<k> tasks under Slices affected into
                                tasks/ and plan.md, marks the tasks they replace
                                withdrawn, and re-syncs the ownership map
  amendment sync <A> --issue <n>
                                finish applying an approved amendment that did not
                                reach the record, plan.md or tasks/; never applies
                                twice, never overwrites a task file
  findings new --issue <n> [--values <f>]
                                the artefact for an issue whose deliverable is
                                an answer rather than a diff, and the draft of
                                the comment. The count of captures is produced
                                here, not typed; publishing stays a human action
  close <issue> [--finish] [--force] [--confirmed <who>]
                                the facts for a knowledge harvest; --finish
                                moves the issue to merged, but only once every
                                pull request has landed, and cleans up worktrees.
                                An answered issue closes to resolved instead, and
                                requires --confirmed: who said it was settled is
                                a fact about them, not a verdict of ours
  reset <issue> [--confirm] [--purge] [--worktrees] [--force]
                                start one issue over. Without --confirm it shows
                                what would go and what would stay; with it, the
                                artefacts are archived (--purge deletes instead),
                                the issue's consent tokens and active pointers
                                are dropped, and the record is gone — so the
                                machine reads it as new again and triage is the
                                only way out. Touches no other issue. The journal
                                is append-only and keeps the earlier attempt, and
                                nothing upstream moves: an open pull request is
                                forgotten, not closed. --worktrees also removes
                                this issue's trees, refusing any holding an
                                unmerged branch unless --force
  checkpoint <issue> --phase <exec|slice|pr-sync|resume>
                                the first step of a phase that changes things:
                                copies the issue's artefacts and records its
                                state and branch heads, so the phase can be undone
  checkpoint list <issue>       the checkpoints an issue has
  rollback <issue> [--to <C>] [--confirm]
                                back to a checkpoint, the latest by default.
                                Without --confirm it shows what would come back
                                and what stays; with it, branches are reset (their
                                tips kept under refs/pdkit-backup/), artefacts
                                restored (the present ones archived), the record
                                put back. Refused if the phase moved the issue to
                                another state. Published work and the journal stay
  stats [--limit <n>] [--author <login>]
                                what merged pull requests actually look like,
                                and where the guessed thresholds fall in that
                                distribution. Recommends nothing, writes nothing
  cost [--issue <n>] [--since <date>] [--transcripts <dir>]
                                what each issue cost in tokens, from Claude Code's
                                transcripts, split by phase and normalised per
                                task, slice, requirement, changed line, merged PR
                                and agent run; grouped by route. Prints the share
                                of calls it could not attribute. Recommends nothing
  cost --snapshot               also write $PDKIT_HOME/cost/<date>.json
  cost --compare <date>         that snapshot beside the issues journalled since
  hook <event>                  run a hook handler; reads the payload on stdin
  version                       print the plugin version

Options:
  --json                        machine-readable output where supported
  --repo <path>                 act on this repository instead of the cwd
  -h, --help                    show this help

Every command declares the flags it reads and the rest are refused, so a
misspelling is an error rather than a command that ran without the thing you
asked for. The refusal lists what the command does take.

See docs/specification/ for the design, and docs/workflows/ for the scenarios.
`;

/**
 * Flags every command takes.
 *
 * `--json` is honoured where there is something structured to say and ignored
 * where there is not, which is why it is here rather than in each row. `--repo`
 * reaches `repoContext`, and that is called from nearly everything.
 */
export const GLOBAL_FLAGS = ['json', 'repo', 'help', 'h'];

/**
 * What each command accepts, beyond the global four — each REGISTRY row's
 * `flags`, gathered into one table.
 *
 * A flag nobody declares is a flag nobody reads, and `parseArgs` will happily
 * hand one over. Until this table existed the result was silence: on the first
 * live run `pdkit issue fetch 18967 --body` exited 0 and printed the summary
 * without a body, so the session tried `--full`, got the same, and went to
 * `gh issue view --json body` for an issue pdkit had already downloaded. Neither
 * flag existed. Nothing said so.
 *
 * The cost is worse on a command that writes. `--force`, `--confirm` and
 * `--body` are one letter from flags that exist on a neighbouring command, and
 * a misspelling of any of them reads as "the safe thing was asked for and did
 * not happen" only afterwards.
 *
 * Declared per COMMAND, not per subcommand: one handler serves all of a
 * command's actions, and splitting the table finer would make it a second copy
 * of the switch that has to be kept in step. So `pdkit gate close --ttl 5m` is
 * accepted here and ignored by the action — a narrower error for a much larger
 * table, and the wrong trade.
 */
export const COMMAND_FLAGS = Object.fromEntries(
  Object.entries(REGISTRY)
    .filter(([, entry]) => entry.flags)
    .map(([name, entry]) => [name, entry.flags]),
);

/**
 * Edit distance, capped: only used to decide whether to suggest a name.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function distance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);

  for (let i = 1; i <= left.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= right.length; j += 1) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = row;
  }

  return previous[right.length];
}

/**
 * The flags given that this command does not read.
 *
 * `hook` is exempt on purpose. It is invoked by the host rather than typed, and
 * refusing an argument a future Claude Code adds would take the gate down to
 * report a typo nobody made.
 *
 * @param {string|undefined} command
 * @param {Record<string, string|boolean>} flags
 * @returns {{name: string, suggestion: string|null}[]}
 */
export function unknownFlags(command, flags) {
  const declared = COMMAND_FLAGS[command ?? ''];
  if (!declared || command === 'hook') return [];

  const known = [...declared, ...GLOBAL_FLAGS];

  return Object.keys(flags)
    .filter((name) => !known.includes(name))
    .map((name) => {
      // Two edits, and never longer than the name itself: "b" is within two of
      // half the table, and a suggestion that fits everything helps with
      // nothing.
      const near = known
        .map((candidate) => ({ candidate, at: distance(name, candidate) }))
        .filter((entry) => entry.at <= 2 && entry.at < name.length)
        .sort((left, right) => left.at - right.at);

      return { name, suggestion: near[0]?.candidate ?? null };
    });
}

/**
 * Split argv into a command, positional arguments, and flags.
 *
 * @param {string[]} argv
 * @returns {{command: string|undefined, args: string[], flags: Record<string, string|boolean|Array<string|boolean>>}}
 */
export function parseArgs(argv) {
  const args = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      args.push(token);
      continue;
    }
    const [name, inlineValue] = token.replace(/^--?/, '').split('=');

    // A flag typed twice used to keep the second one silently. For a flag that
    // takes one value that is a typo either way; for one that takes several —
    // `--requirement R1 --requirement R2` — it dropped half of what was asked
    // for and reported success. Repeats collect into a list, and a command that
    // wants one value sees something that is not a string and says so.
    const add = (value) => {
      if (!(name in flags)) flags[name] = value;
      else if (Array.isArray(flags[name])) flags[name].push(value);
      else flags[name] = [flags[name], value];
    };

    if (inlineValue !== undefined) {
      add(inlineValue);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
      add(argv[i + 1]);
      i += 1;
    } else {
      add(true);
    }
  }

  return { command: args.shift(), args, flags };
}

/**
 * The version, plus the commit it was built from.
 *
 * `package.json` has said 0.1.0 for every commit there has ever been, so on its
 * own it identifies nothing: a bug report against "0.1.0" names a hundred
 * different trees. The commit does identify one, and it is free to read when
 * the plugin is a checkout — which it is, whether installed with --plugin-dir
 * or cloned by the marketplace.
 *
 * Degrades to the bare version rather than failing: a plugin unpacked from an
 * archive is still a plugin, and refusing to say what version it is because it
 * cannot say which commit would be worse than saying less.
 *
 * @returns {Promise<string>}
 */
async function versionLine() {
  const version = await readVersion();

  try {
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: PLUGIN_ROOT });
    const { stdout: dirty } = await run('git', ['status', '--porcelain'], { cwd: PLUGIN_ROOT });
    // A modified checkout is not the commit it names, and a bug reproduced
    // against one is not reproducible anywhere else. Say so.
    return `${version} (${stdout.trim()}${dirty.trim() ? ', modified' : ''})`;
  } catch {
    return version;
  }
}

/**
 * How long a hook waits for the payload the host is supposed to send it.
 *
 * Generous for a write to a local pipe, and short enough that a host which
 * sends nothing costs a pause instead of a session.
 */
export const HOOK_PAYLOAD_WAIT_MS = 2000;

/**
 * Read a hook payload from stdin, bounded.
 *
 * Two defects lived in the previous four lines, and together they hung Claude
 * Code at startup the first time this plugin was ever installed.
 *
 * The first: `for await (const chunk of process.stdin)` waits for the END OF
 * THE STREAM, and what a hook needs is the payload. A host that writes the JSON
 * and keeps the pipe open — which is a perfectly ordinary thing for a host to
 * do — is waited out forever. Measured: with stdin closed the handler answered
 * in 0s, with the pipe held open for five seconds it answered in five, and the
 * work itself takes 40–65ms. So the payload is parsed as it arrives and the
 * read ends the moment it is complete, rather than when the writer feels like
 * closing.
 *
 * The second: `bin/pdkit` sets `process.exitCode` and returns rather than
 * calling `process.exit`, so an stdin stream still being read keeps the event
 * loop alive on its own. Even an abandoned read has to be paused, or the
 * handler decides instantly and the process still never exits.
 *
 * This is decision 98 in a second place — a read with no timeout — and the
 * lesson generalises past both: anything that waits on something outside this
 * process says how long it is prepared to wait.
 *
 * @param {{waitMs?: number}} [options]
 * @returns {Promise<{payload: object|null, timedOut: boolean}>}
 */
async function readHookPayload(options = {}) {
  if (process.stdin.isTTY) return { payload: null, timedOut: false };

  const waitMs = options.waitMs ?? HOOK_PAYLOAD_WAIT_MS;
  const chunks = [];

  /** The payload if what has arrived so far is a whole one, undefined while it is not. */
  const sofar = () => {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };

  const expired = Symbol('expired');
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(expired), waitMs);
  });

  const reading = (async () => {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
      const whole = sofar();
      if (whole !== undefined) return whole;
    }
    return sofar() ?? null;
  })();

  const answer = await Promise.race([reading, deadline]);
  clearTimeout(timer);
  reading.catch(() => {});

  // Abandoned or finished, the stream must stop holding the process open, and
  // pausing is not enough to do it: measured, a handler that had already
  // decided still sat until the writer closed the pipe — five seconds for a
  // decision made in sixty milliseconds. `unref` takes the handle off the event
  // loop's books and `destroy` closes the read side, so the exit code
  // bin/pdkit set is actually reached.
  process.stdin.pause();
  process.stdin.unref?.();
  process.stdin.destroy?.();

  if (answer !== expired) return { payload: answer, timedOut: false };

  const partial = sofar();
  return { payload: partial ?? null, timedOut: partial === undefined };
}

/**
 * Run a hook handler.
 *
 * Most events fail open: a handler that cannot load must not block the user's
 * work, because a missing module is a plugin bug rather than a policy
 * decision, and a plugin that bricks the session while a stage is half-built
 * gets uninstalled.
 *
 * `pre-bash` is listed in FAIL_CLOSED and behaves the other way round. It
 * guards writes to someone else's repository, so a handler that will not load
 * there is not an incomplete feature — it is the gate being off, silently. The
 * reasoning is in lib/hooks/events.js.
 *
 * The one thing this must never do, on any event, is allow when a handler
 * *did* load and said BLOCK.
 */
async function runHook(event) {
  const handlerFile = HOOK_HANDLERS[event];
  if (!handlerFile) {
    process.stderr.write(`pdkit: unknown hook event "${event}"\n`);
    return EXIT.ERROR;
  }

  const failClosed = FAIL_CLOSED.includes(event);

  /**
   * What to do when the handler could not produce a decision at all.
   *
   * @param {string} problem
   * @returns {number}
   */
  const undecided = (problem) => {
    if (!failClosed) {
      process.stderr.write(`pdkit: hook "${event}" ${problem}; allowing\n`);
      return EXIT.OK;
    }
    process.stderr.write(
      `pdkit: hook "${event}" ${problem}. This hook guards writes to the upstream repository, so it ` +
        `refuses rather than allows when it cannot run. Fix the plugin or disable it — do not work ` +
        `around this by rephrasing the command.\n`,
    );
    return EXIT.BLOCK;
  };

  const { payload, timedOut } = await readHookPayload();

  // No payload is not the same as no answer. Stdin ending with nothing on it is
  // a host that had nothing to say; a deadline reached is a host that has not
  // said yet, and for the event that guards writes upstream the difference is
  // the whole gate — "I do not know what this command is" must not read as
  // "there is no command here".
  if (timedOut) {
    return undecided(`waited ${HOOK_PAYLOAD_WAIT_MS}ms for its payload and the host sent none`);
  }

  let handler;
  try {
    // A URL, not a path: see the note in bin/pdkit. Here the consequence is
    // narrower and worse — the catch below would turn it into `undecided`, so
    // the fail-closed event would report the handler as unavailable rather than
    // refusing, on every Windows session.
    ({ handle: handler } = await import(pathToFileURL(join(LIB_DIR, 'hooks', handlerFile)).href));
  } catch (error) {
    return undecided(`handler "${handlerFile}" is unavailable (${error.code ?? error.message})`);
  }

  if (typeof handler !== 'function') return undecided(`handler "${handlerFile}" exports no handle()`);

  let result;
  try {
    result = await handler(payload, { event, pluginRoot: PLUGIN_ROOT });
  } catch (error) {
    return undecided(`failed (${error.message})`);
  }

  if (result?.block) {
    process.stderr.write(`${result.reason ?? 'blocked by pdkit'}\n`);
    return EXIT.BLOCK;
  }
  if (result?.notice) {
    // Plain stdout reaches the model only. A line the person has to act on goes
    // as systemMessage, which Claude Code shows them; the context for the model
    // rides in the same JSON, since plain text and JSON on one stdout do not mix.
    const hostEvent = typeof payload?.hook_event_name === 'string' ? payload.hook_event_name : null;
    process.stdout.write(
      `${JSON.stringify({
        systemMessage: result.notice,
        ...(result.message && hostEvent ? { hookSpecificOutput: { hookEventName: hostEvent, additionalContext: result.message } } : {}),
      })}\n`,
    );
    return EXIT.OK;
  }
  if (result?.message) process.stdout.write(`${result.message}\n`);
  return EXIT.OK;
}

/**
 * Issue, check, spend or revoke consent tokens.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runGate(args, flags) {
  const action = args[0];

  if (action === 'revoke') {
    const revoked = await gate.revokeAll();
    process.stdout.write(`${revoked} token${revoked === 1 ? '' : 's'} revoked\n`);
    return EXIT.OK;
  }

  const branch = typeof flags.branch === 'string' ? flags.branch : undefined;
  const prNumber = Number.parseInt(String(flags.pr), 10);
  const target = {
    branch,
    pr: Number.isInteger(prNumber) ? prNumber : undefined,
    kind: typeof flags.kind === 'string' ? flags.kind : undefined,
  };

  const subject = gate.subjectOf(target);
  if (!subject) {
    process.stderr.write(`pdkit gate ${action ?? ''}: --branch <b>, or --pr <k> --kind reply, is required\n`);
    return EXIT.ERROR;
  }

  if (action === 'open') {
    const issue = issueFlag(flags);
    if (!Number.isInteger(issue)) {
      process.stderr.write('pdkit gate open: --issue is required\n');
      return EXIT.ERROR;
    }

    const ttlMs = flags.ttl === undefined ? undefined : gate.parseDuration(String(flags.ttl));
    const result = await gate.open({ issue, ...target, ttlMs: ttlMs ?? undefined });

    if (!result.ok) {
      process.stderr.write(`pdkit gate open: ${result.error}\n`);
      return EXIT.ERROR;
    }
    if (flags.json) printJson(result);
    else process.stdout.write(`${result.kind} token for ${result.subject}, valid until ${result.expiresAt}\n`);
    return EXIT.OK;
  }

  if (action === 'verify') {
    const result = await gate.verify(target);
    if (flags.json) printJson(result);
    else process.stdout.write(result.valid ? `valid ${subject.kind} token for ${subject.subject}\n` : `${result.reason}\n`);
    return result.valid ? EXIT.OK : EXIT.ERROR;
  }

  if (action === 'close') {
    const result = await gate.close(target);
    if (!result.ok) {
      process.stderr.write(`pdkit gate close: ${result.error}\n`);
      return EXIT.ERROR;
    }
    process.stdout.write(`${subject.kind} token for ${subject.subject} spent\n`);
    return EXIT.OK;
  }

  process.stderr.write(`pdkit gate: unknown action "${action ?? ''}" (open, verify, close, revoke)\n`);
  return EXIT.ERROR;
}

/**
 * Open a pull request. The only command here that writes to GitHub.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
/** `pdkit pr` actions, so an unknown one can list what exists. */
const PR_ACTIONS = ['create', 'register', 'list', 'show', 'refresh', 'ci', 'threads', 'diff', 'render', 'reply', 'merged', 'closed', 'supersede'];

function waitingOn(domains) {
  const open = (domains ?? []).filter((entry) => entry.state === 'inreview').map((entry) => entry.domain);
  return open.length === 0 ? '' : `  waiting:${open.join(',')}`;
}

async function runPr(args, flags) {
  const action = args[0] ?? '';
  if (!PR_ACTIONS.includes(action)) {
    process.stderr.write(`pdkit pr: unknown action "${action}" (${PR_ACTIONS.join(', ')})\n`);
    return EXIT.ERROR;
  }

  const repoRoot = typeof flags.repo === 'string' ? flags.repo : undefined;
  const home = resolveHome({ repoRoot });
  const config = await load({ repoRoot, home });

  if (action === 'create') {
    const issue = issueFlag(flags);
    if (!Number.isInteger(issue) || typeof flags.branch !== 'string' || typeof flags.title !== 'string' || typeof flags.body !== 'string') {
      process.stderr.write('pdkit pr create: --issue, --branch, --title and --body <file> are required\n');
      return EXIT.ERROR;
    }

    const body = await readFile(flags.body, 'utf8');

    const target = await pullRequestBase({ issue, branch: flags.branch, base: flags.base, config, home });
    if (!target.ok) {
      process.stderr.write(`pdkit pr create: ${target.error}`);
      return EXIT.ERROR;
    }

    const { result, unrecorded } = await openPullRequest({ issue, branch: flags.branch, ...target, title: flags.title, body, config, home });
    if (unrecorded) {
      // The PR exists now; refusing to record it would leave the state machine
      // describing a world that is one pull request out of date.
      process.stderr.write(`pdkit pr create: opened ${result.url} but could not record it: ${unrecorded}\n`);
    }

    if (flags.json) printJson(result);
    else process.stdout.write(`${result.url}\n`);

    return EXIT.OK;
  }

  if (action === 'list') {
    const wanted = issueFlag(flags);
    const issues = Number.isInteger(wanted)
      ? [wanted]
      : (await readdir(paths(home).issues).catch(() => []))
          .map((entry) => Number.parseInt(entry, 10))
          .filter((issue) => Number.isInteger(issue))
          .sort((a, b) => a - b);

    const rows = [];
    for (const issue of issues) {
      const book = await pr.read(issue, { home });
      const waitsOn = (await blocks.open({ issue, home })).map((entry) => entry.by);
      for (const record of book?.prs ?? []) {
        rows.push({ issue, ...record, waitsOn, staleness: pr.staleness(record, { config }), reading: pr.reading(record) });
      }
    }

    if (flags.json) {
      printJson({ prs: rows });
    } else if (rows.length === 0) {
      process.stdout.write('no pull requests registered\n');
    } else {
      for (const row of rows) {
        const age = row.staleness.days === null ? '—' : `${row.staleness.days}d`;
        // A record never read from GitHub carries the defaults it was registered
        // with, and `ci:pending review:none threads:0/0` printed as if somebody
        // had looked. Say it was not read instead of what nobody measured.
        const unread = row.reading.at === null;
        // Replaced, not merely closed: the successor is where the work went.
        const state = row.supersededBy ? `superseded by #${row.supersededBy}` : row.state;
        // Only an open pull request can be acted on; an old reading of a closed
        // one is not something to come back to, so it gets no arrow.
        const flag = row.reading.old && row.state === 'open' ? ' ←' : '';
        process.stdout.write(
          `  #${row.number}  DESKTOP-${row.issue}${row.slice === null ? '' : ` slice #${row.slice}`}  ${state}` +
            (unread
              ? '  ci:unread  review:unread  threads:unread'
              : `  ci:${row.ci.verdict}  review:${row.review.decision ?? 'none'}` +
                // "open of total", spelled out: `4/5` was read as four of five
                // resolved on #19849, when four were still waiting.
                `  threads:${row.review.threadsOpen} open of ${row.review.threadsTotal}`) +
            `  idle:${age}${row.staleness.stale ? ' STALE' : ''}` +
            // Who it is waiting on, when it is waiting on people. `ci:pending`
            // reads as "come back later"; this says come back after whom.
            `${waitingOn(row.review.domains)}` +
            // Waiting on another issue's merge, which no refresh will change.
            `${row.waitsOn.length > 0 ? `  waits-on:${row.waitsOn.map((by) => `#${by}`).join(',')}` : ''}` +
            // When this row was read. Every field to its left is local, and a
            // sweep costs 37 seconds, so nobody refreshes before every glance.
            `  read:${row.reading.label}${flag}\n`,
        );
      }
    }

    return EXIT.OK;
  }

  // Everything below is about one pull request.
  const number = Number.parseInt(String(args[1] ?? flags.pr), 10);
  if (!Number.isInteger(number)) {
    process.stderr.write(`pdkit pr ${action}: a pull request number is required\n`);
    return EXIT.ERROR;
  }

  const issue = Number.isInteger(issueFlag(flags))
    ? issueFlag(flags)
    : await pr.issueOf(number, { home });

  if (!Number.isInteger(issue)) {
    process.stderr.write(
      `pdkit pr ${action}: #${number} is not registered under any issue. Pass --issue <n>, or register it with pdkit pr register\n`,
    );
    return EXIT.ERROR;
  }

  if (action === 'register') {
    const index = Number.parseInt(String(flags.slice), 10);
    const record = await pr.register({
      issue,
      number,
      slice: Number.isInteger(index) ? index : null,
      branch: typeof flags.branch === 'string' ? flags.branch : null,
      base: typeof flags.base === 'string' ? flags.base : null,
      home,
    });

    if (flags.json) printJson(record);
    else process.stdout.write(`#${record.number} recorded under DESKTOP-${issue}${record.slice === null ? '' : ` as slice #${record.slice}`}\n`);

    return EXIT.OK;
  }

  if (action === 'supersede') {
    const by = Number.parseInt(String(flags.by), 10);
    if (!Number.isInteger(by) || typeof flags.body !== 'string') {
      process.stderr.write('pdkit pr supersede: --by <k> and --body <file> are required\n');
      return EXIT.ERROR;
    }

    const book = await pr.read(issue, { home });
    const old = book?.prs.find((entry) => entry.number === number);
    const successor = book?.prs.find((entry) => entry.number === by);
    if (!old || old.state !== 'open') {
      process.stderr.write(`pdkit pr supersede: #${number} is not an open pull request of DESKTOP-${issue} (${old?.state ?? 'not recorded'})\n`);
      return EXIT.ERROR;
    }
    if (!successor || successor.state === 'closed') {
      // The replacement has to exist before the original goes, or the review
      // history points at nothing. Opening it is /pd:pr's job; this one only
      // closes.
      process.stderr.write(`pdkit pr supersede: #${by} is not a live pull request of DESKTOP-${issue}; open and register it first\n`);
      return EXIT.ERROR;
    }

    const body = await readFile(flags.body, 'utf8');
    if (!flags.confirm) {
      process.stdout.write(
        `would close #${number} on ${get(config, 'repo.upstream')} with this comment, and record it as superseded by #${by}:\n\n` +
          `${body.trim().split('\n').map((line) => `  > ${line}`).join('\n')}\n\n` +
          `Show this to the person. Then: pdkit gate open --issue ${issue} --pr ${number} --kind reply, and run again with --confirm.\n`,
      );
      return EXIT.OK;
    }

    await gh.closeSuperseded({ pr: number, body, config, home });
    const record = await pr.markClosed({ issue, number, supersededBy: by, reason: `superseded by #${by}`, home });

    if (flags.json) printJson(record);
    else process.stdout.write(`#${number} closed, superseded by #${by}\n`);
    return EXIT.OK;
  }

  if (action === 'merged' || action === 'closed') {
    const record =
      action === 'merged'
        ? await pr.markMerged({ issue, number, home })
        : await pr.markClosed({
            issue,
            number,
            reason: typeof flags.reason === 'string' ? flags.reason : undefined,
            supersededBy: typeof flags['superseded-by'] === 'string' ? Number.parseInt(flags['superseded-by'], 10) : undefined,
            home,
          });

    const summary = await pr.rollup(issue, { home });

    if (flags.json) printJson({ record, rollup: summary });
    else {
      process.stdout.write(`#${number} is ${record.state}\n`);
      // Said out loud because the issue did NOT move: merge is a fact about a
      // pull request, and an issue with three slices is not finished by one.
      process.stdout.write(
        summary.allMerged
          ? `  every pull request of DESKTOP-${issue} has landed — pdkit close will finish the issue\n`
          : `  DESKTOP-${issue} still has ${summary.unfinished.length} unfinished: ` +
              `${summary.unfinished.map((entry) => `#${entry}`).join(', ')}\n` +
              (summary.superseded.length > 0
                ? `  superseded and settled: ${summary.superseded.map((entry) => `#${entry}`).join(', ')}\n`
                : ''),
      );
    }

    return EXIT.OK;
  }

  if (action === 'refresh') {
    const record = await pr.refresh({ issue, number, config, home });

    if (flags.json) printJson(record);
    else {
      // How much of CI has answered, when not all of it has: "ci pending" right
      // after a push reads as a stuck run unless it says it is still arriving.
      const waiting = (record.ci.jobs ?? []).filter((job) => job.notReported).length;
      const reported = waiting > 0 ? ` (${record.ci.jobs.length - waiting} of ${record.ci.jobs.length} jobs reported on this head)` : '';
      process.stdout.write(`#${number} ${record.state}, review ${record.review.decision ?? 'undecided'}, ci ${record.ci.verdict}${reported}\n`);
      for (const job of record.ci.jobs.filter((entry) => entry.verdict !== 'pass')) {
        process.stdout.write(
          `  ${job.verdict === 'fail' ? '✘' : '!'} ${job.name}  ${job.conclusion}` +
            `${job.peers.length ? `  also red on ${job.peers.map((entry) => `#${entry}`).join(', ')}` : ''}\n`,
        );
      }
    }

    return record.ci.verdict === 'fail' ? EXIT.ERROR : EXIT.OK;
  }

  if (action === 'show') {
    const book = await pr.read(issue, { home });
    const record = book?.prs.find((entry) => entry.number === number);
    if (!record) {
      process.stderr.write(`pdkit pr show: #${number} is not registered under DESKTOP-${issue}\n`);
      return EXIT.ERROR;
    }

    if (flags.json) printJson({ ...record, staleness: pr.staleness(record, { config }) });
    else process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);

    return EXIT.OK;
  }

  if (action === 'ci') {
    const record = await pr.refresh({ issue, number, config, home });

    // The verdict says whether the red is ours; the log says what broke, and
    // that is the half scenario 9 leaves to the model. --no-logs exists for the
    // dashboard sweep, where a request per broken job across ten pull requests
    // buys reading nobody asked for.
    const logs = flags['no-logs'] ? [] : await pr.failureLogs(record, { config });

    if (flags.json) {
      printJson({ pr: number, verdict: record.ci.verdict, jobs: record.ci.jobs, logs });
      return record.ci.verdict === 'fail' ? EXIT.ERROR : EXIT.OK;
    }

    process.stdout.write(`#${number} CI: ${record.ci.verdict}\n`);
    for (const job of record.ci.jobs) {
      if (job.verdict === 'pass') continue;

      const shared = job.peers.length ? ` — the same job is red on ${job.peers.map((entry) => `#${entry}`).join(', ')}` : '';
      // A job pending since June is a different thing from a job pending since
      // a minute ago, and the word "pending" cannot tell them apart.
      const age =
        job.verdict === 'pending' && job.startedAt
          ? ` — in progress for ${Math.floor((Date.now() - Date.parse(job.startedAt)) / 86_400_000)}d, since ${job.startedAt.slice(0, 10)}`
          : '';

      process.stdout.write(`  ${job.verdict.padEnd(12)} ${job.name}${shared}${age}\n`);
    }

    for (const log of logs) {
      process.stdout.write(`\n  ── ${log.job} — the steps that failed\n`);
      if (!log.available) {
        // Said out loud, because a job printed with no log under it reads as a
        // job that failed on nothing.
        process.stdout.write(`     no log: ${log.reason}\n`);
        if (log.url) process.stdout.write(`     ${log.url}\n`);
        continue;
      }
      if (log.dropped > 0) process.stdout.write(`     … ${log.dropped} earlier line(s) not shown\n`);
      for (const line of log.lines) process.stdout.write(`     ${line}\n`);
      if (log.trailing > 0) process.stdout.write(`     … ${log.trailing} line(s) after this, mostly the runner cleaning up\n`);
      // Which window this is. Anchored on the error marker it contains the
      // failure; a bare tail is the fallback and may not.
      if (log.anchor === 'tail') {
        process.stdout.write('     (no ##[error] in this log — this is the end of it, not necessarily the failure)\n');
      }
    }

    // The distinction the measurement exists for, spelled out where it is read.
    process.stdout.write(
      '\n  fail = red here and green on other open PRs. inconclusive = red on theirs too, so not yours to fix.\n' +
        '  flake = the same job answered twice on one commit.\n' +
        // Only when logs were in play. Explaining the fetching rule under a run
        // that fetched nothing describes a report the reader is not holding.
        (flags['no-logs']
          ? '  --no-logs: no failure text was read for any of these.\n'
          : '  the log is fetched for fail only — on the others the measurement has already answered.\n'),
    );

    return record.ci.verdict === 'fail' ? EXIT.ERROR : EXIT.OK;
  }

  if (action === 'diff') {
    const repo = await repoContext(flags);
    const result = await pr.pending({ issue, number, cwd: repo.root ?? process.cwd(), config, home, stat: Boolean(flags.stat) });
    if (!result.ok) {
      process.stderr.write(`pdkit pr diff: ${result.error}\n`);
      return EXIT.ERROR;
    }

    if (flags.json) {
      printJson(result);
      return EXIT.OK;
    }

    const short = (sha) => sha.slice(0, 11);
    const lines = [`#${number} ${result.branch}${result.slice === null ? '' : `, slice #${result.slice}`}`, `  on GitHub : ${short(result.head)}`];
    if (result.ahead === 0 && result.behind === 0) {
      lines.push('  local     : the same commit — nothing to push');
    } else {
      // A rewrite is the normal shape here: pr-sync amends, and the push is a
      // force-with-lease. Said, because "1 ahead" alone reads as an addition.
      const shape = result.behind > 0 ? `${result.ahead} ahead, ${result.behind} behind — a rewrite, pushed with --force-with-lease` : `${result.ahead} ahead`;
      lines.push(`  local     : ${short(result.local)} (${shape})`);
    }
    if (result.outside.length > 0) {
      lines.push(
        `  outside slice #${result.slice} after the push: ${result.outside.join(', ')}`,
        '    the slice graph does not list these — a decision for the person, not a detail of the fix',
      );
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    if (result.stat) process.stdout.write(`\n${result.stat}\n`);
    if (result.patch) process.stdout.write(`\n${result.patch}\n`);
    return EXIT.OK;
  }

  if (action === 'threads' || action === 'render') {
    const fetched = await gh.reviewThreads(number, { config });
    const discussion = await gh.discussion(number, { config });

    const plan = await parsePlanOf(home, issue);
    const facts = await threads.collect({
      issue,
      pr: number,
      threads: fetched,
      discussion,
      config,
      home,
      satisfies: plan,
    });

    if (action === 'threads') {
      if (flags.json) printJson(facts);
      else {
        process.stdout.write(threads.format(facts));
        process.stdout.write(`\n\n  ${facts.counts.unresolvedThreads} unresolved thread(s), ${facts.counts.humans} open item(s) from people\n`);
        if (facts.unmapped.length > 0) {
          process.stdout.write(
            `  ${facts.unmapped.length} item(s) touch a file in no slice — a thread on one, or a review that cites one: either a requirement the plan missed, or a PR that did not explain itself\n`,
          );
        }
      }
      return EXIT.OK;
    }

    const book = await pr.read(issue, { home });
    const record = book?.prs.find((entry) => entry.number === number);
    if (!record) {
      process.stderr.write(`pdkit pr render: #${number} is not registered under DESKTOP-${issue}\n`);
      return EXIT.ERROR;
    }

    const path = await render.write({
      issue,
      template: 'prTracking',
      path: join('prs', `${number}.md`),
      home,
      values: {
        ...pr.renderValues(record, { issue, requirements: await pr.requirementsOf(issue, record, { home }) }),
        threads: threads.format(facts, { kinds: ['thread'] }),
        discussion: threads.format(facts, { kinds: ['review', 'comment'] }),
        ...(typeof flags.values === 'string' ? JSON.parse(await readFile(flags.values, 'utf8')) : {}),
      },
    });

    process.stdout.write(`${path}\n`);
    return EXIT.OK;
  }

  if (action === 'reply') {
    if (typeof flags.thread !== 'string' || typeof flags.body !== 'string') {
      process.stderr.write('pdkit pr reply: --thread <id> and --body <file> are required\n');
      return EXIT.ERROR;
    }

    const body = await readFile(flags.body, 'utf8');
    const result = await gh.replyToThread({
      pr: number,
      threadId: flags.thread,
      body,
      resolve: Boolean(flags.resolve),
      config,
      home,
    });

    if (flags.json) printJson(result);
    else process.stdout.write(`${result.url ?? 'replied'}${result.resolved ? ' (resolved)' : ''}\n`);

    return EXIT.OK;
  }

  return EXIT.ERROR;
}

/**
 * Publish a branch: earn preflight-green, open the token, push, open the pull
 * request. The four commands of `/pd:pr` step 8, in their order, as one.
 *
 * Nothing here asks anything, and nothing here is consent. Consent is step 6 of
 * the skill — the body and the branch, read by a person — and it happens BEFORE
 * this command is typed. What this removes is the model holding a sequence of
 * four commands in the right order: the journal had 152 push refusals against
 * 22 open pull requests, almost all of them that sequence run out of order.
 *
 * It wraps, it does not replace. `state`, `gate open`, `git push` and
 * `pr create` all still work alone, because someone standing in the middle of a
 * half-finished publication needs exactly one of them, not all four again.
 *
 * And it weakens nothing. preflight-green is reached by the same transition,
 * which reads what preflight wrote; the token is the same token, spent on the
 * push before the push runs — the hook's rule, because a push that failed after
 * reaching the remote is still a push — and on the pull request by
 * gh.createPullRequest, which checks it itself. There is deliberately no flag
 * to skip, force or extend any of it: one that seemed needed would be a finding
 * about the gate, not an option for this command.
 *
 * With --pr, the branch already has an open pull request and this is
 * `/pd:pr-sync` step 8's push: the same earning and the same token, then
 * `push --force-with-lease`, because that is how a rebased or cascaded branch
 * reaches its pull request, and the issue goes back to pr-open.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runPublish(args, flags) {
  const issue = issueFlag(flags);
  const branch = typeof flags.branch === 'string' ? flags.branch : null;
  const updating = flags.pr !== undefined;
  const prNumber = updating ? Number.parseInt(String(flags.pr), 10) : null;
  const sliceIndex = flags.slice === undefined ? null : Number.parseInt(String(flags.slice), 10);

  const say = (text) => process.stdout.write(`${text}\n`);
  const refuse = (text) => {
    process.stderr.write(`pdkit publish: ${text}\n`);
    return EXIT.ERROR;
  };

  if (!Number.isInteger(issue) || !branch) {
    return refuse('--issue and --branch are required');
  }
  if (updating) {
    if (!Number.isInteger(prNumber)) return refuse('--pr takes the number of the open pull request this branch updates');
    if (flags.title !== undefined || flags.body !== undefined || flags.base !== undefined) {
      return refuse('--pr updates a pull request that is already open; --title, --body and --base are for opening one');
    }
  } else if (typeof flags.title !== 'string' || typeof flags.body !== 'string') {
    return refuse('--title and --body <file> are required to open a pull request (or --pr <k> to update an open one)');
  }

  const repo = await repoContext(flags);
  if (!repo.root) return refuse(repo.problems.join('; '));
  const config = repo.config;
  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const remote = String(get(config, 'repo.fork_remote') ?? 'origin');

  // Everything that can refuse without publishing anything refuses first.
  //
  // The checkout has to be the branch: preflight-green is earned by the commit
  // that is checked out, and pushing another branch on the strength of it would
  // publish something no check ever saw.
  const standing = await currentBranch({ cwd: repo.root });
  if (standing !== branch) {
    return refuse(
      `the checkout is on ${standing ?? 'a detached HEAD'}, not ${branch}. preflight-green is earned by the commit ` +
        'checked out, so the branch being published has to be the one standing here',
    );
  }
  const head = await revision('HEAD', { cwd: repo.root });

  const body = updating ? null : await readFile(/** @type {string} */ (flags.body), 'utf8');

  let target = null;
  if (updating) {
    const book = await pr.read(issue, { home });
    const record = book?.prs.find((entry) => entry.number === prNumber) ?? null;
    if (!record) return refuse(`#${prNumber} is not registered under issue ${issue} (pdkit pr register)`);
    if (record.branch && record.branch !== branch) return refuse(`#${prNumber} is the pull request of ${record.branch}, not ${branch}`);
  } else {
    // Before the push rather than before the pull request, which is where
    // `pr create` alone has to check: a base upstream does not have is then a
    // refusal with nothing public, instead of a pushed branch with no PR.
    const resolved = await pullRequestBase({ issue, branch, base: flags.base, config, home });
    if (!resolved.ok) return refuse(resolved.error.trimEnd());
    target = resolved;
  }

  // 1. preflight-green, earned. The same transition `pdkit state --to` runs,
  // reading what preflight wrote for this commit on this branch.
  //
  // Already there is the case of a publish that stopped before its push, run
  // again. The state is not set a second time — it cannot be — and the evidence
  // is read again for the commit that is checked out now, with the same
  // function the transition uses. A HEAD that moved since is refused here.
  const before = await state.read(issue, { home });
  if (before.state === 'preflight-green') {
    const found = await preflightRecord.evidence(issue, { home, head, branch });
    if (!found.ok) {
      return refuse(
        `issue ${issue} is preflight-green, and preflight has not shown this commit ready:\n` +
          found.problems.map((problem) => `    ${problem}\n`).join('') +
          `  Run: pdkit preflight ${issue}${sliceIndex ? ` --slice ${sliceIndex}` : ''}, then again with --body-only --body <file>`,
      );
    }
    say(`issue ${issue}: preflight-green, and preflight's record still holds for ${String(head).slice(0, 9)}`);
  } else {
    const moved = await state.transition(issue, 'preflight-green', { slice: sliceIndex, head, branch, home });
    if (!moved.ok) {
      return refuse(
        `stopped before a token was issued or anything was pushed.\n${moved.error}\n` +
          '  What is missing is a preflight run. There is no other way to this state, and this command has none.',
      );
    }
    say(`issue ${issue}: ${moved.from} -> preflight-green`);
  }

  // 2. The token. One, for this branch, covering the push and — when opening —
  // the pull request, once each.
  const opened = await gate.open({ issue, branch, slice: sliceIndex ?? undefined, home });
  if (!opened.ok) return refuse(`no token was issued, nothing was pushed: ${opened.error}`);
  say(`push token for ${branch}, valid until ${opened.expiresAt}`);

  // 3. The push. Spent before it runs, as the hook spends it: this process
  // starts git itself, so the hook never sees the push and the token has to be
  // spent here or nowhere.
  const spent = await gate.close({ branch, kind: 'push' }, { home, use: 'push' });
  if (!spent.ok) return refuse(`nothing was pushed: ${spent.error}`);

  const pushArgs = ['push', ...(updating ? ['--force-with-lease'] : []), remote, branch];
  try {
    await run('git', pushArgs, { cwd: repo.root, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    const said = String(error.stderr ?? error.message).trimEnd().split('\n').slice(-FAILURE_TAIL_LINES);
    return refuse(
      `git ${pushArgs.join(' ')} failed:\n${said.map((line) => `  | ${line}`).join('\n')}\n` +
        `  The token's push is spent and the issue is still preflight-green${updating ? '' : '; no pull request was opened'}.\n` +
        '  Show the person what failed. Once the cause is fixed and they confirm again, run this same\n' +
        '  pdkit publish: it re-reads the preflight record and issues a fresh token.',
    );
  }
  say(`pushed ${branch} to ${remote}${updating ? ' (--force-with-lease)' : ''}`);

  if (updating) {
    const moved = await state.transition(issue, 'pr-open', { reason: `#${prNumber} updated from ${String(head).slice(0, 9)}`, home });
    if (!moved.ok) {
      process.stderr.write(`pdkit publish: pushed to #${prNumber}, but the issue could not move back to pr-open: ${moved.error}\n`);
      return EXIT.ERROR;
    }
    say(`issue ${issue}: preflight-green -> pr-open`);
    return EXIT.OK;
  }

  // 4. The pull request, on the other half of the same token.
  let outcome;
  try {
    outcome = await openPullRequest({ issue, branch, base: target.base, index: target.index, title: /** @type {string} */ (flags.title), body: /** @type {string} */ (body), config, home });
  } catch (error) {
    // The one state worse than either outcome: public branch, no pull request.
    // Said in full, because the next person to read it has to finish it.
    const retry =
      `pdkit pr create --issue ${issue} --branch ${branch} --title ${JSON.stringify(flags.title)} --body ${flags.body}` +
      `${typeof flags.base === 'string' ? ` --base ${flags.base}` : ''}`;
    return refuse(
      `${branch} IS PUSHED to ${remote}, and the pull request was NOT opened: ${error.message}\n` +
        `  The token is half spent: the push is used, the pull request is not, until ${opened.expiresAt}.\n` +
        '  Do not push again. Once the cause is fixed, finish with:\n' +
        `    ${retry}\n` +
        `  After ${opened.expiresAt} the remaining half has expired as well; open a new token first —\n` +
        `    pdkit gate open --issue ${issue} --branch ${branch}\n` +
        '  — which the issue, still preflight-green, allows.',
    );
  }

  if (outcome.unrecorded) {
    process.stderr.write(`pdkit publish: opened ${outcome.result.url} but could not record it: ${outcome.unrecorded}\n`);
  }
  say(outcome.result.url);
  return EXIT.OK;
}

/**
 * Task -> requirements, out of the plan. Used to trace a thread to an R-ID.
 *
 * @param {string} home
 * @param {number} issue
 * @returns {Promise<Record<string, string[]>>}
 */
async function parsePlanOf(home, issue) {
  try {
    const text = await readFile(join(paths(home).issues, String(issue), 'plan.md'), 'utf8');
    return Object.fromEntries(parsePlan(text).tasks.map((task) => [task.id, task.satisfies]));
  } catch {
    return {};
  }
}
/**
 * Validation: bring the application up, attach evidence, close it out.
 *
 * Note what has no flag: the status of a step. `--run` and `--evidence` are the
 * only ways a step gets one, and both produce it from something that happened
 * (spec section 2.2, invariant 5).
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runValidate(args, flags) {
  const [subcommand] = args;
  const issue = Number.parseInt(String(flags.issue ?? args[1]), 10);

  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit validate: --issue <n> is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  const home = resolveHome({ repoRoot: repo.root ?? undefined });
  const stabilityRuns = Number(get(repo.config, 'validation.e2e_stability_runs') ?? 3);

  // The subcommands that build, launch or run something in the tree. Evidence
  // gathered from another issue's build is evidence about that issue, filed
  // under this one. The rest only read and write the issue's own record.
  const touchesTree = ['launch', 'codify', 'run'].includes(subcommand) || (subcommand === 'attach' && typeof flags.run === 'string');
  if (touchesTree && repo.root) {
    const held = await requireIssueTree({ issue, repo, command: `pdkit validate ${subcommand}`, words: ['validate', ...args], flags });
    if (!held.ok) return EXIT.ERROR;
  }

  switch (subcommand) {
    case 'steps': {
      const waiting = await validation.steps({ issue, home, repoRoot: repo.root ?? undefined });
      if (flags.json) printJson(waiting);
      else {
        process.stdout.write(`validate: issue ${issue} — ${waiting.state}${waiting.route ? `, ${waiting.route}` : ''}\n`);
        process.stdout.write(`  requirements : ${waiting.requirements.join(', ') || '—'}\n`);
        process.stdout.write(`  e2e coverage : ${waiting.e2eCoverage ?? 'no plan says'}\n\n`);
        for (const task of waiting.tasks) {
          process.stdout.write(`  ${task.id} ${task.title}\n      satisfies ${task.satisfies.join(', ') || '—'}\n`);
          if (task.command) process.stdout.write(`      done when \`${task.command}\`\n`);
        }
        process.stdout.write(`\n${validation.format(waiting.record)}\n`);
      }
      return EXIT.OK;
    }

    case 'launch': {
      if (!repo.root) {
        process.stderr.write(`pdkit validate launch: ${repo.problems.join('; ')}\n`);
        return EXIT.ERROR;
      }

      // Before the build, so a refusal costs nothing.
      const app = validation.trustedApp(repo.root);
      if (app.error) {
        process.stderr.write(`pdkit validate launch: ${app.error}\n`);
        return EXIT.ERROR;
      }

      if (flags.build) {
        const script = pickScript(await repoScripts(repo.root), ['build']);
        if (!script) {
          process.stderr.write('pdkit validate launch: --build was asked for, and this repository has no build script\n');
          return EXIT.ERROR;
        }
        const command = `${get(repo.config, 'repo.package_manager') ?? 'pnpm'} run ${script}`;
        process.stderr.write(`  building: ${command}\n`);
        const built = await evidence.capture({ command, cwd: repo.root, timeoutMs: 30 * 60 * 1000 });
        if (built.exitCode !== 0) {
          process.stderr.write(`${built.stdout}${built.stderr}\npdkit validate launch: the build failed; there is nothing to drive\n`);
          return EXIT.ERROR;
        }
      }

      const port = Number.parseInt(String(flags.port), 10);
      const launched = await validation.launch({
        issue,
        home,
        repoRoot: repo.root,
        config: repo.config,
        app,
        port: Number.isInteger(port) ? port : undefined,
      });

      if (!launched.ok) {
        process.stderr.write(`pdkit validate launch: ${launched.error}\n`);
        return EXIT.ERROR;
      }

      if (flags.json) printJson(launched.app);
      else {
        process.stdout.write(
          `${launched.alreadyRunning ? 'already running' : 'started'}: pid ${launched.app.pid}, CDP at ${launched.app.endpoint}\n` +
            '  Playwright MCP attaches to this endpoint (--cdp-endpoint). pdkit does not connect to it.\n' +
            // Measured, 3 restarts out of 3: the server holds the page of the
            // application it first saw, and the call after a relaunch comes back
            // "Target page, context or browser has been closed". The one after
            // that succeeds. Said here because the error names nothing that is
            // actually wrong, and reads as "the app did not start".
            (launched.relaunch
              ? '  Relaunched: the first Playwright call after this will fail once with "Target page, context or\n' +
                '  browser has been closed". That is the server letting go of the old window — call it again.\n'
              : ''),
        );
      }
      return EXIT.OK;
    }

    case 'stop': {
      const stopped = await validation.stop({ issue, home, config: repo.config });
      if (!stopped.ok) {
        process.stderr.write(`pdkit validate stop: ${stopped.error}\n`);
        return EXIT.ERROR;
      }
      process.stdout.write(stopped.stopped ? 'stopped\n' : 'nothing was running\n');
      return EXIT.OK;
    }

    case 'attach': {
      const command = typeof flags.run === 'string' ? flags.run : null;
      const run = command ? await evidence.capture({ command, cwd: repo.root ?? process.cwd() }) : null;

      const attached = await validation.attach({
        issue,
        home,
        repoRoot: repo.root ?? undefined,
        title: typeof flags.title === 'string' ? flags.title : '',
        // `--requirement R1 --requirement R2`, and `--requirement "R1, R2"`. A
        // step usually demonstrates two or three, and naming only one meant the
        // rest were described in prose and traced by nobody.
        requirements: validation.requirementsOf(/** @type {string|string[]} */ (flags.requirement)),
        expected: typeof flags.expected === 'string' ? flags.expected : null,
        observed: typeof flags.observed === 'string' ? flags.observed : null,
        evidence: typeof flags.evidence === 'string' ? flags.evidence : null,
        run,
      });

      if (!attached.ok) {
        process.stderr.write(`pdkit validate attach: ${attached.error}\n`);
        return EXIT.ERROR;
      }

      if (flags.json) printJson(attached.step);
      else {
        process.stdout.write(`${attached.step.id} ${validation.statusOf(attached.step)} — ${attached.step.title}\n`);
        if (attached.step.evidence) process.stdout.write(`  evidence: ${attached.step.evidence.path}\n`);
        else process.stdout.write('  no artefact, so this step is unverified. Say so in Notes for reviewers\n');
      }
      return EXIT.OK;
    }

    case 'supersede': {
      const superseded = await validation.supersede({
        issue,
        home,
        step: typeof args[1] === 'string' && /^V\d+$/i.test(args[1]) ? args[1].toUpperCase() : '',
        by: typeof flags.by === 'string' ? flags.by.toUpperCase() : '',
        reason: typeof flags.reason === 'string' ? flags.reason : '',
      });

      if (!superseded.ok) {
        process.stderr.write(`pdkit validate supersede: ${superseded.error}\n`);
        return EXIT.ERROR;
      }

      if (flags.json) printJson(superseded);
      else {
        process.stdout.write(
          `${superseded.step.id} is set aside for ${superseded.by.id} — ${superseded.step.title}\n` +
            `  it stays in validation.md with its run and this reason; it no longer counts towards the outcome\n`,
        );
        // The one thing this command can lose, said out loud at the moment it
        // happens rather than found later in a coverage table.
        if (superseded.note) process.stdout.write(`  ${superseded.note}\n`);
      }
      return EXIT.OK;
    }

    case 'codify': {
      if (!repo.root || typeof flags.spec !== 'string') {
        process.stderr.write('pdkit validate codify: --spec <path> is required\n');
        return EXIT.ERROR;
      }

      const codified = await validation.codify({ issue, home, repoRoot: repo.root, spec: flags.spec });
      if (!codified.ok) {
        process.stderr.write(`pdkit validate codify: ${codified.error}\n`);
        return EXIT.ERROR;
      }

      process.stdout.write(`${codified.record.e2e.spec}\n  digest ${codified.digest}\n`);
      return EXIT.OK;
    }

    case 'run': {
      if (!repo.root) {
        process.stderr.write(`pdkit validate run: ${repo.problems.join('; ')}\n`);
        return EXIT.ERROR;
      }

      const ran = await validation.runSpec({
        issue,
        home,
        repoRoot: repo.root,
        config: repo.config,
        spec: typeof flags.spec === 'string' ? flags.spec : undefined,
        requirements: validation.requirementsOf(/** @type {string|string[]} */ (flags.requirement)),
      });

      if (!ran.ok) {
        process.stderr.write(`pdkit validate run: ${ran.error}\n`);
        return EXIT.ERROR;
      }

      // The step's evidence file is the capture, whole. What is printed is the
      // path to it, and the tail when it is red — see describeRun.
      process.stdout.write(`${ran.step.id} ${validation.statusOf(ran.step)}\n`);
      process.stdout.write(
        describeRun({ path: join(paths(home).issues, String(issue), ran.step.evidence.path), run: ran.run, digest: ran.step.evidence.digest }),
      );
      // A red run is recorded and reported; it is a fact about the change, and
      // the exit code says so without discarding the evidence.
      return ran.exitCode === 0 ? EXIT.OK : EXIT.ERROR;
    }

    case 'finish': {
      const finished = await validation.finish({ issue, home, stabilityRuns });

      if (flags.json) printJson(finished);
      else {
        process.stdout.write(`${validation.format(await validation.read(issue, { home }))}\n`);
        if (finished.path) process.stdout.write(`\n  written: ${finished.path}\n`);
        if (finished.moved) process.stdout.write('  issue moved to validated\n');
        if (finished.note) process.stdout.write(`  state unchanged: ${finished.note}\n`);
      }

      if (!finished.ok) {
        process.stderr.write(`pdkit validate finish: ${finished.error}\n`);
        return EXIT.ERROR;
      }
      return EXIT.OK;
    }

    default:
      process.stderr.write('pdkit validate: steps | launch | stop | attach | supersede | codify | run | finish\n');
      return EXIT.ERROR;
  }
}

/**
 * The stability series for a generated e2e test.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runE2e(args, flags) {
  if (args[0] !== 'stability') {
    process.stderr.write('pdkit e2e: stability --issue <n> [--runs <k>]\n');
    return EXIT.ERROR;
  }

  const issue = Number.parseInt(String(flags.issue ?? args[1]), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit e2e stability: --issue <n> is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  if (!repo.root) {
    process.stderr.write(`pdkit e2e stability: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const held = await requireIssueTree({ issue, repo, command: 'pdkit e2e stability', words: ['e2e', ...args], flags });
  if (!held.ok) return EXIT.ERROR;

  const runs = Number.parseInt(String(flags.runs), 10);
  const result = await validation.stability({
    issue,
    home: resolveHome({ repoRoot: repo.root }),
    repoRoot: repo.root,
    config: repo.config,
    runs: Number.isInteger(runs) ? runs : undefined,
  });

  // `last` is a capture, and a capture is what this used to print three times
  // over. --json gets the paths and digests, like everyone else.
  const { last, ...reported } = result;
  if (flags.json) printJson(reported);
  else {
    // A path, exit and digest per run. The series stops at the first red, so
    // only the last run can have a tail to show — describeRun decides that.
    for (const [index, entry] of (result.runs ?? []).entries()) {
      process.stdout.write(
        index === result.runs.length - 1 && last
          ? describeRun({ path: entry.path, run: last, digest: entry.digest })
          : `${entry.path}\n  exit ${entry.exitCode === null ? 'none — killed' : entry.exitCode}, ${entry.durationMs}ms, ${entry.digest}\n`,
      );
    }
    process.stdout.write(`\n${result.consecutive ?? 0} of ${result.wanted ?? '?'} consecutive green\n`);
    if (result.error) process.stdout.write(`  ${result.error}\n`);
  }

  return result.ok ? EXIT.OK : EXIT.ERROR;
}

/**
 * Facts about someone else's pull request, and the report they feed.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runReview(args, flags) {
  const [subcommand] = args;
  const number = Number.parseInt(String(args[1] ?? flags.pr), 10);

  if (!Number.isInteger(number)) {
    process.stderr.write('pdkit review: a pull request number is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);

  switch (subcommand) {
    case 'fetch': {
      if (!repo.root) {
        process.stderr.write(`pdkit review fetch: ${repo.problems.join('; ')}\n`);
        return EXIT.ERROR;
      }

      const report = await review.collect({ pr: number, repoRoot: repo.root, config: repo.config });
      if (flags.json) printJson(report);
      else process.stdout.write(review.format(report));
      // Always zero, for the same reason audit is: this reports, and an exit
      // code here would be a verdict the four axes have not reached yet.
      return EXIT.OK;
    }

    case 'render': {
      if (typeof flags.values !== 'string') {
        process.stderr.write('pdkit review render: --values <file.json> is required\n');
        return EXIT.ERROR;
      }

      const values = JSON.parse(await readFile(flags.values, 'utf8'));
      const written = await review.render({ pr: number, values, home: resolveHome({ repoRoot: repo.root ?? undefined }) });

      process.stdout.write(`${written.path}\n`);

      // The path is the answer; the window is a convenience. So it is asked
      // for, and a refusal to open is a note rather than a failure — the
      // report is written either way, and the exit code says so.
      if (flags.reveal) {
        const shown = await reveal(written.path);
        if (!shown.opened) process.stdout.write(`  (not opened: ${shown.reason})\n`);
      }

      return EXIT.OK;
    }

    default:
      process.stderr.write('pdkit review: fetch <k> | render <k> --values <file.json>\n');
      return EXIT.ERROR;
  }
}

/**
 * Entry point.
 *
 * @param {string[]} argv arguments after the executable name
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  const { command, args, flags } = parseArgs(argv);

  const askedForHelp = Boolean(flags.help || flags.h);
  if (askedForHelp || (!command && !flags.version)) {
    process.stdout.write(USAGE);
    // Asking for help succeeded; being given nothing to do did not.
    return askedForHelp || command ? EXIT.OK : EXIT.ERROR;
  }

  if (flags.version || command === 'version') {
    return await REGISTRY.version.run(args, flags);
  }

  // Before anything runs, and before anything is allocated. A flag this command
  // does not read has already failed — the only question is whether it fails
  // now, or silently, in the shape of a command that appeared to do what was
  // asked. Unknown COMMANDS have always been refused here; unknown flags were
  // not, and they are the half that reads as success.
  const unknown = unknownFlags(command, flags);
  if (unknown.length > 0) {
    // `--help` and its `-h` are left off the list. They are accepted here as
    // everywhere, and naming them in every refusal is a line of noise in the
    // one place somebody is scanning for a flag they meant to type.
    const accepted = [...COMMAND_FLAGS[command], 'json', 'repo'].sort().map((name) => `--${name}`);
    process.stderr.write(
      `pdkit ${command}: unknown flag${unknown.length === 1 ? '' : 's'} ` +
        `${unknown.map((entry) => `--${entry.name}${entry.suggestion ? ` (did you mean --${entry.suggestion}?)` : ''}`).join(', ')}\n` +
        `  ${command} takes ${accepted.join(', ')}\n`,
    );
    return EXIT.ERROR;
  }

  try {
    const entry = Object.hasOwn(REGISTRY, command) ? REGISTRY[command] : undefined;
    if (!entry) {
      process.stderr.write(`pdkit: unknown command "${command}"\n\n${USAGE}`);
      return EXIT.ERROR;
    }
    return await entry.run(args, flags);
  } catch (error) {
    // One place to turn an unexpected failure into a message and an exit code.
    // A stack trace on stdout would be read by whatever parsed --json.
    process.stderr.write(`pdkit ${command}: ${error.message}\n`);
    return EXIT.ERROR;
  }
}
