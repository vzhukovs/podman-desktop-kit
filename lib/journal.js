// SPDX-License-Identifier: Apache-2.0

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
