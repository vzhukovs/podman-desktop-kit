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

// Going back to the start of a phase.
//
// On DESKTOP-18833 a /pd:pr-sync round went down a path the plugin had no
// command for. An amendment was approved with its tasks stripped out, slice
// branches and an integration branch were built, and the reply drafts assumed
// a stack. When it turned out to be unrepresentable, there was no way back but
// to ask the model that had made the changes to remember all of them. They
// were spread over two places: git branches in the fork, and records under
// $PDKIT_HOME.
//
// A checkpoint is taken as the first step of a phase that changes things
// (exec, slice, pr-sync, resume). It is facts, not a judgement:
//
//   issue/      a copy of issues/<n>/, the state record included
//   meta.json   the phase, the time, the issue's state record, the heads of
//               its branches, local and remote, the trees it was checked out
//               in, the branch the main checkout stood on, and how many
//               journal entries it had
//
// `rollback` compares now against that and puts the repository back the way
// the phase found it:
//
//   - branches are reset to the heads they had, and a branch the phase
//     created is deleted. Either way the tip it had a moment ago is kept
//     under refs/pdkit-backup/ first, so no commit becomes unreachable:
//     rollback is about the record of work, and the work stays reachable;
//   - trees follow their branches. A tree the phase created is removed, one it
//     removed is added back, and the main checkout returns to the branch it
//     stood on. A tree with uncommitted changes refuses the whole rollback,
//     by name, because a tree is the one place work exists outside git;
//   - a task left running is stopped, so the pointer does not outlive the run;
//   - artefacts are restored from the copy. What was there is archived, as
//     reset does, never deleted;
//   - the state record comes back through lib/state.js, and only when the
//     phase did not move the issue to another state (see state.restore);
//   - anything published stays: a remote branch that moved, a reply posted.
//     So does the journal. It is append-only, and rollback adds one entry
//     saying what it undid.
//
// Branches created during the phase used to be listed and left alone. On
// DESKTOP-19818 that left T1's commit on a branch exec had created in the main
// checkout, with the checkout still standing on it, and the person had to
// undo by hand the half of the phase the rollback could not see. Since /pd:exec
// creates the issue's tree before the checkpoint, the tree and its branch are
// in the record, and a rollback leaves the issue where the phase started: its
// tree on its base, ready for the phase to run again.

import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import * as active from './active.js';
import { get, issueDir, load, paths, resolveHome } from './config.js';
import { append as appendJournal, read as readJournal } from './journal.js';
import * as state from './state.js';
import { claims, list as listWorktrees } from './worktree.js';

const exec = promisify(execFile);

/** Journal events written here. */
export const EVENTS = { taken: 'checkpoint', rolledBack: 'rolled-back' };

/** The phases that take one, as their skills name them. */
export const PHASES = ['exec', 'slice', 'pr-sync', 'resume'];

const CHECKPOINT_ID = /^C(\d+)$/;

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
async function git(args, cwd) {
  try {
    const { stdout, stderr } = await exec('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message) };
  }
}

/** Where an issue's checkpoints live. */
function rootOf(home, issue) {
  return join(paths(home).home, 'checkpoints', String(issue));
}

/**
 * Every file under a directory, as paths relative to it.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function filesUnder(dir) {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  // Forward slashes on every platform. These names are compared between the
  // snapshot and the present, and printed in the dry run; Windows would give
  // `amendments\A3.md` here, and join() reads either separator back.
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join('/'))
    .sort();
}

/**
 * The heads of an issue's branches: `DESKTOP-<n>` and `DESKTOP-<n>/…`, local
 * and on every remote.
 *
 * Remote heads are recorded so a rollback can say what was pushed in the
 * meantime, which is the part it cannot take back.
 *
 * @param {number} issue
 * @param {string|null} repoRoot
 * @returns {Promise<{local: Record<string, string>, remote: Record<string, string>}>}
 */
export async function heads(issue, repoRoot) {
  const local = {};
  const remote = {};
  if (!repoRoot) return { local, remote };

  // `DESKTOP-<n>` alone as well as `DESKTOP-<n>/…`. Not a name this plugin
  // gives, and that is why: on DESKTOP-19818 exec named its branch by hand,
  // and a rollback that matched only the prefix did not see it at all.
  const ours = (name) => name === `DESKTOP-${issue}` || name.startsWith(`DESKTOP-${issue}/`);
  const listed = await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/remotes/'], repoRoot);
  for (const line of listed.stdout.split('\n')) {
    const [ref, sha] = line.trim().split(' ');
    if (!ref || !sha) continue;
    if (ref.startsWith('refs/heads/')) {
      if (ours(ref.slice('refs/heads/'.length))) local[ref.slice('refs/heads/'.length)] = sha;
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length);
      if (ours(name.slice(name.indexOf('/') + 1))) remote[name] = sha;
    }
  }
  return { local, remote };
}

/**
 * The trees that matter to an issue's rollback: its own, and the main checkout.
 *
 * Its own are the ones `claims` names, plus any holding one of its branches
 * under a name `parseBranch` does not read, `DESKTOP-<n>` alone being the one
 * that happened.
 *
 * @param {number} issue
 * @param {string|null} repoRoot
 * @returns {Promise<{trees: (Tree & {main: boolean})[], main: (Tree & {main: boolean})|null}>}
 */
async function treesOf(issue, repoRoot) {
  if (!repoRoot) return { trees: [], main: null };
  const all = await listWorktrees(repoRoot);
  const named = (branch) => branch === `DESKTOP-${issue}` || String(branch ?? '').startsWith(`DESKTOP-${issue}/`);
  return {
    trees: all.filter((tree) => !tree.main && (claims(tree, issue) || named(tree.branch))),
    main: all.find((tree) => tree.main) ?? null,
  };
}

/** @param {{path: string, branch: string|null, head: string|null}} tree */
const recordOf = (tree) => ({ path: tree.path, branch: tree.branch, head: tree.head });

/**
 * Whether a tree has changes git tracks. Untracked files are not counted: a
 * reset, a switch and a branch moving leave them where they are.
 *
 * @param {string} path
 */
async function dirty(path) {
  const status = await git(['status', '--porcelain', '--untracked-files=no'], path);
  return status.stdout.trim() !== '';
}

/**
 * Whether removing a tree would lose anything: changes, or untracked files
 * that are not ignored. Ignored ones (node_modules, a build) are rebuilt.
 *
 * @param {string} path
 */
async function holdsWork(path) {
  const status = await git(['status', '--porcelain'], path);
  return status.stdout.trim() !== '';
}

/**
 * @typedef {object} Meta
 * @property {string} id
 * @property {number} issue
 * @property {string} phase
 * @property {string} at
 * @property {object} record           the state record as it was
 * @property {{local: Record<string, string>, remote: Record<string, string>}} branches
 * @property {Tree[]} [trees]           the issue's trees; absent in checkpoints taken before 0.10.3
 * @property {Tree|null} [main]         the main checkout
 * @property {number} journal          entries the issue had
 */

/**
 * A working tree as a checkpoint records it.
 *
 * @typedef {object} Tree
 * @property {string} path
 * @property {string|null} branch  null when detached
 * @property {string|null} head
 */

/**
 * Every checkpoint of an issue, oldest first.
 *
 * @param {{issue: number, home?: string}} input
 * @returns {Promise<Meta[]>}
 */
export async function list(input) {
  const home = input.home ?? resolveHome();
  let names;
  try {
    names = (await readdir(rootOf(home, input.issue))).filter((name) => CHECKPOINT_ID.test(name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  names.sort((a, b) => Number(CHECKPOINT_ID.exec(a)[1]) - Number(CHECKPOINT_ID.exec(b)[1]));

  const found = [];
  for (const name of names) {
    try {
      found.push(JSON.parse(await readFile(join(rootOf(home, input.issue), name, 'meta.json'), 'utf8')));
    } catch {
      // A checkpoint whose meta never got written was interrupted while being
      // taken. It is not one to go back to.
    }
  }
  return found;
}

/**
 * Take a checkpoint at the start of a phase.
 *
 * @param {{issue: number, phase: string, repoRoot: string|null, home?: string}} input
 * @returns {Promise<{ok: boolean, error?: string, meta?: Meta}>}
 */
export async function take(input) {
  if (!PHASES.includes(input.phase)) return { ok: false, error: `--phase must be one of ${PHASES.join(', ')}` };

  const home = input.home ?? resolveHome();
  const existing = await list({ issue: input.issue, home });
  const last = existing.at(-1);
  const id = `C${last ? Number(CHECKPOINT_ID.exec(last.id)[1]) + 1 : 1}`;
  const dir = join(rootOf(home, input.issue), id);

  await mkdir(dir, { recursive: true });
  const source = issueDir(home, input.issue);
  if ((await filesUnder(source)).length > 0) await cp(source, join(dir, 'issue'), { recursive: true });

  /** @type {Meta} */
  const meta = {
    id,
    issue: input.issue,
    phase: input.phase,
    at: new Date().toISOString(),
    record: await state.read(input.issue, { home }),
    branches: await heads(input.issue, input.repoRoot),
    ...(await (async () => {
      const found = await treesOf(input.issue, input.repoRoot);
      return { trees: found.trees.map(recordOf), main: found.main ? recordOf(found.main) : null };
    })()),
    journal: (await readJournal({ issue: input.issue }, { home })).length,
  };
  // meta.json last: its presence is what makes the directory a checkpoint.
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  await appendJournal({ issue: input.issue, event: EVENTS.taken, detail: `${id} at the start of ${input.phase}` }, { home });

  return { ok: true, meta };
}

/**
 * What a rollback to a checkpoint would do, without doing any of it.
 *
 * @param {{issue: number, id?: string, repoRoot: string|null, home?: string}} input
 */
export async function plan(input) {
  const home = input.home ?? resolveHome();
  const all = await list({ issue: input.issue, home });
  const meta = input.id ? all.find((entry) => entry.id === input.id) : all.at(-1);
  if (!meta) {
    return { ok: false, error: input.id ? `DESKTOP-${input.issue} has no checkpoint ${input.id}` : `DESKTOP-${input.issue} has no checkpoint` };
  }

  const record = await state.read(input.issue, { home });
  const stateMoved = record.state !== meta.record.state ? { from: meta.record.state, to: record.state } : null;

  const now = await heads(input.issue, input.repoRoot);
  const trees = input.repoRoot ? await listWorktrees(input.repoRoot) : [];
  const mainTree = trees.find((tree) => tree.main) ?? null;
  const ours = await treesOf(input.issue, input.repoRoot);
  // A checkpoint from before trees were recorded knows nothing about them, so
  // it removes only the trees that hold a branch it deletes.
  const knowsTrees = Array.isArray(meta.trees);
  const recordedPaths = new Set((meta.trees ?? []).map((tree) => tree.path));
  const config = input.repoRoot ? await load({ repoRoot: input.repoRoot }).catch(() => null) : null;
  const base = String((config && get(config, 'repo.base_branch')) ?? 'main');

  const reset = [];
  const recreate = [];
  /** @type {{branch: string, sha: string}[]} */
  const drop = [];
  const refused = [];
  /** @type {{path: string, branch: string}[]} */
  const removeTrees = [];
  /** @type {Tree[]} */
  const addTrees = [];
  /** @type {(Tree & {from: string})[]} */
  const restoreTrees = [];
  /** @type {{path: string, from: string|null, to: string}|null} */
  let switchMain = null;

  const holder = (branch) => trees.find((tree) => tree.branch === branch) ?? null;

  for (const [branch, sha] of Object.entries(meta.branches.local)) {
    const current = now.local[branch];
    if (current === sha) continue;
    if (current === undefined) {
      recreate.push({ branch, to: sha });
      continue;
    }
    const tree = holder(branch);
    if (tree && (await dirty(tree.path))) {
      refused.push({ branch, reason: `checked out in ${tree.path} with uncommitted changes` });
      continue;
    }
    reset.push({ branch, from: current, to: sha, tree: tree?.path ?? null });
  }

  for (const [branch, sha] of Object.entries(now.local)) {
    if (branch in meta.branches.local) continue;
    const tree = holder(branch);
    if (tree?.main) {
      if (await dirty(tree.path)) {
        refused.push({ branch, reason: `checked out in the main checkout ${tree.path} with uncommitted changes` });
        continue;
      }
      // Back to where it stood, or to the base when the checkpoint did not say.
      const to = meta.main?.branch && meta.main.branch !== branch ? meta.main.branch : base;
      switchMain = { path: tree.path, from: branch, to };
    } else if (tree) {
      const recorded = (meta.trees ?? []).find((entry) => entry.path === tree.path);
      if (recorded) {
        // A tree that was there before the phase, moved onto a new branch:
        // it goes back to what it stood on, and only the branch goes.
        if (await dirty(tree.path)) {
          refused.push({ branch, reason: `checked out in ${tree.path} with uncommitted changes` });
          continue;
        }
        restoreTrees.push({ path: tree.path, from: branch, branch: recorded.branch, head: recorded.head });
      } else {
        if (await holdsWork(tree.path)) {
          refused.push({ branch, reason: `checked out in ${tree.path}, which has changes or untracked files` });
          continue;
        }
        removeTrees.push({ path: tree.path, branch });
      }
    }
    drop.push({ branch, sha });
  }

  // The main checkout moved onto one of the issue's recorded branches.
  if (!switchMain && mainTree && meta.main?.branch && mainTree.branch !== meta.main.branch && mainTree.branch && mainTree.branch in now.local) {
    if (await dirty(mainTree.path)) refused.push({ branch: mainTree.branch, reason: `the main checkout ${mainTree.path} has uncommitted changes` });
    else switchMain = { path: mainTree.path, from: mainTree.branch, to: meta.main.branch };
  }

  if (knowsTrees) {
    // Trees the phase created that hold no branch being deleted: a detached
    // tree named for the issue.
    for (const tree of ours.trees) {
      if (recordedPaths.has(tree.path) || removeTrees.some((entry) => entry.path === tree.path)) continue;
      if (tree.branch && !drop.some((entry) => entry.branch === tree.branch)) continue;
      if (await holdsWork(tree.path)) refused.push({ branch: tree.branch ?? tree.path, reason: `${tree.path} was created during the phase and has changes or untracked files` });
      else removeTrees.push({ path: tree.path, branch: tree.branch ?? '' });
    }
    // Trees the phase removed.
    for (const tree of /** @type {Tree[]} */ (meta.trees)) {
      if (!trees.some((entry) => entry.path === tree.path)) addTrees.push(tree);
    }
  }

  const published = Object.keys({ ...meta.branches.remote, ...now.remote }).filter((ref) => meta.branches.remote[ref] !== now.remote[ref]);
  const running = (await active.list({ home })).filter((entry) => entry.issue === input.issue);

  // Artefacts.
  const snapshotDir = join(rootOf(home, input.issue), meta.id, 'issue');
  const before = (await filesUnder(snapshotDir)).filter((file) => !state.isRecordFile(file));
  const after = (await filesUnder(issueDir(home, input.issue))).filter((file) => !state.isRecordFile(file));
  const changed = [];
  for (const file of before) {
    if (!after.includes(file)) changed.push({ file, change: 'restored' });
    else if ((await readFile(join(snapshotDir, file), 'utf8')) !== (await readFile(join(issueDir(home, input.issue), file), 'utf8'))) {
      changed.push({ file, change: 'reverted' });
    }
  }
  for (const file of after) if (!before.includes(file)) changed.push({ file, change: 'archived' });

  const since = (await readJournal({ issue: input.issue }, { home })).slice(meta.journal);

  return {
    ok: true,
    meta,
    stateMoved,
    branches: { reset, recreate, drop, refused },
    trees: { remove: removeTrees, add: addTrees, restore: restoreTrees, switchMain },
    tasks: running.map((entry) => ({ taskId: entry.taskId, worktree: entry.worktree })),
    published,
    artefacts: changed,
    journal: since.filter((entry) => entry.event !== EVENTS.taken).map((entry) => `${entry.event}${entry.detail ? `: ${entry.detail}` : ''}`),
  };
}

/**
 * Roll back, after `plan` has been shown and the person has said yes.
 *
 * @param {{issue: number, plan: Awaited<ReturnType<typeof plan>> & {ok: true}, repoRoot: string|null, home?: string}} input
 * @returns {Promise<{ok: boolean, error?: string, backups?: string[], archived?: string|null}>}
 */
export async function apply(input) {
  const home = input.home ?? resolveHome();
  const { meta, stateMoved, branches, trees, tasks } = input.plan;

  // Refused before anything moves: half a rollback is a third state that
  // neither the checkpoint nor the present describes.
  if (stateMoved) {
    return {
      ok: false,
      error:
        `the issue moved from ${stateMoved.from} to ${stateMoved.to} during the phase, and a transition is not undone by ` +
        'rewriting the record. Roll back to a checkpoint taken in the current state, or use pdkit reset to start the issue over',
    };
  }
  if (branches.refused.length > 0) {
    return { ok: false, error: branches.refused.map((entry) => `${entry.branch}: ${entry.reason}`).join('; ') };
  }
  const touchesGit =
    branches.reset.length + branches.recreate.length + branches.drop.length + trees.remove.length + trees.add.length + trees.restore.length > 0 ||
    trees.switchMain !== null;
  if (touchesGit && !input.repoRoot) {
    return { ok: false, error: 'branches and trees have to be put back, and there is no repository here — run it from the fork' };
  }
  const repoRoot = /** @type {string} */ (input.repoRoot);

  // The run is over: a pointer left behind would hold the next run to a task
  // that is not running.
  for (const task of tasks) await active.stop({ worktree: task.worktree, home });

  // The present tips go under refs/pdkit-backup/ first, deleted branches
  // included. After this, nothing below can make a commit unreachable.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backups = [];
  for (const entry of [...branches.reset.map((one) => ({ branch: one.branch, sha: one.from })), ...branches.drop]) {
    const backup = `refs/pdkit-backup/${input.issue}/${meta.id}-${stamp}/${entry.branch}`;
    await git(['update-ref', backup, entry.sha], repoRoot);
    backups.push(backup);
  }

  // Trees off the branches about to go: git deletes no branch that a tree has
  // checked out.
  if (trees.switchMain) {
    const moved = await git(['switch', trees.switchMain.to], trees.switchMain.path);
    if (!moved.ok) return { ok: false, error: `the main checkout: ${moved.stderr.trim()}`, backups };
  }
  for (const tree of trees.restore) {
    const moved = await git(['switch', ...(tree.branch ? [tree.branch] : ['--detach', String(tree.head)])], tree.path);
    if (!moved.ok) return { ok: false, error: `${tree.path}: ${moved.stderr.trim()}`, backups };
  }
  for (const tree of trees.remove) {
    const removed = await git(['worktree', 'remove', tree.path], repoRoot);
    if (!removed.ok) return { ok: false, error: `${tree.path}: ${removed.stderr.trim()}`, backups };
  }

  for (const entry of branches.reset) {
    const moved = entry.tree
      ? await git(['reset', '--hard', entry.to], entry.tree)
      : await git(['update-ref', `refs/heads/${entry.branch}`, entry.to, entry.from], repoRoot);
    if (!moved.ok) return { ok: false, error: `${entry.branch}: ${moved.stderr.trim()}`, backups };
  }
  for (const entry of branches.recreate) {
    const made = await git(['update-ref', `refs/heads/${entry.branch}`, entry.to], repoRoot);
    if (!made.ok) return { ok: false, error: `${entry.branch}: ${made.stderr.trim()}`, backups };
  }
  for (const entry of branches.drop) {
    const deleted = await git(['branch', '-D', entry.branch], repoRoot);
    if (!deleted.ok) return { ok: false, error: `${entry.branch}: ${deleted.stderr.trim()}`, backups };
  }

  // Trees back on their branches, once the branches are where they were.
  for (const tree of trees.add) {
    const added = await git(['worktree', 'add', tree.path, ...(tree.branch ? [tree.branch] : ['--detach', String(tree.head)])], repoRoot);
    if (!added.ok) return { ok: false, error: `${tree.path}: ${added.stderr.trim()}`, backups };
  }

  // Artefacts. What is there now is archived, never deleted.
  const dir = issueDir(home, input.issue);
  const snapshotDir = join(rootOf(home, input.issue), meta.id, 'issue');
  let archived = null;
  const current = (await filesUnder(dir)).filter((file) => !state.isRecordFile(file));
  if (current.length > 0) {
    archived = join(paths(home).archive, String(input.issue), `rollback-${meta.id}-${stamp}`);
    await mkdir(archived, { recursive: true });
    for (const file of current) {
      await mkdir(join(archived, file, '..'), { recursive: true });
      await rename(join(dir, file), join(archived, file));
    }
  }
  for (const file of (await filesUnder(snapshotDir)).filter((name) => !state.isRecordFile(name))) {
    await mkdir(join(dir, file, '..'), { recursive: true });
    await cp(join(snapshotDir, file), join(dir, file));
  }

  const restored = await state.restore(input.issue, meta.record, { home });
  if (!restored.ok) return { ok: false, error: restored.error, backups };

  const moved = branches.reset.length + branches.recreate.length;
  await appendJournal(
    {
      issue: input.issue,
      event: EVENTS.rolledBack,
      detail:
        `to ${meta.id} (start of ${meta.phase}) — ${moved} branch(es) reset, ${branches.drop.length} deleted, ` +
        `${trees.remove.length} tree(s) removed, ${trees.add.length} added${trees.switchMain ? `, main checkout back on ${trees.switchMain.to}` : ''}, ` +
        `${tasks.length} task(s) stopped, ${input.plan.artefacts.length} artefact(s) restored; ` +
        `undone since: ${input.plan.journal.join('; ') || 'nothing journalled'}`,
    },
    { home },
  );

  return { ok: true, backups, archived };
}

/**
 * The dry run, in words.
 *
 * @param {Awaited<ReturnType<typeof plan>> & {ok: true}} report
 * @returns {string}
 */
export function format(report) {
  const { meta, stateMoved, branches, trees, tasks, published, artefacts, journal } = report;
  const lines = [`DESKTOP-${meta.issue}: back to ${meta.id}, the start of ${meta.phase} (${meta.at.slice(0, 16).replace('T', ' ')})`];

  if (stateMoved) {
    lines.push(
      '',
      `  ✘ refused: the issue moved from ${stateMoved.from} to ${stateMoved.to} during the phase.`,
      '    A transition is not undone by rewriting the record.',
    );
  }
  if (branches.refused.length > 0) {
    lines.push('', '  ✘ refused until these are committed or stashed:');
    for (const entry of branches.refused) lines.push(`    ${entry.branch}  ${entry.reason}`);
  }

  lines.push('', '  would bring back:');
  for (const task of tasks) lines.push(`    task ${task.taskId}  stopped in ${task.worktree}`);
  if (trees.switchMain) lines.push(`    main checkout  ${trees.switchMain.from ?? 'detached'} -> ${trees.switchMain.to}  (${trees.switchMain.path})`);
  for (const tree of trees.restore) lines.push(`    tree ${tree.path}  ${tree.from} -> ${tree.branch ?? `a detached ${String(tree.head).slice(0, 10)}`}`);
  for (const tree of trees.remove) lines.push(`    tree ${tree.path}  created during the phase — removed`);
  for (const entry of branches.reset) lines.push(`    branch ${entry.branch}  ${entry.from.slice(0, 10)} -> ${entry.to.slice(0, 10)}${entry.tree ? `  (in ${entry.tree})` : ''}`);
  for (const entry of branches.recreate) lines.push(`    branch ${entry.branch}  recreated at ${entry.to.slice(0, 10)}`);
  for (const entry of branches.drop) lines.push(`    branch ${entry.branch}  created during the phase — deleted (tip ${entry.sha.slice(0, 10)} kept)`);
  for (const tree of trees.add) lines.push(`    tree ${tree.path}  added back on ${tree.branch ?? `a detached ${String(tree.head).slice(0, 10)}`}`);
  for (const entry of artefacts) lines.push(`    ${entry.change.padEnd(9)} ${entry.file}`);
  const count =
    tasks.length + trees.remove.length + trees.add.length + trees.restore.length + branches.reset.length + branches.recreate.length + branches.drop.length + artefacts.length +
    (trees.switchMain ? 1 : 0);
  if (count === 0) lines.push('    nothing: branches, trees and artefacts are as they were');
  if (branches.reset.length + branches.drop.length > 0) lines.push('    the present tips are kept under refs/pdkit-backup/, so no commit becomes unreachable');
  if (!Array.isArray(meta.trees)) lines.push(`    ${meta.id} predates recorded trees: only trees holding a deleted branch are touched`);

  lines.push('', '  stays:');
  for (const ref of published) lines.push(`    ${ref}  moved on the remote — what was pushed stays pushed`);
  lines.push(`    the journal: ${journal.length} entr${journal.length === 1 ? 'y' : 'ies'} since the checkpoint, append-only`);
  for (const entry of journal) lines.push(`      ${entry}`);
  lines.push('    anything posted on GitHub: replies, comments, an opened issue');

  return `${lines.join('\n')}\n`;
}
