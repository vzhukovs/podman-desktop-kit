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
//               its DESKTOP-<n>/… branches, local and remote, and how many
//               journal entries it had
//
// `rollback` compares now against that. It brings back what is ours to bring
// back, and names what is not:
//
//   - local branches are reset to the heads they had. The tip they had a
//     moment ago is kept under refs/pdkit-backup/, so nothing is lost —
//     rollback is about the record of work, and the work stays reachable;
//   - artefacts are restored from the copy. What was there is archived, as
//     reset does, never deleted;
//   - the state record comes back through lib/state.js, and only when the
//     phase did not move the issue to another state (see state.restore);
//   - anything published stays: a remote branch that moved, a reply posted.
//     So does the journal. It is append-only, and rollback adds one entry
//     saying what it undid.
//
// Branches created during the phase are listed and left alone. A branch
// nobody pushed is work, and a command whose job is to go back must not be
// the thing that drops it.

import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { issueDir, paths, resolveHome } from './config.js';
import { append as appendJournal, read as readJournal } from './journal.js';
import * as state from './state.js';
import { list as listWorktrees } from './worktree.js';

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
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath ?? entry.path, entry.name)))
    .sort();
}

/**
 * The heads of an issue's branches: `DESKTOP-<n>/…`, local and on every remote.
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

  const prefix = `DESKTOP-${issue}/`;
  const listed = await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/remotes/'], repoRoot);
  for (const line of listed.stdout.split('\n')) {
    const [ref, sha] = line.trim().split(' ');
    if (!ref || !sha) continue;
    if (ref.startsWith(`refs/heads/${prefix}`)) local[ref.slice('refs/heads/'.length)] = sha;
    else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length);
      if (name.slice(name.indexOf('/') + 1).startsWith(prefix)) remote[name] = sha;
    }
  }
  return { local, remote };
}

/**
 * @typedef {object} Meta
 * @property {string} id
 * @property {number} issue
 * @property {string} phase
 * @property {string} at
 * @property {object} record           the state record as it was
 * @property {{local: Record<string, string>, remote: Record<string, string>}} branches
 * @property {number} journal          entries the issue had
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

  // Branches.
  const now = await heads(input.issue, input.repoRoot);
  const trees = input.repoRoot ? await listWorktrees(input.repoRoot) : [];
  const reset = [];
  const recreate = [];
  const created = [];
  const refused = [];
  for (const [branch, sha] of Object.entries(meta.branches.local)) {
    const current = now.local[branch];
    if (current === sha) continue;
    if (current === undefined) {
      recreate.push({ branch, to: sha });
      continue;
    }
    const tree = trees.find((entry) => entry.branch === branch);
    if (tree) {
      const status = await git(['status', '--porcelain'], tree.path);
      if (status.stdout.trim()) {
        refused.push({ branch, reason: `checked out in ${tree.path} with uncommitted changes` });
        continue;
      }
    }
    reset.push({ branch, from: current, to: sha, tree: tree?.path ?? null });
  }
  for (const branch of Object.keys(now.local)) {
    if (!(branch in meta.branches.local)) created.push(branch);
  }
  const published = Object.keys({ ...meta.branches.remote, ...now.remote }).filter((ref) => meta.branches.remote[ref] !== now.remote[ref]);

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
    branches: { reset, recreate, created, refused },
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
  const { meta, stateMoved, branches } = input.plan;

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
  if ((branches.reset.length > 0 || branches.recreate.length > 0) && !input.repoRoot) {
    return { ok: false, error: 'branches have to be reset, and there is no repository here — run it from the fork' };
  }

  // Branches. The present tip goes under refs/pdkit-backup/ first.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backups = [];
  for (const entry of branches.reset) {
    const backup = `refs/pdkit-backup/${input.issue}/${meta.id}-${stamp}/${entry.branch}`;
    await git(['update-ref', backup, entry.from], input.repoRoot);
    backups.push(backup);
    const moved = entry.tree
      ? await git(['reset', '--hard', entry.to], entry.tree)
      : await git(['update-ref', `refs/heads/${entry.branch}`, entry.to, entry.from], input.repoRoot);
    if (!moved.ok) return { ok: false, error: `${entry.branch}: ${moved.stderr.trim()}`, backups };
  }
  for (const entry of branches.recreate) {
    const made = await git(['update-ref', `refs/heads/${entry.branch}`, entry.to], input.repoRoot);
    if (!made.ok) return { ok: false, error: `${entry.branch}: ${made.stderr.trim()}`, backups };
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

  await appendJournal(
    {
      issue: input.issue,
      event: EVENTS.rolledBack,
      detail:
        `to ${meta.id} (start of ${meta.phase}) — ${branches.reset.length + branches.recreate.length} branch(es) reset, ` +
        `${input.plan.artefacts.length} artefact(s) restored; undone since: ${input.plan.journal.join('; ') || 'nothing journalled'}`,
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
  const { meta, stateMoved, branches, published, artefacts, journal } = report;
  const lines = [`DESKTOP-${meta.issue}: back to ${meta.id}, the start of ${meta.phase} (${meta.at.slice(0, 16).replace('T', ' ')})`];

  if (stateMoved) {
    lines.push(
      '',
      `  ✘ refused: the issue moved from ${stateMoved.from} to ${stateMoved.to} during the phase.`,
      '    A transition is not undone by rewriting the record.',
    );
  }

  lines.push('', '  would bring back:');
  for (const entry of branches.reset) lines.push(`    branch ${entry.branch}  ${entry.from.slice(0, 10)} -> ${entry.to.slice(0, 10)}${entry.tree ? `  (in ${entry.tree})` : ''}`);
  for (const entry of branches.recreate) lines.push(`    branch ${entry.branch}  recreated at ${entry.to.slice(0, 10)}`);
  for (const entry of artefacts) lines.push(`    ${entry.change.padEnd(9)} ${entry.file}`);
  if (branches.reset.length + branches.recreate.length + artefacts.length === 0) lines.push('    nothing: branches and artefacts are as they were');
  if (branches.reset.length > 0) lines.push('    the present tips are kept under refs/pdkit-backup/, so no commit becomes unreachable');

  lines.push('', '  stays:');
  for (const branch of branches.created) lines.push(`    branch ${branch}  created during the phase — left alone; delete it yourself once you have looked`);
  for (const entry of branches.refused) lines.push(`    ✘ branch ${entry.branch}  ${entry.reason} — commit or stash it first`);
  for (const ref of published) lines.push(`    ${ref}  moved on the remote — what was pushed stays pushed`);
  lines.push(`    the journal: ${journal.length} entr${journal.length === 1 ? 'y' : 'ies'} since the checkpoint, append-only`);
  for (const entry of journal) lines.push(`      ${entry}`);
  lines.push('    anything posted on GitHub: replies, comments, an opened issue');

  return `${lines.join('\n')}\n`;
}
