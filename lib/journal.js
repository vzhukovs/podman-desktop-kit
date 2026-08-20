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

// The global append-only journal.
//
// state.json knows WHERE we are. The journal knows WHY. "Why is slice #2 in a
// stack instead of branching from main" is recoverable six months later only
// from here.
//
// INVARIANT: append only. This module has no rewrite and no delete. Monthly
// files exist so `--since` does not read a year of history to answer a question
// about last week, and so the re-anchoring injection stays small.

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { paths, resolveHome } from './config.js';

/** Placeholder for a field an entry does not have. */
const ABSENT = '—';

/** `2026-08-02`, or a full `2026-08-02T13:45:00Z`. */
const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?Z?)?$/;

/** `90m`, `2h`, `7d`, `3w`. Bare digits are refused: `24` is not a unit. */
const AGO = /^(\d+)\s*(m|h|d|w)$/;

const AGO_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };

/**
 * Turn what a person typed after `--since` into the timestamp entries compare
 * against.
 *
 * Entries are filtered by string comparison against an ISO timestamp, and that
 * detail used to leak all the way to the command line. `--since 1h` sorted
 * above every date, so nothing was filtered and the whole journal came back;
 * `--since 24h` sorted below every date, so the month files were skipped and
 * nothing came back at all. Two opposite wrong answers, both delivered without
 * an error, to a flag whose entire job is to narrow a search.
 *
 * So durations are understood, and anything else is refused by name rather
 * than silently compared as text.
 *
 * @param {string} value
 * @param {number} [now] milliseconds, for tests
 * @returns {{ok: true, at: string} | {ok: false, error: string}}
 */
export function resolveSince(value, now = Date.now()) {
  const text = String(value ?? '').trim();

  if (ISO_PREFIX.test(text)) return { ok: true, at: text };

  const ago = AGO.exec(text.toLowerCase());
  if (ago) {
    const at = new Date(now - Number.parseInt(ago[1], 10) * AGO_MS[ago[2]]);
    return { ok: true, at: `${at.toISOString().slice(0, 19)}Z` };
  }

  return {
    ok: false,
    error: `--since ${text}: expected a date (2026-08-02) or an age (90m, 2h, 7d, 3w)`,
  };
}

/** Every entry line starts with a timestamp; anything else in the file is prose. */
const ENTRY_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(\S+)\s+(\S+)\s+event:(\S+)\s*(.*)$/;

/**
 * @typedef {object} Entry
 * @property {string} at      ISO 8601
 * @property {number|null} issue
 * @property {number|null} slice
 * @property {string} event
 * @property {string} detail
 */

/**
 * Second-resolution ISO 8601, matching the format in section 2.3. Milliseconds
 * would make the column widths jitter for no gain: the journal is read by
 * people at least as often as by code.
 *
 * @param {Date} [when]
 * @returns {string}
 */
export function timestamp(when = new Date()) {
  return `${when.toISOString().slice(0, 19)}Z`;
}

/**
 * Month file an instant belongs to.
 *
 * @param {string} at ISO 8601
 * @returns {string} e.g. "2026-07.md"
 */
function monthFile(at) {
  return `${at.slice(0, 7)}.md`;
}

/**
 * Format one entry as the single line section 2.3 specifies.
 *
 * @param {Entry} entry
 * @returns {string}
 */
export function formatEntry(entry) {
  const issue = entry.issue == null ? ABSENT : `issue:${entry.issue}`;
  const slice = entry.slice == null ? ABSENT : `slice:${entry.slice}`;
  // Newlines would break the one-entry-per-line invariant the reader depends
  // on, and a truncated journal is worse than a verbose one.
  const detail = String(entry.detail ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();

  return `${entry.at}  ${issue.padEnd(12)}  ${slice.padEnd(8)}  event:${entry.event}  ${detail}`.trimEnd();
}

/**
 * Parse a journal line back into an entry, or null when the line is not one.
 *
 * @param {string} line
 * @returns {Entry|null}
 */
export function parseEntry(line) {
  const match = ENTRY_LINE.exec(line.trim());
  if (!match) return null;

  const [, at, issueField, sliceField, event, detail] = match;
  const number = (field, prefix) => (field.startsWith(prefix) ? Number.parseInt(field.slice(prefix.length), 10) : null);

  return {
    at,
    issue: number(issueField, 'issue:'),
    slice: number(sliceField, 'slice:'),
    event,
    detail: detail.trim(),
  };
}

/**
 * Append one entry. There is no counterpart that removes entries; that is the
 * point of the module.
 *
 * @param {Omit<Entry, 'at'> & {at?: string}} entry
 * @param {{home?: string}} [options]
 * @returns {Promise<Entry>} the entry as written
 */
export async function append(entry, options = {}) {
  const written = {
    at: entry.at ?? timestamp(),
    issue: entry.issue ?? null,
    slice: entry.slice ?? null,
    event: entry.event,
    detail: entry.detail ?? '',
  };

  const dir = paths(options.home ?? resolveHome()).journal;
  await mkdir(dir, { recursive: true });
  // Flag "a" is the whole guarantee: no truncation, and concurrent sessions
  // interleave lines instead of losing them.
  await appendFile(join(dir, monthFile(written.at)), `${formatEntry(written)}\n`, { flag: 'a' });

  return written;
}

/**
 * The two conflicts a rebase produces, and the only events this module lets a
 * caller name.
 *
 * Section 2.3 has carried `event:conflict-semantic` in its example since 0.1
 * and /pd:resume has told the model to "journal the resolution" for as long as
 * it has had a body — with nothing on the command line that could write one.
 * The instruction was unexecutable, which is worse than absent: it reads, in
 * review, as a discipline that is being kept.
 *
 * A conflict is the one thing in the cycle that nothing can observe for us. A
 * receipt is a capture, a slice verdict is a run, a merge is an API answer —
 * each closed to agents precisely because a machine can produce it. What
 * upstream rewrote under a plan is visible only to whoever resolved it, and if
 * they do not write it down it is gone.
 *
 * So the vocabulary is closed instead of the command being general. A
 * `journal write --event <anything>` would let `preflight-green` be typed next
 * to the one preflight produced, and the reader six months later cannot tell a
 * typed event from a measured one. Two names, both meaning something no
 * measurement could have written, and no third.
 *
 * @type {['mechanical', 'semantic']}
 */
export const CONFLICT_KINDS = ['mechanical', 'semantic'];

/** `A1`, `A12` — an amendment as the plan and the slices cite it. */
const AMENDMENT_ID = /^A\d+$/;

/**
 * The event `pdkit reset` writes, and the one entry that changes how earlier
 * entries are read.
 *
 * It lives here rather than in lib/reset.js because two modules have to agree
 * on it and this is the only one both already depend on. lib/attempts.js counts
 * failed captures out of the journal and has to stop at a reset — task numbering
 * restarts with the record, so the T1 after one is a different task from the T1
 * before it. Reaching for the name through lib/reset.js would pull the GitHub
 * client and the slicer into every session-start hook to learn a five-letter
 * string.
 *
 * Not part of the closed vocabulary above, and for the opposite reason: this
 * entry is written BY the command that did the thing, like every other event
 * here. `conflict-*` and the deferrals are closed because a person types them.
 */
export const RESET_EVENT = 'reset';

/**
 * Compose the entry for a resolved conflict, or say why it is not one.
 *
 * `resolution` is required and has no default, for the reason `task unblock`
 * and `issue adopt` require theirs: the line exists to be read by someone who
 * was not there, and "there was a conflict in exec.ts" tells them nothing they
 * could not get from the rebase itself.
 *
 * @param {{kind: string, file: string, resolution: string, commit?: string|null, amendment?: string|null}} input
 * @returns {{ok: true, event: string, detail: string} | {ok: false, error: string}}
 */
export function conflictEntry(input) {
  const kind = String(input.kind ?? '').trim();
  if (!CONFLICT_KINDS.includes(/** @type {'mechanical'|'semantic'} */ (kind))) {
    return { ok: false, error: `--kind ${kind || '<missing>'}: expected ${CONFLICT_KINDS.join(' or ')}` };
  }

  const file = String(input.file ?? '').trim();
  if (!file) return { ok: false, error: '--file <path> is required: a conflict happened somewhere' };

  const resolution = String(input.resolution ?? '').trim();
  if (!resolution) {
    return {
      ok: false,
      error: '--resolution <what you did and why> is required — an entry that only says a conflict existed is one the rebase already said',
    };
  }

  const commit = String(input.commit ?? '').trim();
  const amendment = String(input.amendment ?? '').trim();
  if (amendment && !AMENDMENT_ID.test(amendment)) {
    return { ok: false, error: `--amendment ${amendment}: expected an allocated A-ID such as A1` };
  }

  const detail = [
    `${file}${commit ? ` (upstream ${commit})` : ''}`,
    ' — ',
    resolution,
    amendment ? `; plan amended ${amendment}` : '',
  ].join('');

  return { ok: true, event: `conflict-${kind}`, detail };
}

/**
 * Read entries, filtered. The per-issue view is generated, never stored —
 * a stored copy is a second source of truth that drifts.
 *
 * @param {{issue?: number, since?: string, event?: string}} [filter]
 * @param {{home?: string}} [options]
 * @returns {Promise<Entry[]>}
 */
export async function read(filter = {}, options = {}) {
  const dir = paths(options.home ?? resolveHome()).journal;

  let files;
  try {
    files = (await readdir(dir)).filter((name) => /^\d{4}-\d{2}\.md$/.test(name)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  // The point of monthly files: a question about last week opens one file, not
  // a year of them.
  if (filter.since) {
    const sinceMonth = filter.since.slice(0, 7);
    files = files.filter((name) => name.slice(0, 7) >= sinceMonth);
  }

  const entries = [];
  for (const name of files) {
    const content = await readFile(join(dir, name), 'utf8');
    for (const line of content.split('\n')) {
      const entry = parseEntry(line);
      if (!entry) continue;
      if (filter.issue != null && entry.issue !== filter.issue) continue;
      if (filter.event && entry.event !== filter.event) continue;
      if (filter.since && entry.at < filter.since) continue;
      entries.push(entry);
    }
  }

  return entries;
}

/** How much history the re-anchoring summary carries by default. */
export const REANCHOR_LIMIT = 8;

/**
 * The journal half of the SessionStart summary: the last few entries for one
 * issue, oldest first.
 *
 * Deliberately not the whole journal, and deliberately scoped to one issue
 * (`journal.reanchor_scope`). The file grows month over month; injecting it
 * would consume the context this exists to restore, and by the time that
 * became obvious it would be a habit.
 *
 * Oldest first because it is read as a story — what happened, then what
 * happened next — and the reader is being reminded rather than searching.
 *
 * @param {number} issue
 * @param {{limit?: number, home?: string}} [options]
 * @returns {Promise<string>}
 */
export async function reanchor(issue, options = {}) {
  const entries = await read({ issue }, options);
  const limit = options.limit ?? REANCHOR_LIMIT;

  return entries
    .slice(-limit)
    .map((entry) => `${entry.at}  ${entry.event}${entry.detail ? `  ${entry.detail}` : ''}`)
    .join('\n');
}
