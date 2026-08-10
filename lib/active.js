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

// Which task is running in which working tree.
//
// The missing piece of the model until stage 2. state.json knew that T1 owns
// three files; nothing could tell that T1 is what is running *here*. Three
// hooks need that answer: pre-write to decide a write, task-completed to know
// which receipt to demand, session-start to know what to re-anchor to.
//
// Keyed on the working tree rather than stored on the issue, and that is the
// whole design. Five worktrees share one $PDKIT_HOME (section 0), and two of
// them can be on the same issue at different slices, so "what is running" is a
// property of the tree. A field on the issue record could not express it, and
// writing one would need a second writer of state.json — the thing invariant 1
// exists to prevent.
//
// Same shape as lib/gate.js: one file per unit, one owner, no index to fall out
// of sync with the files.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { paths, resolveHome } from './config.js';
import { append as appendJournal } from './journal.js';
import { worktreeRoot } from './repo.js';

/**
 * @typedef {object} Active
 * @property {number} issue
 * @property {string} taskId
 * @property {string} worktree  absolute path
 * @property {string} startedAt ISO 8601
 */

/**
 * File name for a working tree.
 *
 * A hash rather than the encoded path: these paths are long and nested, and a
 * directory of them would be unreadable either way. The readable form lives
 * inside the file, and `pdkit task show` is how it is read.
 *
 * @param {string} worktree
 * @returns {string}
 */
export function keyFor(worktree) {
  return createHash('sha256').update(resolve(worktree)).digest('hex').slice(0, 16);
}

/**
 * @param {string} home
 * @param {string} worktree
 * @returns {string}
 */
function pointerPath(home, worktree) {
  return join(paths(home).active, `${keyFor(worktree)}.json`);
}

/**
 * Resolve the working tree a directory belongs to.
 *
 * Returns null outside a repository, and callers treat that as "no active
 * task" rather than as an error: writes to the state directory or to notes
 * happen outside any tree and are none of this module's business.
 *
 * @param {string} [cwd]
 * @returns {Promise<string|null>}
 */
export async function worktreeFor(cwd) {
  return worktreeRoot(cwd);
}

/**
 * Mark a task as the one running in a working tree.
 *
 * @param {{issue: number, taskId: string, worktree: string, home?: string}} input
 * @returns {Promise<Active>}
 */
export async function start(input) {
  const home = input.home ?? resolveHome();
  const worktree = resolve(input.worktree);

  /** @type {Active} */
  const record = {
    issue: input.issue,
    taskId: input.taskId,
    worktree,
    startedAt: new Date().toISOString(),
  };

  await mkdir(paths(home).active, { recursive: true });
  await writeFile(pointerPath(home, worktree), `${JSON.stringify(record, null, 2)}\n`);

  await appendJournal(
    { issue: input.issue, event: 'task-start', detail: `${input.taskId} in ${worktree}` },
    { home },
  );

  return record;
}

/**
 * What is running in a working tree, or null.
 *
 * Fails to null on an unreadable file rather than throwing. The opposite
 * choice would let a corrupt pointer block every write in the tree, and the
 * ownership rule is not worth that: the audit still counts files written
 * outside any Owns set, so a missed hook is caught, just later.
 *
 * @param {{worktree?: string, cwd?: string, home?: string}} [options]
 * @returns {Promise<Active|null>}
 */
export async function current(options = {}) {
  const home = options.home ?? resolveHome();
  const worktree = options.worktree ?? (await worktreeFor(options.cwd));
  if (!worktree) return null;

  try {
    const record = JSON.parse(await readFile(pointerPath(home, worktree), 'utf8'));
    // The file is named after the tree, so this can only disagree if it was
    // moved by hand. Trusting the name over the content would apply one tree's
    // ownership rules to another.
    if (resolve(record.worktree) !== resolve(worktree)) return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * Clear the pointer for a working tree.
 *
 * @param {{worktree?: string, cwd?: string, home?: string}} [options]
 * @returns {Promise<{ok: boolean, record?: Active}>}
 */
export async function stop(options = {}) {
  const home = options.home ?? resolveHome();
  const worktree = options.worktree ?? (await worktreeFor(options.cwd));
  if (!worktree) return { ok: false };

  const record = await current({ worktree, home });
  await rm(pointerPath(home, worktree), { force: true });

  if (record) {
    await appendJournal(
      { issue: record.issue, event: 'task-stop', detail: `${record.taskId} in ${worktree}` },
      { home },
    );
  }

  return { ok: true, ...(record ? { record } : {}) };
}

/**
 * Every working tree with a task running in it. Used by `pdkit task show`
 * without a repository, and by doctor.
 *
 * @param {{home?: string}} [options]
 * @returns {Promise<Active[]>}
 */
export async function list(options = {}) {
  const home = options.home ?? resolveHome();

  let entries;
  try {
    entries = await readdir(paths(home).active);
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      found.push(JSON.parse(await readFile(join(paths(home).active, entry), 'utf8')));
    } catch {
      // A pointer that does not parse is one nothing can act on. Reporting it
      // here would put the noise in every listing; doctor is where problems go.
    }
  }

  return found.sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
}
