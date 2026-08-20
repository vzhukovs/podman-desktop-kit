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

// Starting one issue over: what the plugin is allowed to forget, and what it
// is not.
//
// The failure this closes is ordinary and had no answer. A run goes wrong —
// the triage read the issue as something it is not, the scouts mapped the
// wrong package, a plan was approved that should not have been — and the next
// full cycle has to start from nothing. It could not: `research.md`,
// `archaeology.json` and `plan.md` are read by whatever runs next, the state
// machine has no edge back to `new`, and the only way out was `rm -rf` on a
// directory whose neighbours share a parent. That is a command nobody should
// have to type carefully at midnight.
//
// **This is not a transition, and it must not become one.** There is no edge
// into `new` in section 1 and adding one would be a lie: the history would
// then show a trip the work never took, and `adopted` exists precisely so that
// "these artefacts were never produced" reads differently from "these
// artefacts were lost". Removing the record instead puts `state.read` back on
// `blank()`, which is the machine's own word for nothing has happened here —
// and `new -> triaged` is the only way out of it, so the next cycle is forced
// to start where a cycle starts.
//
// Four stores hold something about an issue, and they do not get the same
// treatment. Two are ours to forget:
//
//   issues/<n>/   every artefact — archived by default, deleted on --purge
//   gates/        tokens carrying this issue's number
//   active/       pointers naming a task of this issue, in any working tree
//
// The journal is NOT, and that is invariant 2 rather than a preference. It has
// no rewrite and no delete, so a reset appends to it like everything else: one
// `reset` entry, saying what the issue was and where its record went. The
// property that buys is the one that matters most here — an issue that comes
// back at `new` after a wipe would otherwise be indistinguishable from one
// nobody ever worked on, and the journal is what keeps the earlier attempt
// legible to whoever asks in six months.
//
// Two consequences of that, both deliberate and both stated to the user rather
// than discovered:
//
//   - Deferrals survive. They are derived from the journal (lib/deferrals.js)
//     because a promise made to a reviewer outlives the issue reaching a
//     terminal state — and it equally outlives us deciding to start over.
//     Nothing local releases you from something you said on someone else's
//     pull request.
//   - Nothing upstream moves. A pull request stays open, a comment stays
//     posted. The plugin forgets them; GitHub does not, and the self-healing
//     is already in place: `pdkit issue fetch` lists linked pull requests and
//     dedup is triage's first step, so the next cycle rediscovers what this
//     one forgot.
//
// Worktrees are a fourth case and sit outside $PDKIT_HOME entirely. A branch
// with unpushed commits on it is work, not a record of work, so removal is
// opt-in and still goes through lib/worktree.js — which refuses a tree holding
// a branch that has not landed. A command whose name is "start over" must not
// be the thing that silently drops commits.

import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import * as active from './active.js';
import { issueDir, paths, resolveHome } from './config.js';
import { open as openDeferrals } from './deferrals.js';
import * as gate from './gate.js';
import { parseBranch } from './ids.js';
import { RESET_EVENT, append as appendJournal, read as readJournal } from './journal.js';
import { read as readPullRequests } from './pr.js';
import { read as readState } from './state.js';
import * as worktree from './worktree.js';

/**
 * The journal event a reset writes.
 *
 * The name is defined in lib/journal.js, because lib/attempts.js needs it too:
 * the attempt count is derived from the journal, so without stopping at this
 * event a task numbered T1 after a reset would inherit the failures of the T1
 * before it and could be born blocked.
 */
export const EVENT = RESET_EVENT;

/**
 * Whether a working tree belongs to an issue.
 *
 * Exact rather than a substring test, and the difference is the whole promise
 * of this command: `path.includes('DESKTOP-1854')` is true of
 * `.../DESKTOP-18548`, so a loose match on issue 1854 would offer to delete the
 * tree of an issue nobody named.
 *
 * Two ways to belong, because a tree can be on the issue's branch under any
 * name, and the verification tree is detached and has no branch at all — which
 * is exactly why it is named after the issue.
 *
 * @param {import('./worktree.js').Worktree} tree
 * @param {number} issue
 * @returns {boolean}
 */
export function belongsTo(tree, issue) {
  if (parseBranch(String(tree.branch ?? ''))?.issue === issue) return true;

  const base = tree.path.split('/').pop() ?? '';
  return base === `DESKTOP-${issue}` || base === worktree.verifyName(issue);
}

/**
 * What is inside the issue directory, one line per entry, directories counted.
 *
 * A listing rather than a tree: the reader is deciding whether to go ahead, and
 * "receipts/ (4)" is the size of that decision where four more lines of file
 * names are not. Dotfiles are left out — `.DS_Store` is not an artefact anybody
 * is weighing.
 *
 * @param {string} dir
 * @returns {Promise<string[]|null>} null when the directory is not there
 */
async function inventory(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const lines = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) {
      lines.push(entry.name);
      continue;
    }
    const inner = await readdir(join(dir, entry.name)).catch(() => []);
    lines.push(`${entry.name}/ (${inner.filter((name) => !name.startsWith('.')).length})`);
  }

  return lines;
}

/**
 * @typedef {object} Facts
 * @property {number} issue
 * @property {string} state          where the machine has it now
 * @property {string|null} route
 * @property {boolean} adopted
 * @property {string|null} dir       the issue directory, when there is one
 * @property {string[]} artefacts    what is inside it
 * @property {string[]} tokens       consent tokens carrying this issue
 * @property {Array<{worktree: string, taskId: string}>} active
 * @property {Array<{path: string, branch: string|null}>} worktrees
 * @property {number[]} pullRequests      every number registered for the issue
 * @property {number[]} openPullRequests  the ones GitHub still shows open
 * @property {number} journalEntries      what stays, because it always stays
 * @property {Array<object>} deferred     promises the journal keeps
 * @property {boolean} anything           whether there is a thing to clear
 */

/**
 * Everything a reset would touch, and the things it would not.
 *
 * Read in full before anything is removed, and that ordering is load-bearing
 * twice over. The pull request numbers live in `prs.json` inside the directory
 * about to be moved, and the reply tokens keyed by those numbers cannot be
 * attributed afterwards; and the state and route are the substance of the
 * journal entry, which is written once the work is done.
 *
 * @param {{issue: number, repoRoot?: string|null, home?: string}} input
 * @returns {Promise<Facts>}
 */
export async function collect(input) {
  const home = input.home ?? resolveHome();
  const issue = input.issue;

  const record = await readState(issue, { home });
  const dir = issueDir(home, issue);
  const artefacts = await inventory(dir);

  const tokens = (await gate.issuedFor(issue, { home })).map((token) => token.key);
  const pointers = (await active.list({ home }))
    .filter((pointer) => pointer.issue === issue)
    .map((pointer) => ({ worktree: pointer.worktree, taskId: pointer.taskId }));

  const trees = (input.repoRoot ? await worktree.list(input.repoRoot) : [])
    .filter((tree) => !tree.main && belongsTo(tree, issue))
    .map((tree) => ({ path: tree.path, branch: tree.branch }));

  // Read through the module that owns prs.json rather than the file: a second
  // reader of that shape is a second thing to update when it changes, and the
  // list this produces decides which reply tokens are dropped.
  const book = await readPullRequests(issue, { home });
  const pullRequests = (book?.prs ?? []).map((entry) => entry.number);
  const openPullRequests = (book?.prs ?? []).filter((entry) => entry.state === 'open').map((entry) => entry.number);

  const entries = await readJournal({ issue }, { home });
  const deferred = await openDeferrals({ issue, home });

  return {
    issue,
    state: record.state,
    route: record.route,
    adopted: Boolean(record.adopted),
    dir: artefacts === null ? null : dir,
    artefacts: artefacts ?? [],
    tokens,
    active: pointers,
    worktrees: trees,
    pullRequests,
    openPullRequests,
    journalEntries: entries.length,
    deferred,
    anything: artefacts !== null || tokens.length > 0 || pointers.length > 0 || trees.length > 0,
  };
}

/**
 * Where an archived record goes.
 *
 * One directory per reset rather than one per issue, because starting over
 * twice is a thing that happens and the second archive must not land on top of
 * the first. Seconds are enough to separate two runs a person made; the suffix
 * is there for the case where they are not, so a collision costs a name rather
 * than the earlier archive.
 *
 * @param {string} home
 * @param {number} issue
 * @param {Date} [when]
 * @returns {Promise<string>}
 */
async function archivePath(home, issue, when = new Date()) {
  const stamp = when.toISOString().slice(0, 19).replace(/[:T]/g, (match) => (match === 'T' ? '-' : ''));
  const base = join(paths(home).archive, String(issue));
  await mkdir(base, { recursive: true });

  const taken = new Set(await readdir(base).catch(() => []));
  if (!taken.has(stamp)) return join(base, stamp);

  for (let n = 2; ; n += 1) {
    if (!taken.has(`${stamp}-${n}`)) return join(base, `${stamp}-${n}`);
  }
}

/**
 * @typedef {object} Outcome
 * @property {number} issue
 * @property {string} from            the state the record was in
 * @property {string|null} archived   where the artefacts went, null when purged
 * @property {boolean} purged
 * @property {boolean} removed        whether there was a directory at all
 * @property {string[]} tokens        keys dropped
 * @property {string[]} active        working trees whose pointer was cleared
 * @property {Array<{path: string, removed: boolean, error?: string}>} worktrees
 */

/**
 * Forget one issue.
 *
 * Order matters. The pointers go first, so no hook is left holding a task whose
 * file is about to disappear; the tokens next, so consent cannot outlive the
 * record that justified it; the artefacts after that. The journal entry is
 * written last, because it reports what happened rather than what was intended
 * — a rename that failed must not be recorded as an archive that exists.
 *
 * @param {{issue: number, facts?: Facts, repoRoot?: string|null, config?: object, home?: string, purge?: boolean, worktrees?: boolean, force?: boolean}} input
 * @returns {Promise<Outcome>}
 */
export async function apply(input) {
  const home = input.home ?? resolveHome();
  const issue = input.issue;
  const facts = input.facts ?? (await collect({ issue, repoRoot: input.repoRoot, home }));

  for (const pointer of facts.active) {
    await active.stop({ worktree: pointer.worktree, home });
  }

  const tokens = await gate.revokeFor(issue, { home });

  let archived = null;
  let removed = false;
  if (facts.dir) {
    if (input.purge) {
      await rm(facts.dir, { recursive: true, force: true });
    } else {
      archived = await archivePath(home, issue);
      await rename(facts.dir, archived);
    }
    removed = true;
  }

  /** @type {Array<{path: string, removed: boolean, error?: string}>} */
  const trees = [];
  if (input.worktrees) {
    for (const tree of facts.worktrees) {
      const result = await worktree.remove({
        repoRoot: /** @type {string} */ (input.repoRoot),
        name: tree.path.split('/').pop() ?? '',
        issue,
        config: input.config,
        home,
        force: Boolean(input.force),
      });
      trees.push({ path: tree.path, removed: Boolean(result.ok && result.removed), ...(result.error ? { error: result.error } : {}) });
    }
  }

  await appendJournal(
    {
      issue,
      event: EVENT,
      detail: [
        `was ${facts.state}${facts.route ? ` (${facts.route})` : ''}`,
        facts.openPullRequests.length
          ? `${facts.openPullRequests.map((number) => `#${number}`).join(', ')} left open upstream`
          : null,
        removed ? (archived ? `record archived to ${archived}` : 'record purged') : 'no record on disk',
        tokens.length ? `${tokens.length} token(s) revoked` : null,
        facts.active.length ? `${facts.active.length} active pointer(s) cleared` : null,
        trees.filter((tree) => tree.removed).length ? `${trees.filter((tree) => tree.removed).length} worktree(s) removed` : null,
      ]
        .filter(Boolean)
        .join('; '),
    },
    { home },
  );

  return {
    issue,
    from: facts.state,
    archived,
    purged: Boolean(input.purge),
    removed,
    tokens,
    active: facts.active.map((pointer) => pointer.worktree),
    worktrees: trees,
  };
}

/**
 * The dry run, as a person reads it.
 *
 * Two halves, and the second is the one that stops a mistake: what goes, then
 * what stays. Somebody reaching for this command believes it undoes the work,
 * and the open pull request it will not close is the item worth reading twice.
 *
 * @param {Facts} facts
 * @param {{purge?: boolean, worktrees?: boolean}} [options]
 * @returns {string}
 */
export function format(facts, options = {}) {
  const lines = [`DESKTOP-${facts.issue} is ${facts.state}${facts.route ? `, ${facts.route}` : ''}${facts.adopted ? ', adopted' : ''}`];

  if (!facts.anything) {
    lines.push('  nothing to clear: no record, no tokens, no active task, no worktree');
    return `${lines.join('\n')}\n`;
  }

  lines.push('', options.purge ? '  would delete:' : '  would archive:');
  if (facts.dir) {
    lines.push(`    ${facts.dir}`);
    for (const entry of facts.artefacts) lines.push(`      ${entry}`);
    if (facts.artefacts.length === 0) lines.push('      (empty)');
  } else {
    lines.push('    nothing — there is no directory for this issue');
  }

  for (const key of facts.tokens) lines.push(`  would revoke: ${key}`);
  for (const pointer of facts.active) lines.push(`  would clear: ${pointer.taskId} active in ${pointer.worktree}`);

  for (const tree of facts.worktrees) {
    lines.push(
      options.worktrees
        ? `  would remove: ${tree.path}${tree.branch ? ` (${tree.branch})` : ' (detached)'}`
        : `  would keep: ${tree.path}${tree.branch ? ` (${tree.branch})` : ' (detached)'} — pass --worktrees to remove it`,
    );
  }

  lines.push('', '  stays:');
  lines.push(`    ${facts.journalEntries} journal entr${facts.journalEntries === 1 ? 'y' : 'ies'} — the journal is append-only, and the earlier attempt stays legible`);

  if (facts.openPullRequests.length) {
    lines.push(
      `    ${facts.openPullRequests.map((number) => `#${number}`).join(', ')} — OPEN UPSTREAM. This forgets them; it does not close them.`,
      '      Close or withdraw them yourself if starting over means they should not stand.',
    );
  } else if (facts.pullRequests.length) {
    lines.push(`    ${facts.pullRequests.map((number) => `#${number}`).join(', ')} — published, and unaffected by anything local`);
  }

  for (const entry of facts.deferred) {
    lines.push(`    ${entry.id} deferred, still open — ${entry.what}`);
  }
  if (facts.deferred.length) {
    lines.push('      A promise made to a reviewer is not undone by starting over locally.');
  }

  return `${lines.join('\n')}\n`;
}
