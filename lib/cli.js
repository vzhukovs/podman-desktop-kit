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
import { constants as FS } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import * as active from './active.js';
import { AMENDMENT_STATUSES, checkPlan, parseAmendment, parsePlan, parseTask, setAmendmentStatus } from './artefacts.js';
import * as archaeology from './archaeology.js';
import * as attempts from './attempts.js';
import * as audit from './audit.js';
import * as backlog from './backlog.js';
import * as deferrals from './deferrals.js';
import { DEFAULTS_PATH, get, load, paths, resolveHome } from './config.js';
import { diagnose, format } from './doctor.js';
import * as drift from './drift.js';
import * as evidence from './evidence.js';
import * as gate from './gate.js';
import * as gh from './gh.js';
import { FAIL_CLOSED, HOOK_HANDLERS } from './hooks/events.js';
import * as ids from './ids.js';
import * as journal from './journal.js';
import * as knowledge from './knowledge.js';
import * as pr from './pr.js';
import * as preflight from './preflight/index.js';
import * as render from './render.js';
import * as reset from './reset.js';
import { buildPackageMap, fetchPullRequestHead, packageFor, pickScript, readPackageMap, resolveRepoRoot, scripts as repoScripts } from './repo.js';
import { reveal } from './reveal.js';
import * as review from './review.js';
import * as slice from './slice.js';
import * as state from './state.js';
import * as stats from './stats.js';
import * as threads from './threads.js';
import * as validation from './validation.js';
import * as worktree from './worktree.js';

const run = promisify(execFile);

/**
 * Create a branch, or check out the one that is already there.
 *
 * Not an error when it exists: re-running /pd:pr after fixing a preflight
 * failure is the normal case, and failing on the second run would make the
 * flow one-shot.
 *
 * @param {string} name
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, created: boolean, error?: string}>}
 */
async function createBranch(name, cwd) {
  try {
    await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd });
    await run('git', ['checkout', name], { cwd });
    return { ok: true, created: false };
  } catch {
    // Not there yet.
  }

  try {
    await run('git', ['checkout', '-b', name], { cwd });
    return { ok: true, created: true };
  } catch (error) {
    return { ok: false, created: false, error: String(error.stderr ?? error.message).trim() };
  }
}

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(LIB_DIR, '..');

/**
 * Exit codes. BLOCK is the one the hook protocol cares about: a hook that
 * exits 2 stops the tool call and feeds stderr back to the model.
 */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  BLOCK: 2,
};

/**
 * Every command the dispatcher accepts.
 *
 * Exported because skills tell the model to run these, and a skill naming a
 * command that does not exist fails at the worst moment — mid-flow, with the
 * model improvising a substitute. test/invariants.test.js checks the skills
 * against this list.
 */
export const COMMANDS = [
  'init',
  'doctor',
  'state',
  'ids',
  'journal',
  'packages',
  'issue',
  'branch',
  'render',
  'task',
  'receipt',
  'plan',
  'audit',
  'validate',
  'e2e',
  'review',
  'knowledge',
  'preflight',
  'slice',
  'worktree',
  'gate',
  'pr',
  'drift',
  'amendment',
  'defer',
  'findings',
  'close',
  'reset',
  'stats',
  'hook',
  'version',
];

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
  ids requirement|task|slice <issue>
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
  issue fetch <n>               read the upstream issue
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
  branch create --issue <n> --slug <s> [--index <i>]
  render <template> --issue <n> --values <file.json> [--path <p>]
                                fill a shipped template; without --path, print it
  render --check <template> --file <f>
                                every section the template declares is present
  task start --issue <n> --task <T1>
                                mark the task this working tree is executing
  task stop | task show         clear it; show what is running where
  task sync --issue <n>         read the Owns sets out of the task files, so the
                                pre-write hook guards what the plan agreed
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
  audit <issue> [--base main]   the facts /pd:audit works from; no verdict
  validate steps --issue <n>    what is waiting to be validated, and what is done
  validate launch --issue <n> [--port <p>] [--build]
                                start the built application with CDP on, and
                                print the endpoint Playwright MCP attaches to
  validate stop --issue <n>
  validate attach --issue <n> --title <t> [--expected <t>] [--observed <t>]
                  [--evidence <file>] [--run <command>] [--requirement R<k>]
                                record a step. There is no --status: the outcome
                                comes from what is attached, or is unverified
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
  preflight <issue> [--slice <i>] [--body <file>]
                                run the deterministic gates (section 7)
                  [--body-only] re-run only the checks that read the PR body
                  [--only a,b]  run just these checks
  slice suggest --issue <n> [--from-pr <k>]
                                the facts a slicer works from, plus a draft
                                grouped by layer. A draft, not a decision.
                                --from-pr slices an already-published pull
                                request instead of local work (scenario 13);
                                pdkit pr threads <k> then says which new slice
                                each existing review thread moves to
  slice set --issue <n> --from <f.json>
                                validate a proposal and store the graph
  slice show --issue <n>        the graph and what has been verified
  slice verify --issue <n> [--slice <i>] [--all] [--standalone]
                                build the slice and record what came back
  slice render --issue <n> [--values <f>]
                                slices.md from the graph; the verified columns
                                are not yours to type
  slice materialize --issue <n> --slice <i> --subject <s> [--force]
                                branch from the slice's base, apply it, commit
  slice cascade --issue <n> --from <i>
                                rebase what is stacked on it and verify again
  worktree create|list|remove [--issue <n>] [--name <n>] [--force]
                              [--slug <s> | --branch <b>] [--ref <r>]
                                create names the branch from the slug, so the
                                tree starts on the name preflight and the gate
                                will check. Without one the tree is detached and
                                says so — a branch is still needed before a push
  gate open --issue <n> (--branch <b> | --pr <k> --kind reply) [--ttl <10m>]
                                push tokens are for a branch and only from
                                preflight-green; reply tokens are for a pull
                                request, and cover the batch of drafts shown
  gate verify (--branch <b> | --pr <k> --kind reply)
  gate close (--branch <b> | --pr <k> --kind reply)
  gate revoke                   drop every outstanding token
  pr create --issue <n> --branch <b> --title <t> --body <file>
                                opens the pull request and records it
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
  pr render <k>                 prs/<k>.md from prs.json
  pr reply <k> --thread <id> --body <f> [--resolve]
                                needs a reply token for <k>
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
                                plan changes and the work continues against it
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
  stats [--limit <n>] [--author <login>]
                                what merged pull requests actually look like,
                                and where the guessed thresholds fall in that
                                distribution. Recommends nothing, writes nothing
  hook <event>                  run a hook handler; reads the payload on stdin
  version                       print the plugin version

Options:
  --json                        machine-readable output where supported
  --repo <path>                 act on this repository instead of the cwd
  -h, --help                    show this help

See docs/specification.md for the design, and docs/workflows.md for the scenarios.
`;

/**
 * Split argv into a command, positional arguments, and flags.
 *
 * @param {string[]} argv
 * @returns {{command: string|undefined, args: string[], flags: Record<string, string|boolean>}}
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
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
      flags[name] = argv[i + 1];
      i += 1;
    } else {
      flags[name] = true;
    }
  }

  return { command: args.shift(), args, flags };
}

/** Read the plugin version from package.json. */
async function readVersion() {
  const raw = await readFile(join(PLUGIN_ROOT, 'package.json'), 'utf8');
  return JSON.parse(raw).version;
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
    ({ handle: handler } = await import(join(LIB_DIR, 'hooks', handlerFile)));
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
  if (result?.message) process.stdout.write(`${result.message}\n`);
  return EXIT.OK;
}

/**
 * @param {unknown} value
 */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Resolve the repository every repo-aware command works on.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<{root: string|null, remotes: Record<string, string>, matches: boolean, problems: string[], config: import('./config.js').Config}>}
 */
async function repoContext(flags) {
  const cwd = typeof flags.repo === 'string' ? flags.repo : undefined;
  const config = await load({ repoRoot: cwd });
  return { ...(await resolveRepoRoot({ cwd, config })), config };
}

/**
 * Create $PDKIT_HOME and generate the package map.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
/** The `fork:` line in the shipped config, which is the only one init rewrites. */
const FORK_LINE = /^(\s*)fork:.*$/m;

/**
 * Fill `repo.fork` from the remote the clone already has.
 *
 * Reading it beats asking for it: `pdkit init` is run from inside the clone, so
 * the answer is one `git remote get-url` away, and a flag would make the user
 * retype a value they are standing in. The slug is written into
 * $PDKIT_HOME/config.yaml rather than into the repository, because that file is
 * the one every worktree shares — a `.pdkit.yaml` in the checkout is invisible
 * from the issue worktrees where the work actually happens.
 *
 * The line is rewritten in place rather than the file being regenerated: the
 * comments in defaults/config.yaml carry the reasoning for half the settings,
 * and a round-trip through the writer would drop every one of them.
 *
 * @param {{repo: {remotes: Record<string, string>, config: object}, config: string}} input
 * @returns {Promise<{ok: true, fork: string} | {ok: false, error: string}>}
 */
export async function adoptFork(input) {
  const remoteName = String(get(input.repo.config, 'repo.fork_remote') ?? 'origin');
  const upstream = get(input.repo.config, 'repo.upstream');
  const slug = input.repo.remotes[remoteName];

  if (!slug) {
    return { ok: false, error: `there is no "${remoteName}" remote to read the fork from — add one, or set repo.fork by hand` };
  }

  // Cloning upstream directly and calling it a fork is the mistake this guard
  // exists for. Accepting it would point every push at the project itself, and
  // the gate would be protecting a branch in somebody else's repository.
  if (slug === upstream) {
    return {
      ok: false,
      error:
        `"${remoteName}" is ${slug}, which is the upstream repository rather than a fork. ` +
        'Fork it on GitHub, point this remote at your fork, and add upstream as a second remote',
    };
  }

  const text = await readFile(input.config, 'utf8');
  if (!FORK_LINE.test(text)) {
    return { ok: false, error: `${input.config} has no "fork:" line to fill — set repo.fork by hand` };
  }

  await writeFile(input.config, text.replace(FORK_LINE, `$1fork: ${slug}`));
  return { ok: true, fork: slug };
}

async function runInit(flags) {
  const repo = await repoContext(flags);

  if (!repo.root) {
    process.stderr.write(`pdkit init: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }
  // A key with no value is what this command exists to fill, so it is not a
  // reason to refuse to run. A key with the WRONG value still is: initializing
  // against the wrong clone writes a package map for a workspace nothing else
  // will act on, and every later command inherits it.
  const disagrees = repo.problems.length > (repo.unset?.length ?? 0);

  if (!repo.matches && disagrees && !flags.force) {
    process.stderr.write(
      `pdkit init: ${repo.root} does not look like the configured fork\n` +
        repo.problems.map((problem) => `  - ${problem}\n`).join('') +
        '  use --force to initialize anyway\n',
    );
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: repo.root });
  const layout = paths(home);

  for (const dir of [layout.home, layout.issues, layout.gates, layout.journal, layout.reviews]) {
    await mkdir(dir, { recursive: true });
  }

  // Copied rather than serialized: the comments in defaults/config.yaml carry
  // the reasoning for several settings, and a round-trip through the writer
  // would drop every one of them.
  let configCreated = false;
  try {
    await copyFile(DEFAULTS_PATH, layout.config, flags.force ? 0 : FS.COPYFILE_EXCL);
    configCreated = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  // The clone knows whose fork it is. Asking for it on the command line would
  // be asking the user to read out a value they are standing inside.
  let fork = null;
  if ((repo.unset ?? []).includes('repo.fork')) {
    const adopted = await adoptFork({ repo, config: layout.config });
    if (!adopted.ok) {
      process.stderr.write(`pdkit init: ${adopted.error}\n`);
      return EXIT.ERROR;
    }
    fork = adopted.fork;
  }

  // Re-read: the package map is filed by layer, and the layers come from config.
  const config = fork ? await load({ repoRoot: repo.root, home }) : repo.config;
  const map = await buildPackageMap(repo.root, { home, config });

  // The key init just filled is no longer a problem to report.
  const warnings = repo.problems.filter((problem) => !fork || !problem.startsWith('repo.fork'));

  if (flags.json) {
    printJson({ home, repo: repo.root, configCreated, fork, packages: Object.keys(map.packages).length, warnings });
    return EXIT.OK;
  }

  process.stdout.write(
    `pdkit initialized\n` +
      `  repository  : ${repo.root}\n` +
      `  state home  : ${home}\n` +
      `  config      : ${layout.config}${configCreated ? ' (created)' : ' (kept)'}\n` +
      (fork ? `  fork        : ${fork} (read from the "${get(repo.config, 'repo.fork_remote')}" remote)\n` : '') +
      `  package map : ${Object.keys(map.packages).length} packages\n`,
  );
  for (const problem of warnings) process.stdout.write(`  warning     : ${problem}\n`);

  return EXIT.OK;
}

/**
 * Show a state record, or move the issue.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runState(args, flags) {
  const issue = Number.parseInt(args[0], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit state: an issue number is required\n');
    return EXIT.ERROR;
  }

  if (typeof flags.to === 'string') {
    const result = await state.transition(issue, /** @type {any} */ (flags.to), {
      reason: typeof flags.reason === 'string' ? flags.reason : undefined,
      approvedBy: typeof flags['approved-by'] === 'string' ? flags['approved-by'] : undefined,
      route: typeof flags.route === 'string' ? flags.route : undefined,
    });

    if (flags.json) printJson(result);
    if (!result.ok) {
      if (!flags.json) process.stderr.write(`pdkit state: ${result.error}\n`);
      return EXIT.ERROR;
    }
    if (!flags.json) {
      process.stdout.write(`issue ${issue}: ${result.from} -> ${result.to}\n`);
      // The line whose absence produced `/pd:implement`. What this used to print
      // was the state, and a state name is what gets typed as a command.
      const step = state.nextStep(/** @type {any} */ (result.record));
      if (step) process.stdout.write(`  next: ${step}\n`);
    }
    return EXIT.OK;
  }

  const record = await state.read(issue);
  if (flags.json) {
    printJson(record);
    return EXIT.OK;
  }

  const next = nextStates(record.state);
  const step = state.nextStep(record);
  process.stdout.write(
    `issue ${issue}\n` +
      `  state        : ${record.state}${record.createdAt ? '' : ' (nothing recorded yet)'}\n` +
      `  route        : ${record.route ?? '—'}\n` +
      `  requirements : ${record.requirements.ids.join(', ') || '—'}${record.requirements.frozen ? ' (frozen)' : ''}\n` +
      `  updated      : ${record.updatedAt ?? '—'}\n` +
      // Said here because everything downstream reads differently for an
      // adopted issue: no plan, no R-IDs and no receipts is what it looks like
      // when they were never produced, not when they went missing.
      (record.adopted
        ? `  adopted      : ${record.adopted.at.slice(0, 10)} at ${record.adopted.state ?? 'an earlier state'}` +
          `${record.adopted.pr ? `, #${record.adopted.pr}` : ''} — ${record.adopted.reason}\n` +
          // The state it was adopted AT, not the one it is in now: the record
          // moves on, and what stays true is which artefacts were never made.
          `                 the states before that were not passed; their artefacts do not exist\n`
        : '') +
      `  next         : ${next}\n` +
      // The state and the command are two different answers, and only one of
      // them can be run. Printed as separate lines because folding them made
      // the state read like something to type — which is how `/pd:implement`
      // came to be typed.
      (step ? `  run          : ${step}\n` : ''),
  );
  return EXIT.OK;
}

/**
 * Where an issue in this state may go next. Printed with the record so the
 * answer to "what now" does not require opening the spec.
 *
 * @param {string} from
 * @returns {string}
 */
function nextStates(from) {
  const allowed = state.TRANSITIONS[from] ?? [];
  return allowed.length ? allowed.join(', ') : 'nothing — this state is terminal';
}

/**
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runIds(args, flags) {
  const [kind, rawIssue] = args;

  if (kind === 'branch') {
    const issue = Number.parseInt(String(flags.issue), 10);
    if (!Number.isInteger(issue) || typeof flags.slug !== 'string') {
      process.stderr.write('pdkit ids branch: --issue and --slug are required\n');
      return EXIT.ERROR;
    }
    const index = flags.index === undefined ? undefined : Number.parseInt(String(flags.index), 10);
    process.stdout.write(`${ids.branchName({ issue, slug: flags.slug, index })}\n`);
    return EXIT.OK;
  }

  const issue = Number.parseInt(rawIssue, 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit ids: an issue number is required\n');
    return EXIT.ERROR;
  }

  const handlers = {
    requirement: () => ids.allocateRequirement(issue),
    task: () => ids.allocateTask(issue),
    slice: () => ids.allocateSlice(issue),
    freeze: () => ids.freezeRequirements(issue),
  };

  const handler = handlers[kind];
  if (!handler) {
    process.stderr.write(`pdkit ids: unknown kind "${kind ?? ''}"\n`);
    return EXIT.ERROR;
  }

  try {
    const value = await handler();
    if (flags.json) printJson({ issue, kind, value });
    else process.stdout.write(`${Array.isArray(value) ? value.join(', ') || '—' : value}\n`);
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`pdkit ids: ${error.message}\n`);
    return EXIT.ERROR;
  }
}

/**
 * The one entry a person adds by hand: a conflict, resolved.
 *
 * Guarded by the issue being known to the machine. A mistyped number would
 * otherwise write a real entry under an issue that has no record, and the
 * journal is append-only — there is nothing that takes it back.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runJournalConflict(flags) {
  const issue = Number.parseInt(String(flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit journal conflict: --issue <n> is required\n');
    return EXIT.ERROR;
  }

  const composed = journal.conflictEntry({
    kind: typeof flags.kind === 'string' ? flags.kind : '',
    file: typeof flags.file === 'string' ? flags.file : '',
    resolution: typeof flags.resolution === 'string' ? flags.resolution : '',
    commit: typeof flags.commit === 'string' ? flags.commit : null,
    amendment: typeof flags.amendment === 'string' ? flags.amendment : null,
  });

  if (!composed.ok) {
    process.stderr.write(`pdkit journal conflict: ${composed.error}\n`);
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const record = await state.read(issue, { home });
  if (record.history.length === 0) {
    process.stderr.write(
      `pdkit journal conflict: DESKTOP-${issue} is not in the machine — check the number, or start it with \`pdkit state ${issue} --to triaged\`\n`,
    );
    return EXIT.ERROR;
  }

  // Named for the module it must not shadow: `slice` at this scope is the
  // slicing module everywhere else in this file.
  const sliceIndex = flags.slice === undefined ? null : Number.parseInt(String(flags.slice), 10);
  if (sliceIndex !== null && !Number.isInteger(sliceIndex)) {
    process.stderr.write('pdkit journal conflict: --slice takes the slice number\n');
    return EXIT.ERROR;
  }

  const entry = await journal.append({ issue, slice: sliceIndex, event: composed.event, detail: composed.detail }, { home });

  if (flags.json) printJson(entry);
  else {
    process.stdout.write(`${journal.formatEntry(entry)}\n`);
    // Stated here rather than only in the skill: the entry is the record of a
    // decision, and a semantic conflict resolved without an amendment is the
    // plan quietly changing under the work it is meant to govern.
    if (composed.event === 'conflict-semantic' && typeof flags.amendment !== 'string') {
      process.stdout.write('  semantic, and no amendment cited — upstream rewrote what the plan stood on, so the plan is what has to move\n');
    }
  }

  return EXIT.OK;
}

/**
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runJournal(args, flags) {
  if (args[0] === 'conflict') return await runJournalConflict(flags);
  if (args.length > 0) {
    process.stderr.write(`pdkit journal: unknown action "${args[0]}" (conflict, or no action to read)\n`);
    return EXIT.ERROR;
  }

  const filter = {};
  if (flags.issue !== undefined) filter.issue = Number.parseInt(String(flags.issue), 10);
  if (typeof flags.since === 'string') {
    const since = journal.resolveSince(flags.since);
    if (!since.ok) {
      process.stderr.write(`pdkit journal: ${since.error}\n`);
      return EXIT.ERROR;
    }
    filter.since = since.at;
  }
  if (typeof flags.event === 'string') filter.event = flags.event;

  const entries = await journal.read(filter);

  if (flags.json) {
    printJson(entries);
    return EXIT.OK;
  }
  for (const entry of entries) process.stdout.write(`${journal.formatEntry(entry)}\n`);
  if (entries.length === 0) process.stdout.write('no entries\n');
  return EXIT.OK;
}

/**
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runPackages(flags) {
  let map;
  try {
    map = await readPackageMap();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    process.stderr.write('pdkit packages: no package map yet — run `pdkit init`\n');
    return EXIT.ERROR;
  }

  if (typeof flags.of === 'string') {
    const owner = await packageFor(flags.of, { map });
    if (flags.json) printJson(owner);
    else if (owner) process.stdout.write(`${owner.name}  ${owner.path}  layer:${owner.layer}\n`);
    else process.stdout.write(`no package owns ${flags.of}\n`);
    return owner ? EXIT.OK : EXIT.ERROR;
  }

  if (flags.json) {
    printJson(map);
    return EXIT.OK;
  }

  for (const layer of map.layers) {
    const members = Object.entries(map.packages).filter(([, entry]) => entry.layer === layer);
    if (members.length === 0) continue;
    process.stdout.write(`${layer}\n`);
    for (const [name, entry] of members) process.stdout.write(`  ${name}  (${entry.path})\n`);
  }
  return EXIT.OK;
}

/**
 * Read or escalate an upstream issue.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runIssue(args, flags) {
  const [action, rawIssue] = args;

  // Before the number is required: this one is about the backlog, and asking
  // it to name an issue would be asking it to answer itself.
  if (action === 'list') {
    const config = await load({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });

    const labels = typeof flags.label === 'string' ? flags.label.split(',').map((name) => name.trim()).filter(Boolean) : [];
    const report = await backlog.collect({
      labels,
      limit: typeof flags.limit === 'string' ? Number.parseInt(flags.limit, 10) : undefined,
      config,
    });

    if (flags.json) printJson(report);
    else process.stdout.write(backlog.format(report));
    // Zero whatever comes back. An empty backlog is an answer, and an exit code
    // here would be a verdict on issues this command deliberately does not judge.
    return EXIT.OK;
  }

  const issue = Number.parseInt(rawIssue, 10);

  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit issue: an issue number is required\n');
    return EXIT.ERROR;
  }

  if (action === 'fetch') {
    const config = await load({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
    const [record, linked] = await Promise.all([
      gh.fetchIssue(issue, { config }),
      gh.linkedPullRequests(issue, { config }),
    ]);

    if (flags.json) {
      printJson({ issue: record, linkedPullRequests: linked });
      return EXIT.OK;
    }

    process.stdout.write(
      `#${record.number} ${record.title}\n` +
        `  state    : ${record.state}${record.stateReason ? ` (${record.stateReason})` : ''}\n` +
        `  labels   : ${record.labels.map((label) => label.name).join(', ') || '—'}\n` +
        `  author   : ${record.author?.login ?? '—'}\n` +
        `  comments : ${record.comments?.length ?? 0}\n` +
        `  url      : ${record.url}\n`,
    );

    // Dedup before anything else: an open PR or a revert changes the route
    // before a single line of analysis is worth doing.
    if (linked.length === 0) process.stdout.write('  linked   : no pull requests reference this issue\n');
    for (const pr of linked) {
      process.stdout.write(
        `  linked   : #${pr.number} ${pr.state}${pr.isRevert ? ' [REVERT]' : ''} ${pr.title}\n`,
      );
    }

    return EXIT.OK;
  }

  if (action === 'history') {
    const repo = await repoContext(flags);
    const home = resolveHome({ repoRoot: repo.root ?? undefined });

    const report = await archaeology.collect({
      issue,
      repoRoot: repo.root,
      config: repo.config,
      home,
    });

    // Written before printing. This file is what lets the redo route leave
    // triage, and it must record the lookup that happened rather than the one
    // the reader believes happened.
    const path = await archaeology.save(report, { home });

    if (flags.json) printJson(report);
    else process.stdout.write(`${archaeology.format(report)}${path}\n`);

    // Zero even when nothing was found: "no previous attempt" is an answer, and
    // it is the one that says this is not a redo after all.
    return EXIT.OK;
  }

  if (action === 'adopt') {
    const target = typeof flags.state === 'string' ? flags.state : 'pr-open';
    const prNumber = typeof flags.pr === 'string' ? Number.parseInt(flags.pr, 10) : null;
    const branch = typeof flags.branch === 'string' ? flags.branch : null;
    const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });

    if (typeof flags.reason !== 'string' || flags.reason.trim() === '') {
      process.stderr.write(
        'pdkit issue adopt: --reason "<where this work came from>" is required.\n' +
          '  The states before this one were never passed, and this line is the only account of why.\n',
      );
      return EXIT.ERROR;
    }

    const adopted = await state.adopt(issue, {
      state: /** @type {any} */ (target),
      reason: flags.reason,
      pr: Number.isInteger(prNumber) ? prNumber : null,
      branch,
      route: typeof flags.route === 'string' ? flags.route : undefined,
      home,
    });

    if (!adopted.ok) {
      process.stderr.write(`pdkit issue adopt: ${adopted.error}\n`);
      return EXIT.ERROR;
    }

    // The pull request is recorded too, so the two files agree from the start.
    // An adopted issue whose PR the book does not know is the drift this
    // command exists to end.
    if (Number.isInteger(prNumber)) {
      await pr.register({ issue, number: prNumber, branch, home });
    }

    if (flags.json) printJson(adopted.record);
    else {
      process.stdout.write(
        `issue ${issue}: adopted at ${target}${Number.isInteger(prNumber) ? `, #${prNumber} recorded` : ''}\n` +
          `  No plan, requirements or receipts exist for it, and none are missing: they were never produced.\n` +
          `  Every check that reads them will say so rather than reporting a gap.\n`,
      );
    }
    return EXIT.OK;
  }

  if (action === 'rework') {
    if (typeof flags.reason !== 'string' || flags.reason.trim() === '') {
      process.stderr.write(
        'pdkit issue rework: --reason "<what the review rejected>" is required.\n' +
          '  The diff still exists and the pull request stays open; this line is the only record of why the\n' +
          '  work is being planned again.\n',
      );
      return EXIT.ERROR;
    }

    const result = await state.transition(issue, 'triaged', { reason: `rework: ${flags.reason.trim()}` });
    if (!result.ok) {
      process.stderr.write(`pdkit issue rework: ${result.error}\n`);
      return EXIT.ERROR;
    }

    process.stdout.write(
      `issue ${issue}: ${result.from} -> triaged, route cleared\n` +
        `  The pull request stays open and the branch stays where it is — what starts again is planning.\n` +
        `  Requirements are thawed: an objection to the approach is usually a requirement nobody wrote down.\n` +
        `  Existing R-IDs keep their numbers. Nothing renumbers, ever.\n`,
    );
    return EXIT.OK;
  }

  if (action === 'escalate') {
    const result = await state.transition(issue, 'triaged', {
      reason: typeof flags.reason === 'string' ? flags.reason : 'escalated from quickfix',
    });

    if (!result.ok) {
      process.stderr.write(`pdkit issue escalate: ${result.error}\n`);
      return EXIT.ERROR;
    }

    process.stdout.write(
      `issue ${issue}: ${result.from} -> triaged, route cleared\n` +
        'R-IDs are now allocated from the issue requirements, not from the diff you already wrote.\n',
    );
    return EXIT.OK;
  }

  process.stderr.write(`pdkit issue: unknown action "${action ?? ''}" (list, fetch, escalate)\n`);
  return EXIT.ERROR;
}

/**
 * Create the branch for an issue or a slice.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runBranch(args, flags) {
  if (args[0] !== 'create') {
    process.stderr.write(`pdkit branch: unknown action "${args[0] ?? ''}" (create)\n`);
    return EXIT.ERROR;
  }

  const issue = Number.parseInt(String(flags.issue), 10);
  if (!Number.isInteger(issue) || typeof flags.slug !== 'string') {
    process.stderr.write('pdkit branch create: --issue and --slug are required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  if (!repo.root) {
    process.stderr.write(`pdkit branch create: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const index = flags.index === undefined ? undefined : Number.parseInt(String(flags.index), 10);
  const name = ids.branchName({ issue, slug: flags.slug, index, config: repo.config });

  const created = await createBranch(name, repo.root);
  if (!created.ok) {
    process.stderr.write(`pdkit branch create: ${created.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson({ branch: name, created: created.created });
  else process.stdout.write(`${name}${created.created ? ' (created)' : ' (already existed, checked out)'}\n`);

  return EXIT.OK;
}

/**
 * Run the deterministic gates.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runPreflight(args, flags) {
  const issue = Number.parseInt(args[0], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit preflight: an issue number is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  if (!repo.root) {
    process.stderr.write(`pdkit preflight: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  // Four checks read the PR body, and it does not exist on the first pass.
  // They report skip-with-a-reason rather than pass; green on the second pass,
  // with --body, is what the gate is issued from (section 4).
  let prBody = null;
  if (typeof flags.body === 'string') {
    try {
      prBody = await readFile(flags.body, 'utf8');
    } catch (error) {
      process.stderr.write(`pdkit preflight: cannot read ${flags.body} (${error.code ?? error.message})\n`);
      return EXIT.ERROR;
    }
  }

  const context = await preflight.prepare({
    issue,
    slice: flags.slice === undefined ? undefined : Number.parseInt(String(flags.slice), 10),
    repoRoot: repo.root,
    prBody,
  });

  // A run that cannot look at the right diff does not run. Every check would
  // otherwise answer about whatever is checked out, and answer confidently.
  if (context.problem) {
    if (flags.json) printJson({ issue, ok: false, problem: context.problem, results: [] });
    else process.stderr.write(`pdkit preflight: ${context.problem}\n`);
    return EXIT.ERROR;
  }

  let only = null;
  if (flags['body-only']) {
    // Without a body these four skip, and four skips read as green. That is
    // exactly the shape of a second pass that proves nothing, so it is refused
    // rather than allowed to look like a pass.
    if (prBody === null) {
      process.stderr.write('pdkit preflight: --body-only needs --body <file>; without it these checks only skip\n');
      return EXIT.ERROR;
    }
    only = preflight.BODY_DEPENDENT;
  } else if (typeof flags.only === 'string') {
    only = flags.only.split(',').map((id) => id.trim());
  }

  let checks;
  try {
    checks = only === null ? null : await preflight.loadChecks(only);
  } catch (error) {
    process.stderr.write(`pdkit preflight: ${error.message}\n`);
    return EXIT.ERROR;
  }

  const report = await preflight.run(context, checks);

  if (flags.json) printJson({ issue, ok: report.ok, body: prBody !== null, results: report.results });
  else process.stdout.write(preflight.format(report));

  return report.ok ? EXIT.OK : EXIT.ERROR;
}

/**
 * The slice graph: propose it, store it, verify it, turn it into branches.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runSlice(args, flags) {
  const action = args[0];
  const issue = Number.parseInt(String(flags.issue ?? args[1]), 10);

  if (!Number.isInteger(issue)) {
    process.stderr.write(`pdkit slice ${action ?? ''}: --issue <n> is required\n`);
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  if (!repo.root) {
    process.stderr.write(`pdkit slice: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: repo.root });
  const shared = { issue, repoRoot: repo.root, home, config: repo.config };

  /**
   * Scenario 13: upstream asks for an already-published pull request to be
   * split. The slicer is unchanged — what changes is where the diff comes from,
   * and `--from-pr` gives it a local ref to read instead of HEAD.
   *
   * Both `suggest` and `set` need it. It used to be resolved inside `suggest`
   * alone, so a proposal drafted from a published pull request was then checked
   * against `main...HEAD` and refused file by file — the whole scenario broken
   * at its second step, found by dry-running it on #18434.
   *
   * @returns {Promise<{source: object, pr: number|null}>}
   */
  async function diffSource() {
    const pr = Number.parseInt(String(flags['from-pr']), 10);
    if (!Number.isInteger(pr)) return { source: {}, pr: null };

    const fetched = await fetchPullRequestHead({ pr, repoRoot: repo.root, config: repo.config });
    process.stderr.write(`  #${pr} fetched: ${fetched.ref.slice(0, 9)} branched from ${fetched.base.slice(0, 9)}\n`);

    return { source: { base: fetched.base, ref: fetched.ref, refName: `refs/pull/${pr}/head` }, pr };
  }

  if (action === 'suggest') {
    let packageMap;
    try {
      packageMap = await readPackageMap({ home });
    } catch {
      process.stderr.write('pdkit slice suggest: no package map; run pdkit init first\n');
      return EXIT.ERROR;
    }

    const { source, pr: fromPr } = await diffSource();

    const collected = await slice.facts({ ...shared, ...source, packageMap });
    const suggestion = { ...collected, draft: slice.draft(collected), fromPr };

    if (flags.json) printJson(suggestion);
    else {
      process.stdout.write(`${collected.files.length} changed file(s) ${collected.base}...${collected.refName ?? collected.ref}\n\n`);
      for (const file of collected.files) {
        process.stdout.write(`  ${file.layer.padEnd(14)} ${file.path}  ${file.requirements.join(',') || '—'}\n`);
      }
      process.stdout.write(
        '\nA draft grouped by layer is in --json. It is a draft: grouping is arithmetic, ' +
          'and whether a slice justifies itself alone is not.\n',
      );
    }
    return EXIT.OK;
  }

  if (action === 'set') {
    if (typeof flags.from !== 'string') {
      process.stderr.write('pdkit slice set: --from <file.json> is required\n');
      return EXIT.ERROR;
    }

    const proposal = JSON.parse(await readFile(flags.from, 'utf8'));
    const packageMap = await readPackageMap({ home });
    const { source } = await diffSource();
    const collected = await slice.facts({ ...shared, ...source, packageMap });
    const result = await slice.set({ ...shared, proposal, facts: collected });

    if (flags.json) printJson({ ok: result.ok, problems: result.problems, warnings: result.warnings, graph: result.graph });
    else {
      for (const problem of result.problems) process.stderr.write(`  ✘ ${problem.check}: ${problem.detail}\n`);
      for (const warning of result.warnings) process.stderr.write(`  ! ${warning.check}: ${warning.detail}\n`);
      if (result.ok) process.stdout.write(slice.format(result.graph));
      else process.stderr.write('\nnothing was stored: a graph is either whole or not a graph\n');
    }

    return result.ok ? EXIT.OK : EXIT.ERROR;
  }

  const graph = await slice.read(issue, { home });
  if (!graph) {
    process.stderr.write(`pdkit slice ${action}: issue ${issue} has no slice graph yet (pdkit slice set)\n`);
    return EXIT.ERROR;
  }

  if (action === 'show') {
    if (flags.json) printJson({ ...graph, problems: slice.independenceProblems(graph) });
    else {
      process.stdout.write(slice.format(graph));
      for (const problem of slice.independenceProblems(graph)) process.stdout.write(`  ✘ ${problem.detail}\n`);
    }
    return EXIT.OK;
  }

  if (action === 'verify') {
    const packageMap = await readPackageMap({ home });
    const standalone = Boolean(flags.standalone);

    if (flags.all || flags.slice === undefined) {
      const result = await slice.verifyAll({ ...shared, standalone, packageMap });
      if (flags.json) printJson(result);
      else {
        for (const entry of result.results) {
          process.stdout.write(`  ${entry.ok ? '✔' : '✘'} slice #${entry.index}${entry.error ? `  ${entry.error}` : ''}\n`);
        }
        for (const problem of result.problems) process.stdout.write(`  ✘ ${problem.detail}\n`);
      }
      return result.ok ? EXIT.OK : EXIT.ERROR;
    }

    const index = Number.parseInt(String(flags.slice), 10);
    const result = await slice.verifySlice({ ...shared, index, standalone, packageMap });

    if (flags.json) printJson(result);
    else {
      process.stdout.write(`slice #${index}: ${result.ok ? 'green' : 'RED'}\n`);
      if (result.error) process.stdout.write(`  ${result.error}\n`);
      if (result.verification?.evidence) process.stdout.write(`  the run is in ${result.verification.evidence} under the issue\n`);
    }
    return result.ok ? EXIT.OK : EXIT.ERROR;
  }

  if (action === 'render') {
    const values = typeof flags.values === 'string' ? JSON.parse(await readFile(flags.values, 'utf8')) : {};
    const path = await render.write({
      issue,
      template: 'slices',
      path: 'slices.md',
      home,
      values: { ...slice.renderValues(graph), ...values },
    });

    process.stdout.write(`${path}\n`);
    return EXIT.OK;
  }

  if (action === 'materialize') {
    const index = Number.parseInt(String(flags.slice), 10);
    if (!Number.isInteger(index)) {
      process.stderr.write('pdkit slice materialize: --slice <i> is required\n');
      return EXIT.ERROR;
    }

    const target = graph.slices.find((entry) => entry.index === index);
    const subject = typeof flags.subject === 'string' ? flags.subject : typeof flags.title === 'string' ? flags.title : null;
    if (!subject) {
      process.stderr.write(
        `pdkit slice materialize: --subject "<type>(<scope>): <description>" is required\n` +
          `  slice #${index} is titled: ${target?.title || '(untitled)'}\n`,
      );
      return EXIT.ERROR;
    }

    const result = await slice.materialize({ ...shared, index, subject, force: Boolean(flags.force) });
    if (!result.ok) {
      process.stderr.write(`pdkit slice materialize: ${result.error}\n`);
      return EXIT.ERROR;
    }

    if (flags.json) printJson(result);
    else process.stdout.write(`${result.branch} on ${result.base}${result.adopted ? ' (already matched the slice)' : ''}\n`);
    return EXIT.OK;
  }

  if (action === 'cascade') {
    const from = Number.parseInt(String(flags.from ?? flags.slice), 10);
    if (!Number.isInteger(from)) {
      process.stderr.write('pdkit slice cascade: --from <i> is required\n');
      return EXIT.ERROR;
    }

    const packageMap = await readPackageMap({ home });
    const result = await slice.cascade({ ...shared, from, packageMap });

    if (flags.json) printJson(result);
    else {
      process.stdout.write(`rebased: ${result.rebased.map((index) => `#${index}`).join(', ') || 'none'}\n`);
      if (result.conflicted.length) process.stdout.write(`conflicts: ${result.conflicted.map((index) => `#${index}`).join(', ')}\n`);
      if (result.regressed.length) {
        process.stdout.write(`NO LONGER GREEN: ${result.regressed.map((index) => `#${index}`).join(', ')}\n`);
      }
    }
    return result.ok ? EXIT.OK : EXIT.ERROR;
  }

  process.stderr.write(
    `pdkit slice: unknown action "${action ?? ''}" (suggest, set, show, verify, render, materialize, cascade)\n`,
  );
  return EXIT.ERROR;
}

/**
 * Working trees for parallel work.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runWorktree(args, flags) {
  const action = args[0];

  const repo = await repoContext(flags);
  if (!repo.root) {
    process.stderr.write(`pdkit worktree: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: repo.root });
  const issue = Number.parseInt(String(flags.issue), 10);
  const name = typeof flags.name === 'string' ? flags.name : Number.isInteger(issue) ? `DESKTOP-${issue}` : null;

  if (action === 'list') {
    const trees = await worktree.list(repo.root);
    if (flags.json) printJson(trees);
    else {
      for (const tree of trees) {
        process.stdout.write(`  ${tree.main ? '*' : ' '} ${tree.branch ?? '(detached)'}  ${tree.path}\n`);
      }
    }
    return EXIT.OK;
  }

  if (!name) {
    process.stderr.write(`pdkit worktree ${action ?? ''}: --issue <n> or --name <name> is required\n`);
    return EXIT.ERROR;
  }

  if (action === 'create') {
    // The branch is derived from the slug rather than typed, so the name the
    // tree is on is the name preflight and the gate will later check against.
    // Typing it by hand is how `DESKTOP-18778/wrap` and `DESKTOP-18778-wrap`
    // both come to exist for one issue.
    let branch = typeof flags.branch === 'string' ? flags.branch : undefined;
    if (!branch && typeof flags.slug === 'string' && Number.isInteger(issue)) {
      try {
        branch = ids.branchName({ issue, slug: flags.slug, config: repo.config });
      } catch (error) {
        process.stderr.write(`pdkit worktree create: ${error.message}\n`);
        return EXIT.ERROR;
      }
    }

    const result = await worktree.create({
      repoRoot: repo.root,
      name,
      ref: typeof flags.ref === 'string' ? flags.ref : undefined,
      branch,
      issue: Number.isInteger(issue) ? issue : undefined,
      config: repo.config,
      home,
    });

    if (!result.ok) {
      process.stderr.write(`pdkit worktree create: ${result.error}\n`);
      return EXIT.ERROR;
    }

    if (flags.json) printJson({ ...result, branch: branch ?? null });
    else {
      process.stdout.write(`${result.path}${result.created ? '' : ' (already there)'}\n`);
      if (branch) process.stdout.write(`  on ${branch}\n`);
      if (result.copied?.length) process.stdout.write(`  copied: ${result.copied.join(', ')}\n`);

      // Said here rather than left to preflight. A tree with no branch is a
      // legitimate thing to want — you may be looking around before naming the
      // work — so this does not refuse. But the cost of finding out later is
      // paid at the worst moment: preflight is the step before the gate, by
      // which point there are commits on a detached HEAD and the fix is a
      // branch plus an amend. Found on DESKTOP-18778, exactly that way.
      if (!branch && Number.isInteger(issue) && result.created) {
        process.stdout.write(
          '  detached, so there is no branch to push yet.\n' +
            `  \`pdkit worktree create --issue ${issue} --slug <slug>\` names one, or\n` +
            `  \`git checkout -b $(pdkit ids branch --issue ${issue} --slug <slug>)\` inside the tree.\n`,
        );
      }
    }
    return EXIT.OK;
  }

  if (action === 'remove') {
    const result = await worktree.remove({
      repoRoot: repo.root,
      name,
      force: Boolean(flags.force),
      issue: Number.isInteger(issue) ? issue : undefined,
      config: repo.config,
      home,
    });

    if (!result.ok) {
      process.stderr.write(`pdkit worktree remove: ${result.error}\n`);
      return EXIT.ERROR;
    }

    process.stdout.write(result.removed ? `${name} removed\n` : `${name} was not there\n`);
    return EXIT.OK;
  }

  process.stderr.write(`pdkit worktree: unknown action "${action ?? ''}" (create, list, remove)\n`);
  return EXIT.ERROR;
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
    const issue = Number.parseInt(String(flags.issue), 10);
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
const PR_ACTIONS = ['create', 'register', 'list', 'show', 'refresh', 'ci', 'threads', 'render', 'reply', 'merged', 'closed'];

/**
 * The issue a pull request is recorded under, when only the number is given.
 *
 * Scans the issues directory rather than asking GitHub: the answer is local, it
 * is the answer prs.json already holds, and a command that needed the network
 * to find out what it knows would be slower and wrong when offline.
 *
 * @param {number} number
 * @param {string} home
 * @returns {Promise<number|null>}
 */
async function issueOfPullRequest(number, home) {
  let entries;
  try {
    entries = await readdir(paths(home).issues);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const issue = Number.parseInt(entry, 10);
    if (!Number.isInteger(issue)) continue;

    const book = await pr.read(issue, { home });
    if (book?.prs.some((record) => record.number === number)) return issue;
  }

  return null;
}

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
    const issue = Number.parseInt(String(flags.issue), 10);
    if (!Number.isInteger(issue) || typeof flags.branch !== 'string' || typeof flags.title !== 'string' || typeof flags.body !== 'string') {
      process.stderr.write('pdkit pr create: --issue, --branch, --title and --body <file> are required\n');
      return EXIT.ERROR;
    }

    const body = await readFile(flags.body, 'utf8');

    // gh.createPullRequest verifies and spends the token itself. It is not
    // trusted from here: the Bash hook cannot see a child process, so this is
    // the only place that check can live for the plugin's own path.
    const result = await gh.createPullRequest({ head: flags.branch, title: flags.title, body, config, home });

    // Registered here rather than left to the flow. A pull request whose number
    // exists only in the transition reason is a pull request no later command
    // can find, and a step that can be forgotten is a step that will be.
    const graph = await slice.read(issue, { home });
    const index = graph?.slices.find((entry) => entry.branch === flags.branch)?.index ?? null;

    if (result.number) {
      await pr.register({
        issue,
        number: result.number,
        slice: index,
        branch: flags.branch,
        base: typeof flags.base === 'string' ? flags.base : null,
        url: result.url,
        home,
      });
    }

    const moved = await state.transition(issue, 'pr-open', { reason: `#${result.number} ${result.url}`, home });
    if (!moved.ok) {
      // The PR exists now; refusing to record it would leave the state machine
      // describing a world that is one pull request out of date.
      process.stderr.write(`pdkit pr create: opened ${result.url} but could not record it: ${moved.error}\n`);
    }

    if (flags.json) printJson(result);
    else process.stdout.write(`${result.url}\n`);

    return EXIT.OK;
  }

  if (action === 'list') {
    const wanted = Number.parseInt(String(flags.issue), 10);
    const issues = Number.isInteger(wanted)
      ? [wanted]
      : (await readdir(paths(home).issues).catch(() => []))
          .map((entry) => Number.parseInt(entry, 10))
          .filter((issue) => Number.isInteger(issue))
          .sort((a, b) => a - b);

    const rows = [];
    for (const issue of issues) {
      const book = await pr.read(issue, { home });
      for (const record of book?.prs ?? []) {
        rows.push({ issue, ...record, staleness: pr.staleness(record, { config }), reading: pr.reading(record) });
      }
    }

    if (flags.json) {
      printJson({ prs: rows });
    } else if (rows.length === 0) {
      process.stdout.write('no pull requests registered\n');
    } else {
      for (const row of rows) {
        const age = row.staleness.days === null ? '—' : `${row.staleness.days}d`;
        process.stdout.write(
          `  #${row.number}  DESKTOP-${row.issue}${row.slice === null ? '' : ` slice #${row.slice}`}  ${row.state}` +
            `  ci:${row.ci.verdict}  review:${row.review.decision ?? 'none'}` +
            `  threads:${row.review.threadsOpen}/${row.review.threadsTotal}  idle:${age}${row.staleness.stale ? ' STALE' : ''}` +
            // Who it is waiting on, when it is waiting on people. `ci:pending`
            // reads as "come back later"; this says come back after whom.
            `${waitingOn(row.review.domains)}` +
            // When this row was read. Every field to its left is local, and a
            // sweep costs 37 seconds, so nobody refreshes before every glance.
            `  read:${row.reading.label}${row.reading.old ? ' ←' : ''}\n`,
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

  const issue = Number.isInteger(Number.parseInt(String(flags.issue), 10))
    ? Number.parseInt(String(flags.issue), 10)
    : await issueOfPullRequest(number, home);

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
      process.stdout.write(`#${number} ${record.state}, review ${record.review.decision ?? 'undecided'}, ci ${record.ci.verdict}\n`);
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
            `  ${facts.unmapped.length} thread(s) map to no slice — either a requirement the plan missed, or a PR that did not explain itself\n`,
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
        ...pr.renderValues(record, { issue }),
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

async function runDrift(args, flags) {
  const issue = Number.parseInt(String(args[0] ?? flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit drift: an issue number is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  if (!repo.root) {
    process.stderr.write(`pdkit drift: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const report = await drift.collect({
    issue,
    repoRoot: repo.root,
    config: repo.config,
    home: resolveHome({ repoRoot: repo.root }),
    upstream: typeof flags.upstream === 'string' ? flags.upstream : undefined,
    // Both were reachable in the module and from nowhere else, so an issue
    // without a slice graph measured an empty set and said so as though it
    // were an answer.
    ref: typeof flags.ref === 'string' ? flags.ref : undefined,
    files: typeof flags.files === 'string' ? flags.files.split(',').map((name) => name.trim()).filter(Boolean) : undefined,
  });

  if (flags.json) printJson(report);
  else process.stdout.write(drift.format(report));

  return EXIT.OK;
}

/**
 * Render the findings artefact for an issue whose deliverable is an answer.
 *
 * The count of captures is produced here rather than accepted as a value, for
 * the reason the `Standalone` column is produced rather than typed: a number
 * that says how much evidence there is must come from the evidence. Everything
 * else in the template is prose, because everything else is judgement.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runFindings(args, flags) {
  if (args[0] !== undefined && args[0] !== 'new') {
    process.stderr.write(`pdkit findings: unknown action "${args[0]}" (new)\n`);
    return EXIT.ERROR;
  }

  const issue = Number.parseInt(String(flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit findings: --issue <n> is required\n');
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const values = typeof flags.values === 'string' ? JSON.parse(await readFile(flags.values, 'utf8')) : {};

  const captures = await readdir(join(paths(home).issues, String(issue), 'validation')).catch(() => []);
  const captureCount = captures.filter((name) => name.endsWith('.md')).length;

  const path = await render.write({
    issue,
    template: 'findings',
    path: 'findings.md',
    home,
    values: {
      issue,
      answer: '<one line: what the answer is>',
      ...values,
      captureCount,
      writtenAt: new Date().toISOString(),
    },
  });

  if (flags.json) printJson({ path, captureCount });
  else {
    process.stdout.write(`${path}\n`);
    process.stdout.write(
      captureCount === 0
        ? '  nothing is attached yet — a workaround nobody ran is a suggestion, and this file would be publishing one\n'
        : `  ${captureCount} capture(s) attached. Publishing is yours: the hook denies \`gh issue comment\` from every state\n`,
    );
  }

  return EXIT.OK;
}

/**
 * The host, in the shape upstream's bug form asks for.
 *
 * Auto-filled because it is a fact about the machine that just ran the thing,
 * and a field somebody types from memory is a field that says Ventura eighteen
 * months after they upgraded. The draft says it was auto-filled so it gets
 * corrected when the report is about a platform nobody checked.
 *
 * @returns {Promise<string>}
 */
async function describeHost() {
  const arch = process.arch === 'arm64' ? 'Apple silicon' : process.arch;

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run('sw_vers', ['-productVersion']);
      return `macOS ${stdout.trim()} (${arch})`;
    } catch {
      return `macOS (${arch})`;
    }
  }
  return `${process.platform} ${process.arch}`;
}

/**
 * The value upstream's Version dropdown wants.
 *
 * A tree built from source is "next (development version)" in that list, and
 * saying `1.30.0-next` instead would be a value the form does not offer.
 *
 * @param {string|null} repoRoot
 * @returns {Promise<string>}
 */
async function podmanDesktopVersion(repoRoot) {
  if (!repoRoot) return 'next (development version)';

  try {
    const { version } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    return /-next$/.test(String(version)) ? 'next (development version)' : String(version);
  } catch {
    return 'next (development version)';
  }
}

/**
 * A title for the follow-up issue.
 *
 * Derived from `--what` rather than asked for, because `--what` is already the
 * one-sentence statement of the thing, and a command that demanded both would
 * get the same sentence typed twice. `--title` overrides when the two genuinely
 * differ — a feature request is usually titled by what should exist, while
 * `--what` records what was set aside.
 *
 * Deliberately **not truncated**. Upstream titles run to a hundred characters
 * (`Since podman machine support is removed from Win10, the button 'Update to
 * v6' shouldnt displayed on Win10.`), and a title cut mid-clause says less than
 * a long one while looking finished. The draft is a file you edit; shortening is
 * a judgement, and this is not the place it gets made silently.
 *
 * @param {string} what
 * @returns {string}
 */
function titleFrom(what) {
  const text = String(what ?? '').trim().replace(/\s+/g, ' ').replace(/[.]+$/, '');
  if (!text) return '';

  // Only the first letter, and only when it is one. `kind cluster creation
  // fails…` is a real upstream title, and capitalising a command name would be
  // a change to what the sentence names rather than to how it is written.
  return /^[a-z]/.test(text) && !/^[a-z-]+ (cluster|machine|desktop)\b/.test(text)
    ? text[0].toUpperCase() + text.slice(1)
    : text;
}

/**
 * The screenshot block for a deferral draft.
 *
 * Every placeholder is **visible text**, never an HTML comment, and that is the
 * whole design of this function. A comment renders as nothing, so one left
 * unreplaced reaches the issue invisibly — the defect this repository has now
 * fixed three times elsewhere (the `Patch comes off` caveat, the config arrays
 * message, `steps-to-check`). Posted unreplaced, a line like this is obvious to
 * the author and to the reader.
 *
 * Files already captured under the issue are named, because knowing which file
 * to drag in is most of the work.
 *
 * @param {number} issue
 * @param {string} home
 * @returns {Promise<string>}
 */
async function screenshotPlaceholders(issue, home) {
  const dir = join(paths(home).issues, String(issue), 'evidence');
  const images = (await readdir(dir).catch(() => []))
    .filter((name) => /\.(png|jpe?g|gif|webp)$/i.test(name))
    .sort();

  if (images.length === 0) {
    return (
      '**[SCREENSHOT — replace this line, or delete it if there is nothing to show.\n' +
      'Drag the image into the GitHub comment box; it becomes its own `![…](…)` line.]**'
    );
  }

  return [
    `Captured under \`${dir}\` — drag each one in and delete the line it replaces:`,
    '',
    ...images.map((name, index) => `**[SCREENSHOT ${index + 1} — replace this line by dragging in \`${name}\`]**`),
  ].join('\n');
}

/**
 * Record what was set aside, list it, and say what settled it.
 *
 * The command exists because `/pd:pr-sync` has offered `defer` as one of four
 * ways to answer a review thread since it was written, and nothing recorded the
 * choice. See lib/deferrals.js for why the record lives in the journal rather
 * than on the issue.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runDefer(args, flags) {
  const action = args[0] ?? 'list';
  if (!['new', 'list', 'resolve', 'drop'].includes(action)) {
    process.stderr.write(`pdkit defer: unknown action "${action}" (new, list, resolve, drop)\n`);
    return EXIT.ERROR;
  }

  const issue = Number.parseInt(String(flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write(`pdkit defer ${action}: --issue <n> is required\n`);
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });

  if (action === 'list') {
    const found = flags.all ? await deferrals.list({ issue, home }) : await deferrals.open({ issue, home });

    if (flags.json) {
      printJson(found);
      return EXIT.OK;
    }

    process.stdout.write(`DESKTOP-${issue}\n`);
    if (found.length === 0) {
      process.stdout.write(flags.all ? '  nothing was deferred\n' : '  nothing outstanding\n');
      return EXIT.OK;
    }

    for (const entry of found) {
      const settled = entry.status === 'resolved' && entry.followUp ? `#${entry.followUp}` : entry.status;
      const from = [entry.raisedBy, entry.pr ? `#${entry.pr}` : ''].filter(Boolean).join(', ');
      process.stdout.write(`  ${entry.id}  ${settled.padEnd(9)} ${ageOf(entry.at).padStart(5)}   ${from}\n`);
      process.stdout.write(`      ${entry.what}\n`);
      if (entry.status === 'dropped') process.stdout.write(`      dropped: ${entry.outcome}\n`);
    }

    return EXIT.OK;
  }

  if (action === 'new') {
    // Resolved for the draft rather than for the record: the version field of
    // upstream's bug form comes from the repository being worked on.
    const repo = await repoContext(flags);
    const pr = flags.pr === undefined ? null : Number.parseInt(String(flags.pr), 10);
    if (pr !== null && !Number.isInteger(pr)) {
      process.stderr.write('pdkit defer new: --pr takes a pull request number\n');
      return EXIT.ERROR;
    }

    const record = await state.read(issue, { home });
    if (record.history.length === 0) {
      process.stderr.write(
        `pdkit defer new: DESKTOP-${issue} is not in the machine — check the number, or start it with \`pdkit state ${issue} --to triaged\`\n`,
      );
      return EXIT.ERROR;
    }

    const raisedBy = typeof flags['raised-by'] === 'string' ? flags['raised-by'] : '';
    const url = typeof flags.url === 'string' ? flags.url : '';
    const what = typeof flags.what === 'string' ? flags.what : '';

    // Validated before anything is allocated. Allocation is the one step here
    // that cannot be undone — the counter only goes up — so a command that
    // refuses after taking a number leaves a gap in the sequence, and a missing
    // D2 reads afterwards as a deferral somebody deleted.
    const composed = deferrals.deferredEntry({ id: 'D0', what, pr, raisedBy, url });
    if (!composed.ok) {
      process.stderr.write(`pdkit defer new: ${composed.error}\n`);
      return EXIT.ERROR;
    }

    // The ID reaches the journal entry and the draft together: a second D1 would
    // make the follow-up issue, the journal and the reply ambiguous at once.
    const id = await ids.allocateDeferral(issue, { home });

    const values = typeof flags.values === 'string' ? JSON.parse(await readFile(flags.values, 'utf8')) : {};

    // Which of upstream's issue forms this will be filed as. The draft is laid
    // out in that form's fields so it can be copied one field at a time into the
    // template in the GitHub UI, and the posted issue reads like every other one
    // in the repository rather than like something a tool generated.
    const kind = typeof flags.kind === 'string' ? flags.kind.toLowerCase() : 'bug';
    const template = { bug: 'deferralBug', feature: 'deferralFeature', task: 'deferralTask' }[kind];
    if (!template) {
      process.stderr.write(`pdkit defer new: --kind "${kind}" is not one of bug, feature, task\n`);
      return EXIT.ERROR;
    }

    const path = await render.write({
      issue,
      template,
      path: join('deferrals', `${id}.md`),
      home,
      repoRoot: repo.root ?? undefined,
      values: {
        id,
        issue,
        what,
        raisedBy: raisedBy || '—',
        where: pr ? `#${pr}` : '—',
        recordedAt: new Date().toISOString().slice(0, 10),
        quote: "<the reviewer's words, verbatim>",
        url: url || '',
        title: typeof flags.title === 'string' && flags.title.trim() ? flags.title.trim() : titleFrom(what),
        screenshots: await screenshotPlaceholders(issue, home),
        // Bug form.
        description: what,
        os: await describeHost(),
        installMethod: 'Other',
        version: await podmanDesktopVersion(repo.root),
        steps: '<numbered, each an action with an expected result>',
        logs: '<paste, do not summarise; leave empty if there is none>',
        additionalContext: '<anything else a reader needs>',
        // Feature form.
        problem: what,
        solution: '<what a person should see, not what the code should contain>',
        alternatives: '<including the rejected ones, and why>',
        // Task form.
        content: what,
        ...values,
      },
    });

    // The journal is written last, and the order is the whole point. It is
    // append-only, so a mistaken entry is not one anything takes back — while a
    // draft that failed to render can simply be rendered again. Writing the
    // entry first, which is what this did until a render error proved it, leaves
    // a deferral the journal knows about and no file to open.
    const written = await deferrals.defer({ issue, id, what, pr, raisedBy, url, home });
    if (!written.ok) {
      process.stderr.write(`pdkit defer new: ${written.error}\n`);
      return EXIT.ERROR;
    }

    if (flags.json) printJson({ id, issue, path, what });
    else {
      process.stdout.write(`${id}  DESKTOP-${issue}  deferred\n`);
      process.stdout.write(`  ${what}\n`);
      if (raisedBy || pr) process.stdout.write(`  raised by ${[raisedBy, pr ? `#${pr}` : ''].filter(Boolean).join(' on ')}\n`);
      process.stdout.write(`  ${path}\n\n`);
      process.stdout.write(
        '  Recorded, not resolved. The draft is for the follow-up issue; opening it is yours,\n' +
          '  and `gh issue create` is denied at the hook from every state.\n' +
          `  \`pdkit defer resolve ${id} --issue ${issue} --follow-up <n>\` once it exists.\n`,
      );
    }

    return EXIT.OK;
  }

  const followUp = action === 'resolve' ? Number.parseInt(String(flags['follow-up']), 10) : null;
  if (action === 'resolve' && !Number.isInteger(followUp)) {
    process.stderr.write('pdkit defer resolve: --follow-up <issue> is required — a deferral is settled by the issue that took it on\n');
    return EXIT.ERROR;
  }

  const settled = await deferrals.settle({
    issue,
    id: String(args[1] ?? ''),
    followUp: action === 'resolve' ? followUp : null,
    reason: typeof flags.reason === 'string' ? flags.reason : '',
    home,
  });

  if (!settled.ok) {
    process.stderr.write(`pdkit defer ${action}: ${settled.error}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson(settled.entry);
  else process.stdout.write(`${journal.formatEntry(settled.entry)}\n`);

  return EXIT.OK;
}

/** How long ago, in the units a person reads a backlog in. */
function ageOf(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (!Number.isFinite(days) || days < 0) return '—';
  if (days === 0) return 'today';
  return `${days}d`;
}

/**
 * Every amendment of an issue, read off disk in ID order.
 *
 * @param {number} issue
 * @param {string} home
 * @returns {Promise<Array<import('./artefacts.js').Amendment & {path: string}>>}
 */
async function readAmendments(issue, home) {
  const dir = join(paths(home).issues, String(issue), 'amendments');
  const names = (await readdir(dir).catch(() => [])).filter((name) => /^A\d+\.md$/.test(name));

  names.sort((a, b) => Number.parseInt(a.slice(1), 10) - Number.parseInt(b.slice(1), 10));

  const found = [];
  for (const name of names) {
    const path = join(dir, name);
    found.push({ ...parseAmendment(await readFile(path, 'utf8')), path });
  }
  return found;
}

/**
 * Approve or reject an amendment.
 *
 * The command `pdkit amendment new` has always ended by saying "nothing moves
 * until this is approved", and until now there was nothing that could approve
 * one. An instruction with no way to carry it out is worse than an absent one:
 * in review it reads as a discipline being kept, and on DESKTOP-18548 two
 * amendments sat `proposed` for six days with the work running against a plan
 * neither of them had changed.
 *
 * No state transition. An amendment does not move the issue — the plan becomes
 * what the amendment says and the work continues against it. What finds the work
 * done against the previous version is `pdkit audit`, which is its job.
 *
 * @param {string} action
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runAmendmentDecision(action, args, flags) {
  const issue = Number.parseInt(String(flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write(`pdkit amendment ${action}: --issue <n> is required\n`);
    return EXIT.ERROR;
  }

  const id = String(args[1] ?? '').trim().toUpperCase();
  if (!/^A\d+$/.test(id)) {
    process.stderr.write(`pdkit amendment ${action}: an amendment ID is required, such as A1\n`);
    return EXIT.ERROR;
  }

  // Required on reject and not on approve, and the asymmetry is the point: an
  // approved amendment is explained by the amendment itself, while a rejected
  // one leaves nothing behind except this sentence. Same rule as `task unblock`
  // and `issue adopt`.
  const reason = typeof flags.reason === 'string' ? flags.reason.trim() : '';
  if (action === 'reject' && !reason) {
    process.stderr.write(
      'pdkit amendment reject: --reason <why> is required — a rejected amendment is the only record of why the plan did not move\n',
    );
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const amendments = await readAmendments(issue, home);
  const found = amendments.find((entry) => entry.id === id);

  if (!found) {
    process.stderr.write(
      `pdkit amendment ${action}: DESKTOP-${issue} has no ${id}` +
        (amendments.length > 0 ? ` — it has ${amendments.map((entry) => entry.id).join(', ')}\n` : ' — and no amendments at all\n'),
    );
    return EXIT.ERROR;
  }

  const status = action === 'approve' ? 'approved' : 'rejected';
  if (found.status === status) {
    process.stderr.write(`pdkit amendment ${action}: ${id} is already ${status}\n`);
    return EXIT.ERROR;
  }
  if (found.status !== 'proposed') {
    process.stderr.write(
      `pdkit amendment ${action}: ${id} is ${found.status || 'in no recognised status'}, not proposed — ` +
        'a decision that has been taken is not retaken by a command\n',
    );
    return EXIT.ERROR;
  }

  const rewritten = setAmendmentStatus(await readFile(found.path, 'utf8'), status);
  if (rewritten === null) {
    process.stderr.write(`pdkit amendment ${action}: ${found.path} has no "- Status:" line to update\n`);
    return EXIT.ERROR;
  }
  await writeFile(found.path, rewritten);

  const by = typeof flags.by === 'string' ? flags.by.trim() : '';
  await journal.append(
    {
      issue,
      event: `amendment-${status}`,
      detail: [id, by ? `by ${by}` : '', reason].filter(Boolean).join(' — '),
    },
    { home },
  );

  if (flags.json) printJson({ id, issue, status, path: found.path });
  else {
    process.stdout.write(`${id}  DESKTOP-${issue}  ${status}\n`);
    if (reason) process.stdout.write(`  ${reason}\n`);
    process.stdout.write(`  ${found.path} updated\n`);
    if (status === 'approved') {
      process.stdout.write('  The plan is now what this says it is. Work done against the previous version is drift, and `pdkit audit` is what finds it.\n');
    }
  }

  return EXIT.OK;
}

/**
 * @param {number} issue
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runAmendmentList(issue, flags) {
  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const amendments = await readAmendments(issue, home);

  if (flags.json) {
    printJson(amendments.map(({ path, ...entry }) => ({ ...entry, path })));
    return EXIT.OK;
  }

  process.stdout.write(`DESKTOP-${issue}\n`);
  if (amendments.length === 0) {
    process.stdout.write('  no amendments\n');
    return EXIT.OK;
  }

  for (const entry of amendments) {
    process.stdout.write(`  ${entry.id}  ${(entry.status || '?').padEnd(9)} ${ageOf(entry.date).padStart(5)}   ${entry.source}\n`);
  }

  const waiting = amendments.filter((entry) => entry.status === 'proposed');
  if (waiting.length > 0) {
    process.stdout.write(
      `\n  ${waiting.length} awaiting approval. Nothing in the plan has moved: an amendment is a proposal\n` +
        '  until somebody says otherwise, and the work is still running against the plan as it was.\n',
    );
  }

  return EXIT.OK;
}

async function runAmendment(args, flags) {
  const action = args[0] ?? '';

  if (action === 'approve' || action === 'reject') return await runAmendmentDecision(action, args, flags);

  if (action === 'list') {
    const number = Number.parseInt(String(flags.issue), 10);
    if (!Number.isInteger(number)) {
      process.stderr.write('pdkit amendment list: --issue <n> is required\n');
      return EXIT.ERROR;
    }
    return await runAmendmentList(number, flags);
  }

  if (action !== 'new') {
    process.stderr.write(`pdkit amendment: unknown action "${action}" (new, list, approve, reject)\n`);
    return EXIT.ERROR;
  }

  const issue = Number.parseInt(String(flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit amendment new: --issue <n> is required\n');
    return EXIT.ERROR;
  }

  const home = resolveHome({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });
  const values = typeof flags.values === 'string' ? JSON.parse(await readFile(flags.values, 'utf8')) : {};

  // The number comes from the counter, not from the caller: an amendment is
  // referred to from the plan, the slices and the reply that told a reviewer
  // what changed, and a second A1 makes all three ambiguous.
  const id = await ids.allocateAmendment(issue, { home });
  const index = id.slice(1);

  const path = await render.write({
    issue,
    template: 'planAmendment',
    path: join('amendments', `${id}.md`),
    home,
    values: { issue, index, date: new Date().toISOString().slice(0, 10), status: 'proposed', ...values },
  });

  await journal.append({ issue, event: 'amendment-proposed', detail: `${id} — awaiting approval` }, { home });

  if (flags.json) printJson({ id, path });
  else {
    process.stdout.write(`${path}\n`);
    process.stdout.write('  nothing moves until this is approved — an amendment applied quietly makes the plan a record of what happened\n');
  }

  return EXIT.OK;
}

async function runClose(args, flags) {
  const issue = Number.parseInt(String(args[0] ?? flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit close: an issue number is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  const home = resolveHome({ repoRoot: repo.root ?? undefined });
  const config = repo.config;

  const record = await state.read(issue, { home });
  const summary = await pr.rollup(issue, { home });
  const entries = await journal.read({ issue }, { home });

  // Both the branch and the path are checked: a verify tree is detached and has
  // no branch at all, and it is named after the issue for exactly this reason.
  const trees = (repo.root ? await worktree.list(repo.root) : [])
    .filter((tree) => !tree.main)
    .filter((tree) => String(tree.branch ?? '').includes(`DESKTOP-${issue}`) || tree.path.includes(`DESKTOP-${issue}`));

  const facts = {
    issue,
    state: record.state,
    route: record.route,
    requirements: record.requirements.ids,
    pullRequests: summary,
    amendments: entries.filter((entry) => entry.event === 'amendment-proposed').map((entry) => entry.detail),
    // What the journal remembers and the code does not: why a slice ended up
    // stacked, which upstream commit forced an amendment, what went red.
    notable: entries
      .filter((entry) => ['slice-regressed', 'conflict-semantic', 'pr-closed', 'requirements-frozen'].includes(entry.event))
      .map((entry) => `${entry.event}: ${entry.detail}`),
    worktrees: trees.map((tree) => tree.path),
    // What was set aside and never settled. It belongs in the harvest for the
    // same reason the amendments do — it is a decision this issue produced that
    // outlives it — and it belongs in the human output because closing is the
    // last step, so this is the last moment anyone looks.
    deferred: await deferrals.open({ issue, home }),
  };

  if (flags.json) printJson(facts);
  else {
    process.stdout.write(`DESKTOP-${issue} is ${record.state}\n`);
    process.stdout.write(`  pull requests: ${summary.merged.length} merged, ${summary.open.length} open, ${summary.closed.length} closed\n`);
    for (const line of facts.notable) process.stdout.write(`  ${line}\n`);
    for (const entry of facts.deferred) {
      const from = [entry.raisedBy, entry.pr ? `#${entry.pr}` : ''].filter(Boolean).join(', ');
      process.stdout.write(`  deferred, still open: ${entry.id} — ${entry.what}${from ? ` (${from})` : ''}\n`);
    }
    for (const tree of facts.worktrees) process.stdout.write(`  worktree: ${tree}\n`);
  }

  if (!flags.finish) return EXIT.OK;

  // Two ways an issue finishes, and they are not the same fact. Code that
  // landed is a rollup over pull requests; an answer that settled it is a state
  // the machine only reaches over captured evidence (section 1). Sending the
  // second through the first is what produced "not finished — no pull request
  // was ever opened" about #18284, which was true and about nothing.
  const byAnswer = record.state === 'answered';

  if (!byAnswer && !summary.allMerged) {
    // The rollup is the only thing that may move an issue to a terminal state.
    // Upstream merges slices one at a time, and finishing on the first would
    // strand every slice after it.
    process.stderr.write(
      `pdkit close: DESKTOP-${issue} is not finished — ` +
        `${[...summary.open, ...summary.closed].map((entry) => `#${entry}`).join(', ') || 'no pull request was ever opened'}\n` +
        (summary.total === 0
          ? `  If the answer was the deliverable rather than a diff, the state for that is \`answered\`: ` +
            `pdkit state ${issue} --to answered --reason "<what the answer is>"\n`
          : ''),
    );
    return EXIT.ERROR;
  }

  if (byAnswer && !flags.confirmed) {
    // Answered means the findings are published and the reporter has not spoken
    // yet. Closing on our own say-so would make the plugin the judge of whether
    // someone else's problem went away — the same thing `awaiting-review`
    // refuses to do for domain owners.
    process.stderr.write(
      `pdkit close: DESKTOP-${issue} is answered, which means the findings are out and nobody has confirmed them yet.\n` +
        `  --confirmed says the reporter or a maintainer did: that is a fact about them, not a verdict of ours.\n` +
        `  If the answer implied product work instead, planning starts again: pdkit state ${issue} --to planned\n`,
    );
    return EXIT.ERROR;
  }

  // Warned about, and not refused. Closing is the last step, so there is no
  // later gate this could be caught at — which is an argument for blocking until
  // you notice the other half: a gate that is expensive to pass gets routed
  // around, and one standing between a finished issue and its terminal state
  // would be paid every time and earn its keep almost never. What actually keeps
  // the promise is that the journal is append-only, so the entry outlives the
  // state this transition is about to write.
  for (const entry of facts.deferred) {
    const from = [entry.raisedBy, entry.pr ? `#${entry.pr}` : ''].filter(Boolean).join(', ');
    process.stdout.write(
      `  ! ${entry.id} is still open, and closing does not settle it:\n` +
        `      ${entry.what}${from ? ` — ${from}` : ''}\n` +
        (entry.url ? `      ${entry.url}\n` : '') +
        `      \`pdkit defer resolve ${entry.id} --issue ${issue} --follow-up <n>\` when you open one.\n`,
    );
  }

  const moved = byAnswer
    ? await state.transition(issue, 'resolved', {
        reason: typeof flags.confirmed === 'string' ? flags.confirmed : 'the published answer settled it; no diff of ours did',
        home,
      })
    : await state.transition(issue, 'merged', { reason: `${summary.merged.length} pull request(s) merged`, home });
  if (!moved.ok) {
    process.stderr.write(`pdkit close: ${moved.error}\n`);
    return EXIT.ERROR;
  }

  for (const tree of facts.worktrees) {
    const removed = await worktree.remove({
      repoRoot: repo.root,
      name: tree.split('/').pop(),
      issue,
      config,
      home,
      force: Boolean(flags.force),
    });
    process.stdout.write(`  ${removed.ok ? 'removed' : 'kept'} ${tree}${removed.ok ? '' : ` — ${removed.error}`}\n`);
  }

  process.stdout.write(`DESKTOP-${issue} is ${byAnswer ? 'resolved — settled by the answer, not by a diff' : 'merged'}\n`);
  return EXIT.OK;
}

/**
 * Start one issue over.
 *
 * Shaped like `close`: bare, it reports and changes nothing; `--confirm` is the
 * word that acts. That is not symmetry for its own sake — the two commands are
 * the only ones that stand at a boundary where the thing being decided is
 * whether a cycle is over, and both are read by somebody who wants to see the
 * consequences before agreeing to them.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runReset(args, flags) {
  const issue = Number.parseInt(String(args[0] ?? flags.issue), 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit reset: an issue number is required\n');
    return EXIT.ERROR;
  }

  // Not fatal when there is no repository: three of the four stores live in
  // $PDKIT_HOME and can be cleared from anywhere. What is lost without one is
  // the worktree half, and that is said rather than assumed away.
  const repo = await repoContext(flags);
  const home = resolveHome({ repoRoot: repo.root ?? undefined });

  const facts = await reset.collect({ issue, repoRoot: repo.root, home });
  const purge = Boolean(flags.purge);
  const trees = Boolean(flags.worktrees);

  if (!flags.confirm) {
    if (flags.json) printJson({ ...facts, confirmed: false });
    else {
      process.stdout.write(reset.format(facts, { purge, worktrees: trees }));
      if (facts.anything) {
        process.stdout.write(
          `\n  Nothing has been done. To go ahead:\n` +
            `    pdkit reset ${issue} --confirm${purge ? ' --purge' : ''}${trees ? ' --worktrees' : ''}\n`,
        );
      }
      if (!repo.root) {
        process.stdout.write('  (no repository here, so worktrees were not looked at — run this from the fork to see them)\n');
      }
    }
    return EXIT.OK;
  }

  if (!facts.anything) {
    process.stdout.write(`DESKTOP-${issue}: nothing to clear\n`);
    return EXIT.OK;
  }

  if (trees && !repo.root) {
    process.stderr.write(`pdkit reset: --worktrees needs a repository — ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }

  const outcome = await reset.apply({
    issue,
    facts,
    repoRoot: repo.root,
    config: repo.config,
    home,
    purge,
    worktrees: trees,
    force: Boolean(flags.force),
  });

  if (flags.json) {
    printJson(outcome);
    return EXIT.OK;
  }

  process.stdout.write(
    `DESKTOP-${issue} was ${outcome.from}, and the plugin no longer has a record of it\n` +
      (outcome.removed
        ? outcome.archived
          ? `  archived    : ${outcome.archived}\n` + `                nothing reads it; \`mv\` it back over the issue directory to undo this\n`
          : '  purged      : the artefacts are gone\n'
        : '') +
      (outcome.tokens.length ? `  revoked     : ${outcome.tokens.join(', ')}\n` : '') +
      (outcome.active.length ? `  cleared     : ${outcome.active.join(', ')}\n` : ''),
  );

  for (const tree of outcome.worktrees) {
    process.stdout.write(`  ${tree.removed ? 'removed' : 'kept'}     : ${tree.path}${tree.removed ? '' : ` — ${tree.error}`}\n`);
  }
  // Reported after acting as well as before it. The dry run is the place this
  // is meant to be read, and the dry run is the step people skip.
  for (const tree of facts.worktrees.filter(() => !flags.worktrees)) {
    process.stdout.write(`  kept        : ${tree.path}${tree.branch ? ` (${tree.branch})` : ' (detached)'} — --worktrees removes it\n`);
  }
  if (facts.openPullRequests.length) {
    process.stdout.write(
      `  still open  : ${facts.openPullRequests.map((number) => `#${number}`).join(', ')} — upstream, and untouched by this\n`,
    );
  }

  process.stdout.write(
    `\n  The machine reads DESKTOP-${issue} as \`new\`, whose only exit is \`triaged\`:\n` +
      `    /pd:triage ${issue}\n` +
      `  The journal kept ${facts.journalEntries} entr${facts.journalEntries === 1 ? 'y' : 'ies'} from before this — \`pdkit journal --issue ${issue}\`.\n`,
  );

  return EXIT.OK;
}

/**
 * Fill a shipped template and write it under the issue.
 *
 * Values come from a file rather than the command line: a plan's context
 * section is paragraphs, and paragraphs in argv is how quoting bugs get into
 * artefacts nobody re-reads.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runRender(args, flags) {
  const template = args[0];

  // `render --check` reads an artefact back instead of writing one. It lives on
  // this command rather than its own because it answers a question about a
  // template, and the templates are what this command owns.
  if (flags.check) {
    const name = typeof flags.check === 'string' ? flags.check : template;
    const file = typeof flags.file === 'string' ? flags.file : args[1];

    if (!name || !file) {
      process.stderr.write('pdkit render --check <template> --file <path>\n');
      return EXIT.ERROR;
    }

    const result = await render.validateSections(name, await readFile(file, 'utf8'));
    if (flags.json) printJson({ template: name, file, ...result });
    else if (result.ok) process.stdout.write(`${file}: every section ${name} declares is present\n`);
    else process.stdout.write(`${file} is missing:\n${result.missing.map((section) => `  ${section}\n`).join('')}`);

    return result.ok ? EXIT.OK : EXIT.ERROR;
  }

  const issue = Number.parseInt(String(flags.issue), 10);

  if (!template || !Number.isInteger(issue) || typeof flags.values !== 'string') {
    process.stderr.write(
      'pdkit render: usage: pdkit render <template> --issue <n> --values <file.json> [--path <p>]\n' +
        `  templates: ${Object.keys(render.TEMPLATES).join(', ')}\n`,
    );
    return EXIT.ERROR;
  }

  let values;
  try {
    values = JSON.parse(await readFile(flags.values, 'utf8'));
  } catch (error) {
    process.stderr.write(`pdkit render: cannot read ${flags.values} (${error.message})\n`);
    return EXIT.ERROR;
  }

  const stripComments = Boolean(flags['strip-comments']);

  // Passed so the implicit values a template asks for are resolved against the
  // repository being worked on rather than against whatever the shell happens
  // to be standing in — the attribution footer reads the fork slug from there.
  const repo = await repoContext(flags);
  const repoRoot = repo.root ?? undefined;
  const home = resolveHome({ repoRoot });

  // No --path means print it. Rendering a PR body to look at it before
  // anything is written is the common case.
  if (typeof flags.path !== 'string') {
    process.stdout.write(await render.render(template, values, { stripComments, repoRoot, home }));
    return EXIT.OK;
  }

  const written = await render.write({ issue, template, path: flags.path, values, stripComments, repoRoot, home });
  process.stdout.write(`${written}\n`);
  return EXIT.OK;
}

/**
 * Mark, clear or show what a working tree is executing, and load the ownership
 * the pre-write hook enforces.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runTask(args, flags) {
  const action = args[0];
  const cwd = typeof flags.repo === 'string' ? flags.repo : process.cwd();

  if (action === 'show') {
    const running = await active.list();
    if (flags.json) {
      printJson(running);
      return EXIT.OK;
    }
    if (running.length === 0) {
      process.stdout.write('no task is running in any working tree\n');
      return EXIT.OK;
    }
    for (const entry of running) {
      process.stdout.write(`${entry.taskId}  issue ${entry.issue}  ${entry.worktree}  since ${entry.startedAt}\n`);
    }
    return EXIT.OK;
  }

  if (action === 'start') {
    const issue = Number.parseInt(String(flags.issue), 10);
    const taskId = typeof flags.task === 'string' ? flags.task : args[1];

    if (!Number.isInteger(issue) || !taskId) {
      process.stderr.write('pdkit task start: --issue and --task are required\n');
      return EXIT.ERROR;
    }

    const worktree = await active.worktreeFor(cwd);
    if (!worktree) {
      process.stderr.write(`pdkit task start: ${cwd} is not inside a git working tree\n`);
      return EXIT.ERROR;
    }

    const record = await state.read(issue);
    const owns = record.owns?.[taskId];

    // Before the pointer is written, not after. A blocked task that is already
    // marked active is a task the next agent picks up and retries, which is the
    // loop this refusal exists to break.
    const tried = await attempts.status({ issue, taskId, config: (await repoContext(flags)).config });
    if (tried.blocked) {
      process.stderr.write(`pdkit task start: ${attempts.blockedMessage({ issue }, tried)}\n`);
      return EXIT.ERROR;
    }

    const started = await active.start({ issue, taskId, worktree });

    if (flags.json) printJson({ ...started, owns: owns ?? [] });
    else {
      process.stdout.write(`${taskId} of issue ${issue} is running in ${worktree}\n`);
      // Said at the moment it can still be fixed. The hook allows everything
      // when the map is empty, so silence here would read as "guarded".
      if (!owns?.length) {
        process.stdout.write(`  no Owns set recorded — writes are unconstrained until \`pdkit task sync --issue ${issue}\`\n`);
      } else {
        for (const entry of owns) process.stdout.write(`  owns ${entry}\n`);
      }
    }
    return EXIT.OK;
  }

  if (action === 'stop') {
    const worktree = await active.worktreeFor(cwd);
    if (!worktree) {
      process.stderr.write(`pdkit task stop: ${cwd} is not inside a git working tree\n`);
      return EXIT.ERROR;
    }

    const stopped = await active.stop({ worktree });
    process.stdout.write(stopped.record ? `${stopped.record.taskId} stopped in ${worktree}\n` : `nothing was running in ${worktree}\n`);
    return EXIT.OK;
  }

  if (action === 'sync') {
    const issue = Number.parseInt(String(flags.issue), 10);
    if (!Number.isInteger(issue)) {
      process.stderr.write('pdkit task sync: --issue is required\n');
      return EXIT.ERROR;
    }

    const dir = join(paths(resolveHome()).issues, String(issue), 'tasks');
    let entries;
    try {
      entries = (await readdir(dir)).filter((name) => /^T\d+\.md$/.test(name)).sort();
    } catch {
      process.stderr.write(`pdkit task sync: issue ${issue} has no tasks/ directory yet\n`);
      return EXIT.ERROR;
    }

    const synced = [];
    for (const entry of entries) {
      const parsed = parseTask(await readFile(join(dir, entry), 'utf8'));
      if (!parsed.id) continue;
      // The task file is the authority: it comes from the plan, so the hook
      // guards what was agreed rather than what somebody typed at a prompt.
      await state.setOwns(issue, parsed.id, parsed.owns);
      synced.push({ task: parsed.id, owns: parsed.owns });
    }

    if (flags.json) printJson(synced);
    else {
      for (const entry of synced) process.stdout.write(`${entry.task}  ${entry.owns.join(', ') || 'owns nothing'}\n`);
      if (synced.length === 0) process.stdout.write('no task files to read\n');
    }
    return EXIT.OK;
  }

  if (action === 'attempts') {
    const issue = Number.parseInt(String(flags.issue ?? args[1]), 10);
    if (!Number.isInteger(issue)) {
      process.stderr.write('pdkit task attempts: --issue is required\n');
      return EXIT.ERROR;
    }

    const config = (await repoContext(flags)).config;
    const taskId = typeof flags.task === 'string' ? flags.task : null;
    const report = taskId ? [await attempts.status({ issue, taskId, config })] : await attempts.all({ issue, config });

    if (flags.json) {
      printJson(report);
      return EXIT.OK;
    }

    if (report.length === 0) {
      process.stdout.write(`issue ${issue}: no task has failed a capture\n`);
      return EXIT.OK;
    }

    for (const entry of report) {
      process.stdout.write(
        `${entry.taskId}  ${entry.attempts}${entry.max > 0 ? `/${entry.max}` : ''} failed capture(s)` +
          `${entry.blocked ? '  BLOCKED' : ''}${entry.since ? `  counting from ${entry.since}` : ''}\n`,
      );
      for (const detail of entry.details) process.stdout.write(`    ${detail}\n`);
    }
    return EXIT.OK;
  }

  if (action === 'unblock') {
    const issue = Number.parseInt(String(flags.issue), 10);
    const taskId = typeof flags.task === 'string' ? flags.task : args[1];

    if (!Number.isInteger(issue) || !taskId) {
      process.stderr.write('pdkit task unblock: --issue and --task are required\n');
      return EXIT.ERROR;
    }

    // Required, never defaulted. An unblock with no reason is the rubber stamp
    // the ceiling exists to interrupt, and this is the only record of why
    // anyone expected the next attempt to go differently.
    if (typeof flags.reason !== 'string' || flags.reason.trim() === '') {
      process.stderr.write(
        'pdkit task unblock: --reason "<what is different this time>" is required.\n' +
          '  Not ceremony: the count restarts here, and in six weeks this line is the only thing that says\n' +
          '  whether the plan changed or somebody just wanted the loop to continue.\n',
      );
      return EXIT.ERROR;
    }

    await attempts.unblock({ issue, taskId, reason: flags.reason.trim() });
    process.stdout.write(`${taskId} of issue ${issue} may be attempted again; the count restarts\n`);
    return EXIT.OK;
  }

  process.stderr.write(`pdkit task: unknown action "${action ?? ''}" (start, stop, show, sync, attempts, unblock)\n`);
  return EXIT.ERROR;
}

/**
 * Produce or check a receipt.
 *
 * `write` takes no output parameter, and that absence is the enforcement: the
 * command from `Done when` is run here, so "summarise the run convincingly" is
 * not a path that exists.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runReceipt(args, flags) {
  const action = args[0];
  const issue = Number.parseInt(String(flags.issue), 10);
  const taskId = typeof flags.task === 'string' ? flags.task : args[1];

  if (!Number.isInteger(issue) || !taskId) {
    process.stderr.write(`pdkit receipt ${action ?? ''}: --issue and --task are required\n`);
    return EXIT.ERROR;
  }

  const home = resolveHome();
  const receiptPath = join(paths(home).issues, String(issue), 'receipts', `${taskId}.md`);

  if (action === 'check') {
    let content;
    try {
      content = await readFile(receiptPath, 'utf8');
    } catch {
      process.stderr.write(`pdkit receipt check: ${taskId} of issue ${issue} has no receipt\n`);
      return EXIT.ERROR;
    }

    const checked = evidence.validateReceipt(content);
    if (flags.json) printJson({ path: receiptPath, ...checked });
    else process.stdout.write(checked.ok ? `${taskId}: a real capture of \`${checked.command}\`, exit ${checked.exitCode}\n` : `${taskId}: ${checked.reason}\n`);

    return checked.ok ? EXIT.OK : EXIT.ERROR;
  }

  if (action !== 'write') {
    process.stderr.write(`pdkit receipt: unknown action "${action ?? ''}" (write, check)\n`);
    return EXIT.ERROR;
  }

  const taskPath = join(paths(home).issues, String(issue), 'tasks', `${taskId}.md`);
  let task;
  try {
    task = parseTask(await readFile(taskPath, 'utf8'));
  } catch {
    process.stderr.write(`pdkit receipt write: ${taskPath} does not exist — the command to run comes from the task's \`Done when\`\n`);
    return EXIT.ERROR;
  }

  if (!task.command) {
    process.stderr.write(
      `pdkit receipt write: ${taskId} has no executable \`Done when\`. Prose cannot be run, and a task ` +
        `whose completion cannot be demonstrated is a planning error — amend the plan rather than the receipt.\n`,
    );
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  const cwd = repo.root ?? process.cwd();

  process.stdout.write(`$ ${task.command}\n`);
  const captured = await evidence.capture({ command: task.command, cwd });
  process.stdout.write(captured.stdout);
  process.stderr.write(captured.stderr);

  const written = await evidence.writeReceipt({
    issue,
    taskId,
    run: captured,
    commit: await headSha(cwd),
    files: task.owns,
  });

  process.stdout.write(
    `\n${written.path}\n` +
      `  exit ${captured.exitCode === null ? 'none — killed' : captured.exitCode}, ${captured.durationMs}ms, ${written.digest}\n`,
  );

  // The attempt is counted from the same capture the receipt is made of. There
  // is no input for it, for the reason there is no input for the receipt text.
  if (captured.exitCode === 0) {
    await attempts.passed({ issue, taskId });
  } else {
    const state = await attempts.record({ issue, taskId, exitCode: captured.exitCode, config: repo.config });

    process.stdout.write(
      state.blocked
        ? `\n${attempts.blockedMessage({ issue }, state)}\n`
        : `  attempt ${state.attempts}${state.max > 0 ? ` of ${state.max}` : ''}\n`,
    );
  }

  // Non-zero is reported, not hidden: the receipt is valid either way, and the
  // caller needs to know which of the two it just produced.
  return captured.exitCode === 0 ? EXIT.OK : EXIT.ERROR;
}

/**
 * The commit a receipt was taken at, or null outside a repository.
 *
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function headSha(cwd) {
  try {
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * What the guessed thresholds look like against the population they are about.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runStats(args, flags) {
  const config = await load({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });

  const report = await stats.collect({
    limit: typeof flags.limit === 'string' ? Number.parseInt(flags.limit, 10) : undefined,
    author: typeof flags.author === 'string' ? flags.author : undefined,
    config,
  });

  if (flags.json) printJson(report);
  else process.stdout.write(stats.format(report));

  // Zero always: a distribution is not a pass or a fail, and an exit code here
  // would be the recommendation this command refuses to make.
  return EXIT.OK;
}

/**
 * The mechanical half of a plan review.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runPlan(args, flags) {
  if (args[0] !== 'check') {
    process.stderr.write(`pdkit plan: unknown action "${args[0] ?? ''}" (check)\n`);
    return EXIT.ERROR;
  }

  const issue = Number.parseInt(args[1], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit plan check: an issue number is required\n');
    return EXIT.ERROR;
  }

  const path = join(paths(resolveHome()).issues, String(issue), 'plan.md');
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    process.stderr.write(`pdkit plan check: ${path} does not exist\n`);
    return EXIT.ERROR;
  }

  const record = await state.read(issue);
  const result = await checkPlan({ plan: parsePlan(content), content, record });

  // Which plan this verdict is about, and how old it is. `plan.md` is rendered
  // and then edited by hand, and a planning run that fails to persist leaves the
  // previous one in place — after which a green here is a statement about
  // yesterday that reads exactly like one about the plan just written. Measured
  // on 18832: a run whose every write was denied left the superseded plan on
  // disk, and this command reported `passes` for it without naming what it read.
  //
  // The same principle as the base ref in preflight (section 7) and `read:<age>`
  // on the dashboard (section 4): a measurement has to say what it saw. No
  // threshold and no warning — a plan is allowed to be old, and inventing a
  // staleness rule here would price a gate where there is no risk.
  const written = await stat(path)
    .then((entry) => pr.reading({ refreshedAt: entry.mtime.toISOString() }))
    .catch(() => null);

  if (flags.json) {
    printJson({ issue, path, writtenAt: written?.at ?? null, writtenAge: written?.label ?? null, ...result });
    return result.ok ? EXIT.OK : EXIT.ERROR;
  }

  process.stdout.write(`plan check: issue ${issue} — ${result.ok ? 'passes' : `${result.problems.length} problem(s)`}\n`);
  if (written) {
    process.stdout.write(`  plan  ${path}, written ${written.label === 'just now' ? 'just now' : `${written.label} ago`}\n`);
  }
  for (const problem of result.problems) process.stdout.write(`  ✘ ${problem.check.padEnd(16)} ${problem.detail}\n`);
  for (const warning of result.warnings) process.stdout.write(`  ! ${warning.check.padEnd(16)} ${warning.detail}\n`);
  process.stdout.write(
    result.ok
      ? '\nThe mechanical checks pass. What is left is the question no grep answers:\nis this task necessary at all, and does something already do it?\n'
      : '\nThese get a plan redone rather than patched.\n',
  );

  return result.ok ? EXIT.OK : EXIT.ERROR;
}

/**
 * Collect the facts an audit works from.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runAudit(args, flags) {
  const issue = Number.parseInt(args[0], 10);
  if (!Number.isInteger(issue)) {
    process.stderr.write('pdkit audit: an issue number is required\n');
    return EXIT.ERROR;
  }

  const repo = await repoContext(flags);
  const report = await audit.collect({
    issue,
    repoRoot: repo.root ?? undefined,
    config: repo.config,
    base: typeof flags.base === 'string' ? flags.base : undefined,
    ref: typeof flags.ref === 'string' ? flags.ref : undefined,
  });

  if (flags.json) printJson(report);
  else process.stdout.write(audit.format(report));

  // Always zero. This command reports; deciding whether the findings matter is
  // what pd-auditor is for, and an exit code here would be a verdict.
  return EXIT.OK;
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
        requirement: typeof flags.requirement === 'string' ? flags.requirement : null,
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
        requirement: typeof flags.requirement === 'string' ? flags.requirement : null,
      });

      if (!ran.ok) {
        process.stderr.write(`pdkit validate run: ${ran.error}\n`);
        return EXIT.ERROR;
      }

      process.stdout.write(ran.output ?? '');
      process.stdout.write(`\n${ran.step.id} ${validation.statusOf(ran.step)} — ${ran.step.evidence.path}\n`);
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
      process.stderr.write('pdkit validate: steps | launch | stop | attach | codify | run | finish\n');
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

  const runs = Number.parseInt(String(flags.runs), 10);
  const result = await validation.stability({
    issue,
    home: resolveHome({ repoRoot: repo.root }),
    repoRoot: repo.root,
    config: repo.config,
    runs: Number.isInteger(runs) ? runs : undefined,
  });

  if (flags.json) printJson(result);
  else {
    if (result.output) process.stdout.write(result.output);
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
 * Revision of the shipped knowledge base.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runKnowledge(args, flags) {
  const repo = await repoContext(flags);
  const home = resolveHome({ repoRoot: repo.root ?? undefined });

  switch (args[0]) {
    case 'check': {
      const report = await knowledge.collect({ repoRoot: repo.root ?? null, config: repo.config, home });
      if (flags.json) printJson(report);
      else process.stdout.write(knowledge.format(report));
      // Zero even with findings: they are facts for a revision the user makes.
      return EXIT.OK;
    }

    case 'export': {
      const entries = await knowledge.exportEntries();
      if (flags.json) printJson(entries);
      else {
        for (const entry of entries) process.stdout.write(`${entry.name}\t${entry.title}\t${entry.sections.length} section(s)\n`);
        process.stdout.write(
          '\nThe bridge is one way (section 8): pdkit prints, the skill writes.\n' +
            'There is no import — a second source of truth would drift from these files.\n',
        );
      }
      return EXIT.OK;
    }

    default:
      process.stderr.write('pdkit knowledge: check | export\n');
      return EXIT.ERROR;
  }
}

/**
 * Environment check.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runDoctor(flags) {
  const version = await readVersion();
  const report = await diagnose({
    cwd: typeof flags.repo === 'string' ? flags.repo : undefined,
    pluginRoot: PLUGIN_ROOT,
    gateSelftest: Boolean(flags['gate-selftest']),
  });

  if (flags.json) printJson({ version, pluginRoot: PLUGIN_ROOT, ...report });
  else process.stdout.write(format(report, { version }));

  // Warnings do not fail the check. They are things to know, not things that
  // stop pdkit from working, and a doctor that exits non-zero on every
  // optional gap stops being run.
  return report.status === 'fail' ? EXIT.ERROR : EXIT.OK;
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
    process.stdout.write(`${await versionLine()}\n`);
    return EXIT.OK;
  }

  try {
    switch (command) {
      case 'init':
        return await runInit(flags);
      case 'doctor':
        return await runDoctor(flags);
      case 'state':
        return await runState(args, flags);
      case 'ids':
        return await runIds(args, flags);
      case 'journal':
        return await runJournal(args, flags);
      case 'packages':
        return await runPackages(flags);
      case 'issue':
        return await runIssue(args, flags);
      case 'branch':
        return await runBranch(args, flags);
      case 'render':
        return await runRender(args, flags);
      case 'task':
        return await runTask(args, flags);
      case 'receipt':
        return await runReceipt(args, flags);
      case 'plan':
        return await runPlan(args, flags);
      case 'audit':
        return await runAudit(args, flags);
      case 'validate':
        return await runValidate(args, flags);
      case 'e2e':
        return await runE2e(args, flags);
      case 'review':
        return await runReview(args, flags);
      case 'knowledge':
        return await runKnowledge(args, flags);
      case 'preflight':
        return await runPreflight(args, flags);
      case 'slice':
        return await runSlice(args, flags);
      case 'worktree':
        return await runWorktree(args, flags);
      case 'gate':
        return await runGate(args, flags);
      case 'pr':
        return await runPr(args, flags);
      case 'drift':
        return await runDrift(args, flags);
      case 'defer':
        return await runDefer(args, flags);
      case 'amendment':
        return await runAmendment(args, flags);
      case 'findings':
        return await runFindings(args, flags);
      case 'close':
        return await runClose(args, flags);
      case 'reset':
        return await runReset(args, flags);
      case 'stats':
        return await runStats(args, flags);
      case 'hook':
        if (!args[0]) {
          process.stderr.write('pdkit: hook requires an event name\n');
          return EXIT.ERROR;
        }
        return await runHook(args[0]);
      default:
        process.stderr.write(`pdkit: unknown command "${command}"\n\n${USAGE}`);
        return EXIT.ERROR;
    }
  } catch (error) {
    // One place to turn an unexpected failure into a message and an exit code.
    // A stack trace on stdout would be read by whatever parsed --json.
    process.stderr.write(`pdkit ${command}: ${error.message}\n`);
    return EXIT.ERROR;
  }
}
