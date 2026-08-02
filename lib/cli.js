// SPDX-License-Identifier: Apache-2.0

// Argument parsing, command dispatch, and exit codes for pdkit.
//
// Every command returns an exit code. Nothing here calls process.exit()
// directly: bin/pdkit sets process.exitCode so pending stdout flushes first.

import { execFile } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import * as active from './active.js';
import { checkPlan, parsePlan, parseTask } from './artefacts.js';
import * as archaeology from './archaeology.js';
import * as attempts from './attempts.js';
import * as audit from './audit.js';
import * as backlog from './backlog.js';
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
import { buildPackageMap, fetchPullRequestHead, packageFor, pickScript, readPackageMap, resolveRepoRoot, scripts as repoScripts } from './repo.js';
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
  'close',
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
  review render <k> --values <file.json>
                                write reviews/<k>.md. Publishing stays manual
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
  pr ci <k>                     the CI verdict, measured against other open PRs
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
  amendment new --issue <n> [--values <f>]
                                allocate an A-ID and render the amendment
  close <issue> [--finish] [--force]
                                the facts for a knowledge harvest; --finish
                                moves the issue to merged, but only once every
                                pull request has landed, and cleans up worktrees
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

See specs/podman-desktop-kit-architecture.md section 12 for the delivery order.
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

/** Read a hook payload from stdin. Returns null when stdin is empty or not JSON. */
async function readHookPayload() {
  if (process.stdin.isTTY) return null;

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

  const payload = await readHookPayload();

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
async function runInit(flags) {
  const repo = await repoContext(flags);

  if (!repo.root) {
    process.stderr.write(`pdkit init: ${repo.problems.join('; ')}\n`);
    return EXIT.ERROR;
  }
  if (!repo.matches && !flags.force) {
    // Initializing against the wrong clone writes a package map for a
    // workspace nothing else will act on, and every later command inherits it.
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

  const map = await buildPackageMap(repo.root, { home, config: repo.config });

  if (flags.json) {
    printJson({ home, repo: repo.root, configCreated, packages: Object.keys(map.packages).length, warnings: repo.problems });
    return EXIT.OK;
  }

  process.stdout.write(
    `pdkit initialized\n` +
      `  repository  : ${repo.root}\n` +
      `  state home  : ${home}\n` +
      `  config      : ${layout.config}${configCreated ? ' (created)' : ' (kept)'}\n` +
      `  package map : ${Object.keys(map.packages).length} packages\n`,
  );
  for (const problem of repo.problems) process.stdout.write(`  warning     : ${problem}\n`);

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
    if (!flags.json) process.stdout.write(`issue ${issue}: ${result.from} -> ${result.to}\n`);
    return EXIT.OK;
  }

  const record = await state.read(issue);
  if (flags.json) {
    printJson(record);
    return EXIT.OK;
  }

  const next = nextStates(record.state);
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
      `  next         : ${next}\n`,
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
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runJournal(flags) {
  const filter = {};
  if (flags.issue !== undefined) filter.issue = Number.parseInt(String(flags.issue), 10);
  if (typeof flags.since === 'string') filter.since = flags.since;
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

  if (action === 'suggest') {
    let packageMap;
    try {
      packageMap = await readPackageMap({ home });
    } catch {
      process.stderr.write('pdkit slice suggest: no package map; run pdkit init first\n');
      return EXIT.ERROR;
    }

    // Scenario 13: upstream asks for an already-published pull request to be
    // split. The slicer is unchanged — what changes is where the diff comes
    // from, and `--from-pr` gives it a local ref to read instead of HEAD.
    const fromPr = Number.parseInt(String(flags['from-pr']), 10);
    let source = {};
    if (Number.isInteger(fromPr)) {
      const fetched = await fetchPullRequestHead({ pr: fromPr, repoRoot: repo.root, config: repo.config });
      source = { base: fetched.base, ref: fetched.ref };
      process.stderr.write(`  #${fromPr} fetched: ${fetched.ref.slice(0, 9)} branched from ${fetched.base.slice(0, 9)}\n`);
    }

    const collected = await slice.facts({ ...shared, ...source, packageMap });
    const suggestion = { ...collected, draft: slice.draft(collected), fromPr: Number.isInteger(fromPr) ? fromPr : null };

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
    const collected = await slice.facts({ ...shared, packageMap });
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
    const result = await worktree.create({
      repoRoot: repo.root,
      name,
      ref: typeof flags.ref === 'string' ? flags.ref : undefined,
      branch: typeof flags.branch === 'string' ? flags.branch : undefined,
      issue: Number.isInteger(issue) ? issue : undefined,
      config: repo.config,
      home,
    });

    if (!result.ok) {
      process.stderr.write(`pdkit worktree create: ${result.error}\n`);
      return EXIT.ERROR;
    }

    if (flags.json) printJson(result);
    else {
      process.stdout.write(`${result.path}${result.created ? '' : ' (already there)'}\n`);
      if (result.copied?.length) process.stdout.write(`  copied: ${result.copied.join(', ')}\n`);
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
        rows.push({ issue, ...record, staleness: pr.staleness(record, { config }) });
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
            `${waitingOn(row.review.domains)}\n`,
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

    if (flags.json) {
      printJson({ pr: number, verdict: record.ci.verdict, jobs: record.ci.jobs });
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
    // The distinction the measurement exists for, spelled out where it is read.
    process.stdout.write(
      '\n  fail = red here and green on other open PRs. inconclusive = red on theirs too, so not yours to fix.\n' +
        '  flake = the same job answered twice on one commit.\n',
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

async function runAmendment(args, flags) {
  if (args[0] !== 'new') {
    process.stderr.write(`pdkit amendment: unknown action "${args[0] ?? ''}" (new)\n`);
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
  };

  if (flags.json) printJson(facts);
  else {
    process.stdout.write(`DESKTOP-${issue} is ${record.state}\n`);
    process.stdout.write(`  pull requests: ${summary.merged.length} merged, ${summary.open.length} open, ${summary.closed.length} closed\n`);
    for (const line of facts.notable) process.stdout.write(`  ${line}\n`);
    for (const tree of facts.worktrees) process.stdout.write(`  worktree: ${tree}\n`);
  }

  if (!flags.finish) return EXIT.OK;

  if (!summary.allMerged) {
    // The rollup is the only thing that may move an issue to a terminal state.
    // Upstream merges slices one at a time, and finishing on the first would
    // strand every slice after it.
    process.stderr.write(
      `pdkit close: DESKTOP-${issue} is not finished — ` +
        `${[...summary.open, ...summary.closed].map((entry) => `#${entry}`).join(', ') || 'no pull request was ever opened'}\n`,
    );
    return EXIT.ERROR;
  }

  const moved = await state.transition(issue, 'merged', { reason: `${summary.merged.length} pull request(s) merged`, home });
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

  process.stdout.write(`DESKTOP-${issue} is merged\n`);
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

  // No --path means print it. Rendering a PR body to look at it before
  // anything is written is the common case.
  if (typeof flags.path !== 'string') {
    process.stdout.write(await render.render(template, values, { stripComments }));
    return EXIT.OK;
  }

  const written = await render.write({ issue, template, path: flags.path, values, stripComments });
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

  if (flags.json) {
    printJson({ issue, path, ...result });
    return result.ok ? EXIT.OK : EXIT.ERROR;
  }

  process.stdout.write(`plan check: issue ${issue} — ${result.ok ? 'passes' : `${result.problems.length} problem(s)`}\n`);
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
    process.stdout.write(`${await readVersion()}\n`);
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
        return await runJournal(flags);
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
      case 'amendment':
        return await runAmendment(args, flags);
      case 'close':
        return await runClose(args, flags);
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
