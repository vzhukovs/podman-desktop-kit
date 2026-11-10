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

// The self-review record: what the four review axes found on our own pull
// request, for which commit and which body.
//
// INVARIANT: this module is the only writer of
// $PDKIT_HOME/issues/<n>/self-review.json.
//
// Upstream's review agent reads every pull request against the maintainer's
// rules. The self-review is the same reading done by us first, and this
// record is how the `self-review` preflight check knows it happened on what is
// about to be published: the commit and the body are part of the entry, so a
// review of an earlier commit or an earlier body proves nothing about this one.
//
// It holds facts. Which findings are still open is derived from the labels by
// `unresolved`, the way validation derives a step's status from its evidence.
// There is no input through which "the review is clean" can be typed.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { issueDir, resolveHome } from './config.js';
import { append as appendJournal } from './journal.js';

/**
 * The four axes of /pd:review-pr. All four, because upstream's agent walks
 * every section of the rules, and an axis left out is a section nobody read.
 */
export const AXES = ['architecture', 'api-compat', 'tests', 'product'];

/** Semantic Code Reviews labels, as upstream's procedure uses them. */
export const LABELS = ['issue', 'nit', 'question'];

/**
 * One finding, as the synthesis returned it.
 *
 * @typedef {object} Finding
 * @property {'issue'|'nit'|'question'} label
 * @property {string} text
 * @property {string|null} path
 * @property {number|null} line
 * @property {number|null} section       of maintainer-rules.md; null when outside the rule set
 * @property {boolean} preExisting       the violation was in the file before this branch
 * @property {string|null} answer        for a question: how the pull request answers it
 */

/**
 * @typedef {object} Entry
 * @property {string} sha                the commit the axes read
 * @property {string} bodyDigest         sha256 of the normalized PR body they read
 * @property {string[]} axes
 * @property {Finding[]} findings
 * @property {string} recordedAt
 */

/**
 * @param {string} home
 * @param {number} issue
 */
const recordPath = (home, issue) => join(issueDir(home, issue), 'self-review.json');

/**
 * Which pull request of the issue an entry is for.
 *
 * @param {number|null|undefined} slice
 */
export const keyOf = (slice) => (Number.isInteger(slice) ? `slice-${slice}` : 'single');

/**
 * The digest of a PR body, insensitive to what GitHub does to line endings
 * and trailing whitespace on the way in and out.
 *
 * @param {string} body
 * @returns {string}
 */
export function bodyDigest(body) {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * The findings that still stand between this pull request and publishing.
 *
 * - every `issue:`: upstream's verdict table rejects on one;
 * - every `nit:` on code this branch wrote. A nit is optional for upstream's
 *   approval, and still a rule the maintainer raises. A pre-existing one stays,
 *   because fixing it here is the drive-by change section 1 rejects;
 * - every `question:` with no answer. A question is a rule the reviewer
 *   suspects; the pull request has to say why it holds.
 *
 * @param {Entry} entry
 * @returns {Finding[]}
 */
export function unresolved(entry) {
  return entry.findings.filter(
    (finding) =>
      finding.label === 'issue' || (finding.label === 'nit' && !finding.preExisting) || (finding.label === 'question' && !finding.answer),
  );
}

/**
 * Validate and normalize what the synthesis returned.
 *
 * @param {unknown} given
 * @returns {{ok: true, findings: Finding[]} | {ok: false, error: string}}
 */
export function parseFindings(given) {
  if (!Array.isArray(given)) return { ok: false, error: '`findings` must be a list (an empty one when nothing was found)' };

  const findings = [];
  for (const [index, raw] of given.entries()) {
    const at = `finding ${index + 1}`;
    if (raw === null || typeof raw !== 'object') return { ok: false, error: `${at} is not an object` };
    if (!LABELS.includes(raw.label)) return { ok: false, error: `${at}: label must be one of ${LABELS.join(', ')}` };
    if (typeof raw.text !== 'string' || raw.text.trim() === '') return { ok: false, error: `${at}: text is required` };

    const section = raw.section ?? null;
    if (section !== null && !(Number.isInteger(section) && section >= 1 && section <= 12)) {
      return { ok: false, error: `${at}: section is a number from 1 to 12, or null for a finding outside the rule set` };
    }

    const line = raw.line ?? null;
    if (line !== null && !(Number.isInteger(line) && line > 0)) return { ok: false, error: `${at}: line is a positive integer` };

    findings.push({
      label: raw.label,
      text: raw.text.trim(),
      path: typeof raw.path === 'string' && raw.path !== '' ? raw.path : null,
      line,
      section,
      preExisting: raw.preExisting === true,
      answer: typeof raw.answer === 'string' && raw.answer.trim() !== '' ? raw.answer.trim() : null,
    });
  }

  return { ok: true, findings };
}

/**
 * Read the record for an issue.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<{issue: number, entries: Record<string, Entry>}|null>} null when no self-review ran
 */
export async function read(issue, options = {}) {
  const home = options.home ?? resolveHome();

  let raw;
  try {
    raw = await readFile(recordPath(home, issue), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    return { issue, entries: parsed.entries ?? {} };
  } catch (error) {
    throw new Error(`${recordPath(home, issue)}: the self-review record is not readable JSON`, { cause: error });
  }
}

/**
 * The entry for one pull request of the issue, or null.
 *
 * @param {{entries: Record<string, Entry>}|null} record
 * @param {number|null|undefined} slice
 * @returns {Entry|null}
 */
export function entryFor(record, slice) {
  return record?.entries[keyOf(slice)] ?? null;
}

/**
 * Record a self-review. Replaces the previous entry for the same pull request:
 * a review of an older commit says nothing about this one, so keeping it would
 * only give the check something stale to read.
 *
 * @param {{issue: number, slice?: number|null, sha: string, body: string, axes: unknown, findings: unknown, home?: string}} input
 * @returns {Promise<{ok: true, entry: Entry, unresolved: Finding[]} | {ok: false, error: string}>}
 */
export async function record(input) {
  const home = input.home ?? resolveHome();

  if (typeof input.sha !== 'string' || !/^[0-9a-f]{40}$/.test(input.sha)) return { ok: false, error: 'the commit under review is not a full sha' };
  if (typeof input.body !== 'string' || input.body.trim() === '') {
    return { ok: false, error: 'the PR body is empty: the self-review reads the title and body before the code, as upstream does' };
  }

  const axes = Array.isArray(input.axes) ? input.axes : [];
  const missing = AXES.filter((axis) => !axes.includes(axis));
  if (missing.length > 0) return { ok: false, error: `axes not run: ${missing.join(', ')}. All four read the diff, or the review is a partial one` };

  const parsed = parseFindings(input.findings);
  if (!parsed.ok) return parsed;

  /** @type {Entry} */
  const entry = {
    sha: input.sha,
    bodyDigest: bodyDigest(input.body),
    axes: [...AXES],
    findings: parsed.findings,
    recordedAt: new Date().toISOString(),
  };

  const current = (await read(input.issue, { home })) ?? { issue: input.issue, entries: {} };
  const next = { issue: input.issue, entries: { ...current.entries, [keyOf(input.slice)]: entry } };

  const file = recordPath(home, input.issue);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, file);

  const open = unresolved(entry);
  await appendJournal(
    {
      issue: input.issue,
      slice: Number.isInteger(input.slice) ? input.slice : null,
      event: 'self-review',
      detail: `${input.sha.slice(0, 8)}: ${entry.findings.length} finding(s), ${open.length} unresolved`,
    },
    { home },
  );

  return { ok: true, entry, unresolved: open };
}
