// SPDX-License-Identifier: Apache-2.0

// Argument parsing, command dispatch, and exit codes for pdkit.
//
// Every command returns an exit code. Nothing here calls process.exit()
// directly: bin/pdkit sets process.exitCode so pending stdout flushes first.

import { execFile } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULTS_PATH, load, paths, resolveHome } from './config.js';
import { diagnose, format } from './doctor.js';
import * as gate from './gate.js';
import * as gh from './gh.js';
import { FAIL_CLOSED, HOOK_HANDLERS } from './hooks/events.js';
import * as ids from './ids.js';
import * as journal from './journal.js';
import * as preflight from './preflight/index.js';
import * as render from './render.js';
import { buildPackageMap, packageFor, readPackageMap, resolveRepoRoot } from './repo.js';
import * as state from './state.js';

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
  'preflight',
  'gate',
  'pr',
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
  state <issue> --to <state>    move the issue, if the machine allows it
  ids requirement|task|slice <issue>
  ids freeze <issue>            freeze the requirement set
  ids branch --issue <n> --slug <s> [--index <i>]
  journal [--issue <n>] [--since <when>] [--event <name>]
  packages [--of <path>]        the package map, or the package owning a path
  issue fetch <n>               read the upstream issue
  issue escalate <n>            send a quickfix back to triage, so R-IDs come
                                from the issue rather than from the diff
  branch create --issue <n> --slug <s> [--index <i>]
  render <template> --issue <n> --values <file.json> [--path <p>]
                                fill a shipped template; without --path, print it
  preflight <issue> [--slice <i>] [--body <file>]
                                run the deterministic gates (section 7)
                  [--body-only] re-run only the checks that read the PR body
                  [--only a,b]  run just these checks
  gate open --issue <n> --branch <b> [--ttl <10m>]
  gate verify --branch <b>      check without spending
  gate close --branch <b>       spend the token
  gate revoke                   drop every outstanding token
  pr create --issue <n> --branch <b> --title <t> --body <file>
                                the only command that writes to GitHub
  hook <event>                  run a hook handler; reads the payload on stdin
  version                       print the plugin version

Options:
  --json                        machine-readable output where supported
  --repo <path>                 act on this repository instead of the cwd
  -h, --help                    show this help

Not implemented yet: plan, slice, pr-status, pr-sync, resume, review-pr.
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

  process.stderr.write(`pdkit issue: unknown action "${action ?? ''}" (fetch, escalate)\n`);
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
 * Issue, check, spend or revoke consent tokens.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function runGate(args, flags) {
  const action = args[0];
  const branch = typeof flags.branch === 'string' ? flags.branch : null;

  if (action === 'revoke') {
    const revoked = await gate.revokeAll();
    process.stdout.write(`${revoked} token${revoked === 1 ? '' : 's'} revoked\n`);
    return EXIT.OK;
  }

  if (!branch) {
    process.stderr.write(`pdkit gate ${action ?? ''}: --branch is required\n`);
    return EXIT.ERROR;
  }

  if (action === 'open') {
    const issue = Number.parseInt(String(flags.issue), 10);
    if (!Number.isInteger(issue)) {
      process.stderr.write('pdkit gate open: --issue is required\n');
      return EXIT.ERROR;
    }

    const ttlMs = flags.ttl === undefined ? undefined : gate.parseDuration(String(flags.ttl));
    const result = await gate.open({ issue, branch, ttlMs: ttlMs ?? undefined });

    if (!result.ok) {
      process.stderr.write(`pdkit gate open: ${result.error}\n`);
      return EXIT.ERROR;
    }
    if (flags.json) printJson(result);
    else process.stdout.write(`token for ${branch}, valid until ${result.expiresAt}\n`);
    return EXIT.OK;
  }

  if (action === 'verify') {
    const result = await gate.verify({ branch });
    if (flags.json) printJson(result);
    else process.stdout.write(result.valid ? `valid token for ${branch}\n` : `${result.reason}\n`);
    return result.valid ? EXIT.OK : EXIT.ERROR;
  }

  if (action === 'close') {
    const result = await gate.close(branch);
    if (!result.ok) {
      process.stderr.write(`pdkit gate close: ${result.error}\n`);
      return EXIT.ERROR;
    }
    process.stdout.write(`token for ${branch} spent\n`);
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
async function runPr(args, flags) {
  if (args[0] !== 'create') {
    process.stderr.write(`pdkit pr: unknown action "${args[0] ?? ''}" (create)\n`);
    return EXIT.ERROR;
  }

  const issue = Number.parseInt(String(flags.issue), 10);
  if (!Number.isInteger(issue) || typeof flags.branch !== 'string' || typeof flags.title !== 'string' || typeof flags.body !== 'string') {
    process.stderr.write('pdkit pr create: --issue, --branch, --title and --body <file> are required\n');
    return EXIT.ERROR;
  }

  const body = await readFile(flags.body, 'utf8');
  const config = await load({ repoRoot: typeof flags.repo === 'string' ? flags.repo : undefined });

  // gh.createPullRequest verifies and spends the token itself. It is not
  // trusted from here: the Bash hook cannot see a child process, so this is
  // the only place that check can live for the plugin's own path.
  const result = await gh.createPullRequest({
    head: flags.branch,
    title: flags.title,
    body,
    config,
  });

  const moved = await state.transition(issue, 'pr-open', { reason: `#${result.number} ${result.url}` });
  if (!moved.ok) {
    // The PR exists now; refusing to record it would leave the state machine
    // describing a world that is one pull request out of date.
    process.stderr.write(`pdkit pr create: opened ${result.url} but could not record it: ${moved.error}\n`);
  }

  if (flags.json) printJson(result);
  else process.stdout.write(`${result.url}\n`);

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
      case 'preflight':
        return await runPreflight(args, flags);
      case 'gate':
        return await runGate(args, flags);
      case 'pr':
        return await runPr(args, flags);
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
