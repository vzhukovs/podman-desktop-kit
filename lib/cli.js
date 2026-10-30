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
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { AMENDMENT_STATUSES } from './artefacts.js';
import * as cost from './cost.js';
import { FAIL_CLOSED, HOOK_HANDLERS } from './hooks/events.js';
import * as knowledge from './knowledge.js';
import * as stats from './stats.js';
import { EXIT, LIB_DIR, PLUGIN_ROOT, counted, readVersion } from './commands/support.js';
import * as amendmentCommand from './commands/amendment.js';
import * as auditCommand from './commands/audit.js';
import * as branchCommand from './commands/branch.js';
import * as checkpointCommand from './commands/checkpoint.js';
import * as closeCommand from './commands/close.js';
import * as costCommand from './commands/cost.js';
import * as deferCommand from './commands/defer.js';
import * as doctorCommand from './commands/doctor.js';
import * as driftCommand from './commands/drift.js';
import * as e2eCommand from './commands/e2e.js';
import * as editorCommand from './commands/editor.js';
import * as findingsCommand from './commands/findings.js';
import * as gateCommand from './commands/gate.js';
import * as idsCommand from './commands/ids.js';
import * as initCommand from './commands/init.js';
import * as issueCommand from './commands/issue.js';
import * as journalCommand from './commands/journal.js';
import * as knowledgeCommand from './commands/knowledge.js';
import * as nextCommand from './commands/next.js';
import * as openCommand from './commands/open.js';
import * as packagesCommand from './commands/packages.js';
import * as planCommand from './commands/plan.js';
import * as prCommand from './commands/pr.js';
import * as preflightCommand from './commands/preflight.js';
import * as publishCommand from './commands/publish.js';
import * as receiptCommand from './commands/receipt.js';
import * as renderCommand from './commands/render.js';
import * as resetCommand from './commands/reset.js';
import * as reviewCommand from './commands/review.js';
import * as rollbackCommand from './commands/rollback.js';
import * as sliceCommand from './commands/slice.js';
import * as stateCommand from './commands/state.js';
import * as statsCommand from './commands/stats.js';
import * as taskCommand from './commands/task.js';
import * as validateCommand from './commands/validate.js';
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
  validate: validateCommand,
  e2e: e2eCommand,
  review: reviewCommand,
  knowledge: knowledgeCommand,
  preflight: preflightCommand,
  slice: sliceCommand,
  worktree: worktreeCommand,
  editor: editorCommand,
  open: openCommand,
  gate: gateCommand,
  pr: prCommand,
  // Nothing that skips, forces or extends: see runPublish.
  publish: publishCommand,
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
