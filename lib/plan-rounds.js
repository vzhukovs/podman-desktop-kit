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

// The plan as each review round saw it, and what has changed in it since.
//
// A revision edits plan.md and tasks/ in place, and each review used to start
// cold: the version the last round read was kept nowhere, so the next critic
// had nothing to compare with and read the whole plan again — at nearly the
// cost of the first round, every round. A round narrowed by hand to what had
// changed cost about a third of that.
//
// So each review starts by copying the plan it is about to read into
// `reviews/r<k>/`, and this module answers what changed since: the tasks added
// and removed, the parts of each task that changed and in which file, whether
// the frozen interfaces, the slice hypothesis or the upstream compliance
// changed, and a text diff cut to a number of lines. `structural` says whether
// the change touched what a review of the parts alone cannot see — the set of
// tasks, a frozen interface, the slice hypothesis. Whether a round reviews the
// change or the whole plan is /pd:plan-review's call, made from these facts.
//
// The plan-review.md files are plan-review.js's; this module reads only which
// round they are at, so that a snapshot is named after the round that reads it.

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TASK_PARTS, frozenInterfaces, parsePlan, planParts, taskParts } from './artefacts.js';
import { issueDir, resolveHome } from './config.js';
import { planAreas } from './plan-areas.js';
import * as planReview from './plan-review.js';
import { unified } from './text-diff.js';

/** The directory under the issue that holds one snapshot per round. */
export const SNAPSHOTS = 'reviews';

/** How many lines of text diff `diff` returns, headers included, unless told otherwise. */
export const DIFF_LINES = 150;

/** The plan's parts outside its tasks that a diff names: its key in `plan`, and the heading. */
export const PLAN_SECTIONS = {
  frozenInterfaces: 'Frozen interfaces',
  sliceHypothesis: 'Slice hypothesis',
  upstreamCompliance: 'Upstream compliance',
};

const SNAPSHOT = /^r(\d+)$/;
const TASK_FILE = /^tasks\/(T\d+)\.md$/;

/** Task IDs and task file paths in plan order: by number, then by name. */
function byNumber(left, right) {
  const number = (name) => Number.parseInt(/T(\d+)/.exec(name)?.[1] ?? '', 10);
  const a = number(left);
  const b = number(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) === Number.isNaN(b) ? left.localeCompare(right) : Number.isNaN(a) ? 1 : -1;
  return a - b || left.localeCompare(right);
}

/**
 * The plan's files in a directory: plan.md, then every `tasks/*.md`, keyed by
 * path relative to it.
 *
 * @param {string} dir
 * @returns {Promise<Map<string, string>|null>} null when there is no plan.md
 */
async function planFiles(dir) {
  const plan = await readFile(join(dir, 'plan.md'), 'utf8').catch(() => null);
  if (plan === null) return null;

  const files = new Map([['plan.md', plan]]);
  const names = (await readdir(join(dir, 'tasks')).catch(() => [])).filter((name) => name.endsWith('.md')).sort(byNumber);
  for (const name of names) files.set(`tasks/${name}`, await readFile(join(dir, 'tasks', name), 'utf8'));
  return files;
}

/**
 * The latest review round on disk, and the one a review writes next.
 *
 * @param {number} issue
 * @param {string} home
 * @returns {Promise<{last: number, next: number}>}   `last` 0 when there is no review yet
 */
async function roundsOf(issue, home) {
  const last = (await planReview.rounds(issue, { home })).at(-1)?.round ?? 0;
  return { last, next: last + 1 };
}

/**
 * The rounds that have a snapshot, oldest first.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<number[]>}
 */
export async function snapshots(issue, options = {}) {
  const dir = join(issueDir(options.home ?? resolveHome(), issue), SNAPSHOTS);
  return (await readdir(dir).catch(() => []))
    .map((name) => SNAPSHOT.exec(name))
    .filter((found) => found !== null)
    .map((found) => Number.parseInt(found[1], 10))
    .sort((a, b) => a - b);
}

/**
 * Copy plan.md and tasks/*.md to `reviews/r<k>/`, `k` being the round a review
 * writes next: the one after the latest plan-review*.md.
 *
 * Idempotent for the same round. A snapshot already there with the same files
 * is left as it is; one that differs is replaced, because until the round's
 * review is written the snapshot is the plan that review is about to read. A
 * review on disk moves the round on, so an earlier round's snapshot is never
 * touched.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<{ok: true, round: number, path: string, files: string[], outcome: 'taken'|'unchanged'|'replaced'} | {ok: false, error: string}>}
 */
export async function snapshot(issue, options = {}) {
  const home = options.home ?? resolveHome();
  const dir = issueDir(home, issue);
  const files = await planFiles(dir);
  if (files === null) return { ok: false, error: `${join(dir, 'plan.md')} does not exist` };

  const { next } = await roundsOf(issue, home);
  const path = join(dir, SNAPSHOTS, `r${next}`);
  const existing = await planFiles(path);
  const same = existing !== null && existing.size === files.size && [...files].every(([name, text]) => existing.get(name) === text);
  if (same) return { ok: true, round: next, path, files: [...files.keys()], outcome: 'unchanged' };

  // Written beside it and then moved into place, so an interrupted copy never
  // leaves a snapshot that is half one plan.
  const partial = join(dir, SNAPSHOTS, `.r${next}.partial`);
  await rm(partial, { recursive: true, force: true });
  await mkdir(join(partial, 'tasks'), { recursive: true });
  for (const [name, text] of files) await writeFile(join(partial, name), text);
  await rm(path, { recursive: true, force: true });
  await rename(partial, path);

  return { ok: true, round: next, path, files: [...files.keys()], outcome: existing === null ? 'taken' : 'replaced' };
}

/**
 * @typedef {object} TaskChange
 * @property {string} id
 * @property {Array<{part: string, in: string[]}>} parts   the TASK_PARTS that changed, in that order, each with the files it changed in
 * @property {Neighbors} neighbors
 */

/**
 * What a changed task sits next to in the plan as it is now.
 *
 * @typedef {object} Neighbors
 * @property {string[]} after        the live tasks it waits on
 * @property {string[]} waitedOnBy   the live tasks that wait on it
 * @property {Array<{line: number, head: string, declares: string[], with: string[]}>} interfaces
 *   each frozen interface entry it is in, with the other tasks in it
 */

/**
 * @typedef {object} PlanDiff
 * @property {number} issue
 * @property {number} round        the round a review writes next
 * @property {number} lastRound    the latest review round on disk, 0 when none
 * @property {{round: number, path: string}|null} base   the snapshot compared with; null when there is none
 * @property {boolean|null} structural   tasks added or removed, frozen interfaces or slice hypothesis changed; null with no base
 * @property {string[]} because    what made it structural, one phrase each
 * @property {{added: string[], removed: string[], changed: TaskChange[]}} tasks
 * @property {{frozenInterfaces: boolean, sliceHypothesis: boolean, upstreamCompliance: boolean}|null} plan   null with no base
 * @property {string[]} other      the other parts of plan.md that changed, by heading; `header` for the lines above the first section
 * @property {{lines: string[], total: number}} text   the diff, at most the lines asked for, and how many it has in all
 */

/**
 * The tasks a plan names, in plan.md or as a task file.
 *
 * @param {Map<string, string>} files
 * @param {ReturnType<typeof planParts>} parts
 * @returns {string[]}
 */
function taskIds(files, parts) {
  const fromFiles = [...files.keys()].map((name) => TASK_FILE.exec(name)?.[1]).filter((id) => id !== undefined);
  return [...new Set([...parts.tasks.keys(), ...fromFiles])].sort(byNumber);
}

/** Whether a name is in a text as a whole identifier. */
function mentions(text, name) {
  return new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`).test(text);
}

/**
 * The neighbors of a task: its After edges both ways among live tasks, and the
 * frozen interface entries it is in.
 *
 * A task is in an entry when the entry names its ID, or when the task — its
 * block in plan.md or its task file — names something the entry declares,
 * which is how a consumer of an interface shows up, since the comment names
 * the task that defines it. The task file is where a task's steps and context
 * are written; a plan from before that split has them in plan.md as well.
 *
 * @param {string} id
 * @param {ReturnType<typeof planAreas>} map
 * @param {Array<{line: number, head: string, declares: string[], members: Set<string>}>} entries
 * @returns {Neighbors}
 */
function neighborsOf(id, map, entries) {
  const edges = map.tasks.find((task) => task.id === id);
  return {
    after: edges?.after ?? [],
    waitedOnBy: edges?.waitedOnBy ?? [],
    interfaces: entries
      .filter((entry) => entry.members.has(id))
      .map((entry) => ({ line: entry.line, head: entry.head, declares: entry.declares, with: [...entry.members].filter((other) => other !== id).sort(byNumber) })),
  };
}

/**
 * The current plan against the snapshot of the plan the last round reviewed.
 *
 * The snapshot compared with is that of the latest round with a review on
 * disk — the version that review read — and with none, the newest there is,
 * which can be the one taken for the round now under way. `base.round` says
 * which; a round whose review predates snapshots has none, and then `base` is
 * null and nothing is compared.
 *
 * @param {number} issue
 * @param {{home?: string, withdrawn?: Record<string, {replacedBy?: string[]}>, maxLines?: number}} [options]
 * @returns {Promise<({ok: true} & PlanDiff) | {ok: false, error: string}>}
 */
export async function diff(issue, options = {}) {
  const home = options.home ?? resolveHome();
  const dir = issueDir(home, issue);
  const now = await planFiles(dir);
  if (now === null) return { ok: false, error: `${join(dir, 'plan.md')} does not exist` };

  const { last, next } = await roundsOf(issue, home);
  const taken = await snapshots(issue, { home });
  const baseRound = taken.filter((round) => round <= last).at(-1) ?? taken.at(-1) ?? null;
  const basePath = baseRound === null ? null : join(dir, SNAPSHOTS, `r${baseRound}`);
  const before = basePath === null ? null : await planFiles(basePath);

  const nothing = { added: [], removed: [], changed: [] };
  if (before === null || basePath === null || baseRound === null) {
    return { ok: true, issue, round: next, lastRound: last, base: null, structural: null, because: [], tasks: nothing, plan: null, other: [], text: { lines: [], total: 0 } };
  }

  const was = planParts(/** @type {string} */ (before.get('plan.md')));
  const is = planParts(/** @type {string} */ (now.get('plan.md')));
  const wasIds = taskIds(before, was);
  const isIds = taskIds(now, is);
  const added = isIds.filter((id) => !wasIds.includes(id));
  const removed = wasIds.filter((id) => !isIds.includes(id));

  // Neighbors are read off the plan as it is now: the change is reviewed
  // against what surrounds it after the revision, not before.
  const current = /** @type {string} */ (now.get('plan.md'));
  const map = planAreas(parsePlan(current), options.withdrawn ?? {});
  const textOf = (id) => [...(is.tasks.get(id)?.values() ?? []), now.get(`tasks/${id}.md`) ?? ''].join('\n');
  const entries = frozenInterfaces(current).map((entry) => {
    const named = isIds.filter((id) => entry.declares.some((name) => mentions(textOf(id), name)));
    return { ...entry, members: new Set([...entry.tasks, ...named]) };
  });

  /** @type {TaskChange[]} */
  const changed = [];
  for (const id of isIds.filter((entry) => wasIds.includes(entry))) {
    const file = `tasks/${id}.md`;
    const sides = [
      ['plan.md', was.tasks.get(id) ?? new Map(), is.tasks.get(id) ?? new Map()],
      [file, before.has(file) ? taskParts(/** @type {string} */ (before.get(file))) : new Map(), now.has(file) ? taskParts(/** @type {string} */ (now.get(file))) : new Map()],
    ];
    const parts = TASK_PARTS.map((part) => ({
      part,
      in: sides.filter(([, old, fresh]) => (old.get(part) ?? '') !== (fresh.get(part) ?? '')).map(([name]) => /** @type {string} */ (name)),
    })).filter((entry) => entry.in.length > 0);
    if (parts.length > 0) changed.push({ id, parts, neighbors: neighborsOf(id, map, entries) });
  }

  const section = (parts, name) => parts.sections.get(name) ?? '';
  const plan = {
    frozenInterfaces: section(was, 'Frozen interfaces') !== section(is, 'Frozen interfaces'),
    sliceHypothesis:
      section(was, 'Slice hypothesis') !== section(is, 'Slice hypothesis') ||
      parsePlan(/** @type {string} */ (before.get('plan.md'))).sliceCount !== parsePlan(current).sliceCount,
    upstreamCompliance: section(was, 'Upstream compliance') !== section(is, 'Upstream compliance'),
  };
  const other = [...new Set([...was.sections.keys(), ...is.sections.keys()])]
    .filter((name) => !Object.values(PLAN_SECTIONS).includes(name) && section(was, name) !== section(is, name))
    .map((name) => (name === '' ? 'header' : name));

  const because = [
    ...(added.length > 0 ? [`tasks added: ${added.join(', ')}`] : []),
    ...(removed.length > 0 ? [`tasks removed: ${removed.join(', ')}`] : []),
    ...(plan.frozenInterfaces ? ['Frozen interfaces changed'] : []),
    ...(plan.sliceHypothesis ? ['Slice hypothesis changed'] : []),
  ];

  const files = [...new Set([...before.keys(), ...now.keys()])].sort((a, b) => (a === 'plan.md' ? -1 : b === 'plan.md' ? 1 : byNumber(a, b)));
  const lines = files.flatMap((name) => {
    const hunks = unified(before.get(name) ?? '', now.get(name) ?? '', { context: 1 });
    if (hunks.length === 0) return [];
    return [before.has(name) ? `--- r${baseRound}/${name}` : '--- /dev/null', now.has(name) ? `+++ ${name}` : '+++ /dev/null', ...hunks];
  });

  return {
    ok: true,
    issue,
    round: next,
    lastRound: last,
    base: { round: baseRound, path: basePath },
    structural: because.length > 0,
    because,
    tasks: { added, removed, changed },
    plan,
    other,
    text: { lines: lines.slice(0, options.maxLines ?? DIFF_LINES), total: lines.length },
  };
}
