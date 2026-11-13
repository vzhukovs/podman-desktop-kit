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

// What the plan reviews of earlier attempts at an issue raised, and what was
// decided on each item.
//
// `/pd:reset` moves `issues/<n>` to `archive/<n>/<stamp>/`, and a rollback
// moves what it replaces to `archive/<n>/rollback-<checkpoint>-<stamp>/`.
// Nothing read either back. The next attempt planned from nothing, and its
// review found the same facts about the repository again, one round at a time:
// in one issue, three facts known since the first attempt came back as review
// items in the third.
//
// Facts only: each archived review's A and B items, under their headings, with
// the decision lines recorded on them and when the attempt was archived. Which
// of them bear on the new plan is /pd:plan's judgment, not a field here.
//
// A rollback archives the files it replaces and then restores the checkpoint's,
// so the same review is often in a rollback archive and in the reset archive of
// the attempt it belongs to. A review whose text is in an earlier-listed
// archive is named as the same text rather than listed twice; reset archives
// are listed first for this, since each holds an attempt whole.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { paths, resolveHome } from './config.js';
import { REVIEW_FILE, reportIn } from './plan-review.js';

/** `/pd:reset`'s directory name: `2026-11-12-093725`, `-2` on a collision (lib/reset.js). */
const RESET_STAMP = /^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?$/;

/** A rollback's: `rollback-C1-2026-11-12T08-46-15-458Z` (lib/checkpoint.js). */
const ROLLBACK_STAMP = /^rollback-.+-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-\d{3}Z$/;

/**
 * @typedef {object} LessonDecision
 * @property {import('./plan-review.js').Verdict} verdict
 * @property {'line'|'heading'|'none'} by   what the verdict was read from
 * @property {string} text                  the decision line after the ID
 * @property {string[]} more                the lines that continue it
 */

/**
 * @typedef {object} LessonItem
 * @property {string} id                    A1, B3
 * @property {string|null} title            its heading in the report; null when only a decision names it
 * @property {LessonDecision[]} decisions   empty when the review records none for it
 */

/**
 * @typedef {object} ArchivedReview
 * @property {string} file                  plan-review.md, plan-review.r2.md
 * @property {number} round
 * @property {string|null} sameAs           `<archive>/<file>` holding the same text, listed there instead
 * @property {LessonItem[]} items           A and B only; empty when sameAs is set
 */

/**
 * @typedef {object} ArchivedAttempt
 * @property {string} dir                   the archive directory's name
 * @property {'reset'|'rollback'|'other'} kind
 * @property {string|null} archivedAt       ISO time from the name, null when it carries none
 * @property {ArchivedReview[]} reviews     by round
 */

/**
 * Kind and time of an archive directory, from its name.
 *
 * @param {string} name
 * @returns {{kind: ArchivedAttempt['kind'], archivedAt: string|null}}
 */
export function archiveName(name) {
  const reset = RESET_STAMP.exec(name);
  if (reset) return { kind: 'reset', archivedAt: `${reset[1]}T${reset[2]}:${reset[3]}:${reset[4]}Z` };
  const rollback = ROLLBACK_STAMP.exec(name);
  if (rollback) return { kind: 'rollback', archivedAt: `${rollback[1]}T${rollback[2]}:${rollback[3]}:${rollback[4]}Z` };
  return { kind: name.startsWith('rollback-') ? 'rollback' : 'other', archivedAt: null };
}

/**
 * The A and B items of one review, each with its decisions.
 *
 * @param {ReturnType<typeof reportIn>} report
 * @returns {LessonItem[]}
 */
function itemsOf(report) {
  const ids = [
    ...report.items.map((item) => item.id),
    ...report.decisions.map((decision) => decision.id),
  ].filter((id, at, all) => /^[AB]/.test(id) && all.indexOf(id) === at);

  return ids
    .sort((left, right) => left[0].localeCompare(right[0]) || Number(left.slice(1)) - Number(right.slice(1)))
    .map((id) => ({
      id,
      title: report.items.find((item) => item.id === id)?.title ?? null,
      decisions: report.decisions
        .filter((decision) => decision.id === id)
        .map(({ verdict, by, text, more }) => ({ verdict, by, text, more })),
    }));
}

/**
 * One archive directory's reviews, by round, with their text for comparing.
 *
 * @param {string} root
 * @param {string} dir
 * @returns {Promise<ArchivedAttempt & {texts: Map<string, string>}>}
 */
async function readAttempt(root, dir) {
  const names = (await readdir(join(root, dir)).catch(() => [])).filter((name) => REVIEW_FILE.test(name));
  const read = await Promise.all(
    names.map(async (file) => {
      const text = await readFile(join(root, dir, file), 'utf8');
      const report = reportIn(text);
      const named = REVIEW_FILE.exec(file)?.[1];
      // The file name first: the review moves each earlier round to
      // plan-review.r<k>.md by its round, while a title can be missing, and a
      // decision heading in an older review named rounds of its own.
      return { file, text, report, round: named ? Number.parseInt(named, 10) : report.round };
    }),
  );

  const highest = Math.max(0, ...read.map((entry) => entry.round ?? 0));
  const reviews = read
    .map((entry) => ({ ...entry, round: entry.round ?? highest + 1 }))
    .sort((left, right) => left.round - right.round || left.file.localeCompare(right.file));

  return {
    dir,
    ...archiveName(dir),
    reviews: reviews.map((entry) => ({ file: entry.file, round: entry.round, sameAs: null, items: itemsOf(entry.report) })),
    texts: new Map(reviews.map((entry) => [entry.file, entry.text])),
  };
}

/**
 * Every archived attempt at an issue, oldest first, with its plan reviews.
 *
 * `found` is false when the issue has no archive. An attempt archived before
 * any review was written is listed with no reviews: it is still an attempt.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<{issue: number, archive: string, found: boolean, attempts: ArchivedAttempt[]}>}
 */
export async function lessons(issue, options = {}) {
  const root = join(paths(options.home ?? resolveHome()).archive, String(issue));
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (entries === null) return { issue, archive: root, found: false, attempts: [] };

  const attempts = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readAttempt(root, entry.name)));
  const byTime = (left, right) =>
    (left.archivedAt ?? '￿').localeCompare(right.archivedAt ?? '￿') || left.dir.localeCompare(right.dir);
  const RANK = { reset: 0, other: 1, rollback: 2 };

  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const attempt of [...attempts].sort((left, right) => RANK[left.kind] - RANK[right.kind] || byTime(left, right))) {
    for (const review of attempt.reviews) {
      const text = /** @type {string} */ (attempt.texts.get(review.file));
      const first = seen.get(text);
      if (first) {
        review.sameAs = first;
        review.items = [];
      } else {
        seen.set(text, `${attempt.dir}/${review.file}`);
      }
    }
  }

  return {
    issue,
    archive: root,
    found: true,
    attempts: attempts.sort(byTime).map(({ texts: _texts, ...attempt }) => attempt),
  };
}
