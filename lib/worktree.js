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

// Git worktrees: the ones a person works in, and the one slice verification
// builds in.
//
// Separate from lib/repo.js on purpose. repo.js answers questions ABOUT the
// tree it was called in — which tree is this, what branch, what changed — and
// its callers are hooks, which must work whether or not the configuration is
// right. Creating trees is the other direction: it needs the configuration
// entirely (where they go, what to copy in, whether to install), and it writes
// to the filesystem outside the repository.
//
// Section 0 leans on worktrees for the whole parallel story: five trees share
// one $PDKIT_HOME, so state does not fork with the checkout. Until this module
// existed that was an argument rather than a fact — `worktrees.*` had been in
// the config since stage 0 with nothing reading it.

import { execFile } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { access, copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { get, load } from './config.js';
import { capture } from './evidence.js';
import { append as appendJournal } from './journal.js';
import { branches, scripts } from './repo.js';

const exec = promisify(execFile);

/** Installing a workspace this size is minutes, not seconds. */
export const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Marker recording which lockfile the installed dependencies belong to.
 *
 * It lives inside node_modules deliberately. `clean -fdx` wipes everything
 * except node_modules, so a marker anywhere else in the tree would be deleted
 * while the dependencies it describes survived — and one that outlived its
 * node_modules would be worse still, claiming an install that is no longer
 * there. Keeping the two together makes the claim and the thing it claims about
 * share a fate.
 */
const INSTALL_MARKER = join('node_modules', '.pdkit-install');

/**
 * Run git and report what happened. Unlike the helper in lib/repo.js this keeps
 * stderr: creating a worktree fails for reasons the user has to read ("already
 * checked out", "path exists"), and swallowing them would leave the caller with
 * nothing to print.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
async function git(args, cwd) {
  try {
    const { stdout, stderr } = await exec('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? '').trim(), stderr: String(error.stderr ?? error.message).trim() };
  }
}

/**
 * Where worktrees live, resolved against the repository.
 *
 * The default is `../pd-worktrees`, i.e. beside the fork rather than inside it.
 * Inside would put every parallel checkout into `git status` of the main tree
 * and, eventually, into a pull request.
 *
 * @param {{repoRoot: string, config?: import('./config.js').Config}} input
 * @returns {Promise<string>} absolute path
 */
export async function rootFor(input) {
  const config = input.config ?? (await load({ repoRoot: input.repoRoot }));
  const configured = String(get(config, 'worktrees.root') ?? '../pd-worktrees');
  if (isAbsolute(configured)) return configured;

  // Relative to the MAIN checkout, never to the tree the command was called
  // from. `worktrees.root: ../pd-worktrees` resolved against an issue worktree
  // — which already lives in pd-worktrees — put the verify tree in
  // pd-worktrees/pd-worktrees/, so the same logical tree had two locations
  // depending on where somebody was standing. Seen on 17221: slice verification
  // run from the issue worktree created a nested root that `worktree list` then
  // reported and `close` offered to clean up.
  return resolve(await mainWorktree(input.repoRoot), configured);
}

/**
 * The main working tree of a repository, given any of its worktrees.
 *
 * git's common directory is `<main>/.git` for the main tree and
 * `<main>/.git/worktrees/<name>` for a linked one, so the answer is the same
 * for every tree of the same repository — which is the property this needs.
 *
 * @param {string} repoRoot
 * @returns {Promise<string>}
 */
async function mainWorktree(repoRoot) {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot);
  if (!common.ok) return repoRoot;

  const dir = common.stdout.trim();
  return dir.endsWith('/.git') ? dirname(dir) : repoRoot;
}

/**
 * Name of the tree slice verification builds in, for one issue.
 *
 * One per issue rather than one per slice or one per run: node_modules for this
 * workspace is measured in gigabytes and installing it takes minutes, so a tree
 * per slice would multiply that by the number of slices on every run. A gate
 * that is expensive to pass is a gate people route around.
 *
 * @param {number} issue
 * @returns {string}
 */
export function verifyName(issue) {
  return `verify-DESKTOP-${issue}`;
}

/**
 * Whether two paths name the same place on disk.
 *
 * Through realpath, because git reports trees with symlinks resolved and the
 * configured root usually is not: on macOS `/tmp/x` and `/private/tmp/x` are
 * one directory and two strings. Comparing the strings makes an existing
 * worktree invisible, and the next `git worktree add` fails with "already
 * exists" for a tree the code just decided was absent.
 *
 * The same mistake put a hole in the ownership hook in stage 2. It is the kind
 * that unit tests miss, because a fixture built through realpath has both sides
 * agreeing by accident.
 *
 * @param {string} left
 * @param {string} right
 * @returns {Promise<boolean>}
 */
async function samePath(left, right) {
  const real = async (path) => {
    try {
      return await realpath(path);
    } catch {
      // Not there yet: nothing to resolve, and resolve() is the honest answer.
      return resolve(path);
    }
  };

  return (await real(left)) === (await real(right));
}

/**
 * One checkout git knows about, as `worktree list --porcelain` reports it.
 *
 * `branch` is null when detached, and that is a state worth distinguishing
 * rather than papering over: a detached tree cannot be pushed, so the commands
 * that need a branch say so instead of failing later. `main` marks the primary
 * checkout, which is the one `worktrees.root` is resolved against.
 *
 * @typedef {object} Worktree
 * @property {string} path        absolute
 * @property {string|null} branch null when detached
 * @property {string|null} head   commit sha
 * @property {boolean} main       the primary working tree
 */

/**
 * Every worktree of a repository, the main one first.
 *
 * @param {string} repoRoot
 * @returns {Promise<Worktree[]>}
 */
export async function list(repoRoot) {
  const result = await git(['worktree', 'list', '--porcelain'], repoRoot);
  if (!result.ok) return [];

  /** @type {Worktree[]} */
  const trees = [];
  /** @type {Partial<Worktree>|null} */
  let current = null;

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) trees.push(finishTree(current, trees.length === 0));
      current = { path: resolve(line.slice('worktree '.length)), branch: null, head: null };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).trim();
    // `branch refs/heads/x`; a detached worktree says `detached` instead, and
    // leaving branch null is what the removal check keys on.
    if (line.startsWith('branch ')) current.branch = line.slice('branch refs/heads/'.length).trim();
  }
  if (current) trees.push(finishTree(current, trees.length === 0));

  return trees;
}

/**
 * @param {Partial<Worktree>} tree
 * @param {boolean} main
 * @returns {Worktree}
 */
function finishTree(tree, main) {
  return { path: tree.path ?? '', branch: tree.branch ?? null, head: tree.head ?? null, main };
}

/**
 * The worktree at a path, if git knows about one.
 *
 * @param {string} repoRoot
 * @param {string} path
 * @returns {Promise<Worktree|undefined>}
 */
async function find(repoRoot, path) {
  for (const tree of await list(repoRoot)) {
    if (await samePath(tree.path, path)) return tree;
  }
  return undefined;
}

/**
 * The files config says a new tree needs, copied from the repository.
 *
 * Silently skips what is not there: `.env.local` is listed because it often
 * exists, not because it must.
 *
 * @param {{repoRoot: string, target: string, config: import('./config.js').Config}} input
 * @returns {Promise<string[]>} what was actually copied
 */
async function copyExtras(input) {
  const wanted = /** @type {string[]} */ (get(input.config, 'worktrees.copy_files') ?? []);
  const copied = [];

  for (const name of wanted) {
    const source = join(input.repoRoot, name);
    try {
      await access(source, FS.R_OK);
    } catch {
      continue;
    }
    const target = join(input.target, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    copied.push(name);
  }

  return copied;
}

/**
 * Create a worktree, or adopt the one already at that path.
 *
 * Adopting rather than failing is the same call as `createBranch` in the CLI:
 * re-running a flow after fixing something is the normal case, and a command
 * that only works the first time gets worked around instead of used.
 *
 * @param {{repoRoot: string, name: string, ref?: string, branch?: string, detach?: boolean, issue?: number, config?: import('./config.js').Config, home?: string}} input
 * @returns {Promise<{ok: boolean, path?: string, created?: boolean, copied?: string[], error?: string}>}
 */
export async function create(input) {
  const config = input.config ?? (await load({ repoRoot: input.repoRoot }));
  const path = join(await rootFor({ repoRoot: input.repoRoot, config }), input.name);

  const existing = await find(input.repoRoot, path);
  if (existing) {
    return { ok: true, path, created: false, copied: [] };
  }

  const ref = input.ref ?? String(get(config, 'repo.base_branch') ?? 'main');
  const args = ['worktree', 'add'];

  // `-b` creates, and creating a branch that is already there is a fatal from
  // git and nothing from us. Asked for a branch that exists, check it out —
  // which is what somebody rebasing work that is already under review wants,
  // and on DESKTOP-18832 was answered with "a branch named … already exists".
  const wanted = typeof input.branch === 'string' && input.branch !== '' ? input.branch : null;
  const exists = wanted !== null && (await branches({ cwd: input.repoRoot })).includes(wanted);

  if (wanted && !exists) args.push('-b', wanted);
  else if (!wanted && input.detach !== false) args.push('--detach');
  args.push(path, exists ? wanted : ref);

  await mkdir(dirname(path), { recursive: true });
  const added = await git(args, input.repoRoot);
  if (!added.ok) return { ok: false, error: added.stderr || added.stdout };

  const copied = await copyExtras({ repoRoot: input.repoRoot, target: path, config });

  // The branch is in the entry because "which branch did this tree start on" is
  // a question asked months later, when the tree is gone and the pull request is
  // the only thing left. `at main` alone answers where it branched from and not
  // what it branched as.
  await appendJournal(
    {
      issue: input.issue ?? null,
      event: 'worktree-create',
      detail: `${input.name} at ${exists ? wanted : ref}${wanted ? ` on ${wanted}${exists ? ' (existing)' : ''}` : ' (detached)'}`,
    },
    { home: input.home },
  );

  return { ok: true, path, created: true, copied };
}

/**
 * Remove a worktree.
 *
 * Refuses while the tree holds a branch that has not landed. That is the one
 * case where removal loses work rather than tidying up, and it is not
 * detectable afterwards — `git worktree remove` takes the commits with it if
 * nothing else references the branch.
 *
 * Landed has two spellings and this module only knows one. `landed` is the
 * caller's answer from the pull request record; ancestry in the base branch is
 * the fallback for a branch no pull request knows about.
 *
 * @param {{repoRoot: string, name: string, force?: boolean, landed?: boolean, issue?: number, config?: import('./config.js').Config, home?: string}} input
 * @returns {Promise<{ok: boolean, removed?: boolean, error?: string}>}
 */
export async function remove(input) {
  const config = input.config ?? (await load({ repoRoot: input.repoRoot }));
  const path = join(await rootFor({ repoRoot: input.repoRoot, config }), input.name);

  const tree = await find(input.repoRoot, path);
  if (!tree) return { ok: true, removed: false };

  // `landed` comes from the caller, which has read prs.json — and it is the
  // only half of this that works upstream. podman-desktop squash-merges, so a
  // merged branch's commits are never ancestors of the base and
  // `git branch --merged` can never say yes about one. On DESKTOP-18832
  // `close --finish` printed "1 merged" and then kept both worktrees, refusing
  // on the grounds that the branch was not merged into a local `main` that was
  // also two days stale. Ancestry stays as the answer for a branch no pull
  // request knows about, which is most of them.
  if (tree.branch && !input.force && !input.landed) {
    const base = String(get(config, 'repo.base_branch') ?? 'main');
    const merged = await git(['branch', '--merged', base, '--format=%(refname:short)'], input.repoRoot);
    const ancestor = merged.ok && merged.stdout.split('\n').map((name) => name.trim()).includes(tree.branch);

    if (!ancestor) {
      return {
        ok: false,
        error:
          `${input.name} holds ${tree.branch}, which is not an ancestor of ${base} and has no merged pull request recorded. ` +
          `If it did land, ${base} here may be behind — fetch, or \`pdkit pr refresh <k>\`. ` +
          'Removing it drops the commits with the tree; pass --force once you mean to abandon them',
      };
    }
  }

  const removed = await git(['worktree', 'remove', ...(input.force ? ['--force'] : []), path], input.repoRoot);
  if (!removed.ok) return { ok: false, error: removed.stderr || removed.stdout };

  await appendJournal(
    { issue: input.issue ?? null, event: 'worktree-remove', detail: `${input.name}${tree.branch ? ` (${tree.branch})` : ''}` },
    { home: input.home },
  );

  return { ok: true, removed: true };
}

/**
 * Digest of the lockfile a tree would install from.
 *
 * @param {string} repoRoot
 * @returns {Promise<string|null>}
 */
async function lockfileStamp(repoRoot) {
  for (const name of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
    try {
      const content = await readFile(join(repoRoot, name), 'utf8');
      // Length plus name is enough to notice a lockfile change and costs no
      // hashing of a megabyte file on every verify. A collision here means one
      // extra install, not a wrong result.
      return `${name}:${content.length}:${content.slice(-256)}`;
    } catch {
      // Try the next.
    }
  }
  return null;
}

/**
 * Bring the verification tree to a known state at `base`.
 *
 * Order matters and each step is load-bearing:
 *
 *   reset --hard      the tree carries whatever the last slice applied
 *   clean -fdx        including files no commit contains — a green standalone
 *                     built on a leftover file is exactly the failure the
 *                     working-tree check exists for (section 7)
 *   except node_modules   the one exception, and the reason this tree is
 *                     reused rather than recreated
 *   copy extras       clean took .env with it
 *   install           only when the lockfile moved
 *
 * @param {{repoRoot: string, name: string, base: string, issue?: number, config?: import('./config.js').Config, home?: string}} input
 * @returns {Promise<{ok: boolean, path?: string, installed?: boolean, error?: string, output?: string}>}
 */
export async function prepare(input) {
  const config = input.config ?? (await load({ repoRoot: input.repoRoot }));

  const created = await create({ ...input, config, ref: input.base, detach: true });
  if (!created.ok) return { ok: false, error: created.error };
  const path = /** @type {string} */ (created.path);

  const checkout = await git(['checkout', '--detach', input.base], path);
  if (!checkout.ok) return { ok: false, error: `cannot check out ${input.base} in ${path}: ${checkout.stderr}` };

  const reset = await git(['reset', '--hard', input.base], path);
  if (!reset.ok) return { ok: false, error: `cannot reset ${path} to ${input.base}: ${reset.stderr}` };

  const clean = await git(['clean', '-fdx', '-e', 'node_modules'], path);
  if (!clean.ok) return { ok: false, error: `cannot clean ${path}: ${clean.stderr}` };

  await copyExtras({ repoRoot: input.repoRoot, target: path, config });

  const policy = String(get(config, 'slicing.verify.install') ?? 'on-lockfile-change');
  const stamp = await lockfileStamp(path);
  const markerPath = join(path, INSTALL_MARKER);

  let previous = null;
  try {
    previous = await readFile(markerPath, 'utf8');
  } catch {
    // Never installed here, or node_modules was removed and took the marker.
  }

  const manager = String(get(config, 'repo.package_manager') ?? 'pnpm');
  const needed = policy === 'always' || (policy !== 'never' && stamp !== null && previous !== stamp);

  if (needed) {
    const command = manager === 'pnpm' ? 'pnpm install --frozen-lockfile --prefer-offline' : `${manager} install`;

    const run = await capture({ command, cwd: path, timeoutMs: INSTALL_TIMEOUT_MS });
    if (run.exitCode !== 0) {
      return {
        ok: false,
        error: `${command} failed in ${path} (exit ${run.exitCode ?? 'killed'})`,
        output: `${run.stdout}${run.stderr}`,
      };
    }

    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, stamp ?? '');
  }

  const prepared = await runPrepareScripts({ path, config, manager });
  if (!prepared.ok) return prepared;

  return { ok: true, path, installed: needed, prepared: prepared.ran };
}

/**
 * Build steps a tree needs before anything can be checked in it.
 *
 * Found by running the real thing. In podman-desktop, `@podman-desktop/core-api`
 * resolves through `packages/api/dist`, which exists only after
 * `pnpm build:core-api` — and until it does, `typecheck:main` cannot find the
 * module and eslint's type-aware rules see `any` where a type should be, which
 * turned 110 warnings into 18 errors in files no slice had touched. Every slice
 * came back red for a reason that had nothing to do with slicing.
 *
 * It runs after every clean rather than only after an install: the build output
 * is untracked, so `clean -fdx` takes it each time.
 *
 * Script names are resolved from the repository and skipped when absent, the
 * same rule preflight follows — a name baked in here would become a step that
 * silently stops running.
 *
 * @param {{path: string, config: import('./config.js').Config, manager: string}} input
 * @returns {Promise<{ok: boolean, ran?: string[], error?: string, output?: string}>}
 */
async function runPrepareScripts(input) {
  const wanted = /** @type {string[]} */ (get(input.config, 'slicing.verify.prepare') ?? []);
  if (wanted.length === 0) return { ok: true, ran: [] };

  const available = await scripts(input.path);
  const ran = [];

  for (const name of wanted) {
    if (!(name in available)) continue;

    const command = `${input.manager} run ${name}`;
    const run = await capture({ command, cwd: input.path, timeoutMs: INSTALL_TIMEOUT_MS });

    if (run.exitCode !== 0) {
      return {
        ok: false,
        error: `${command} failed in ${input.path} (exit ${run.exitCode ?? 'killed'}); the tree cannot verify anything in this state`,
        output: `${run.stdout}${run.stderr}`,
      };
    }
    ran.push(name);
  }

  return { ok: true, ran };
}

/**
 * Drop a tree from disk without consulting branches. For the ephemeral
 * verification mode, where the tree is detached and holds nothing.
 *
 * @param {{repoRoot: string, path: string}} input
 * @returns {Promise<void>}
 */
export async function discard(input) {
  await git(['worktree', 'remove', '--force', input.path], input.repoRoot);
  // git refuses to remove a tree it has lost track of; the directory is still
  // ours to delete, and leaving it behind would break the next `worktree add`
  // at the same path.
  await rm(input.path, { recursive: true, force: true });
  await git(['worktree', 'prune'], input.repoRoot);
}
