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

// What was set aside, and what would settle it.
//
// `/pd:pr-sync` has offered four classifications for a review thread since it
// was written — accept, discuss, defer, reject — and three of them lead
// somewhere. `defer` did not: nothing recorded it, so the decision existed only
// as whatever the reply happened to say. On DESKTOP-18248 that is exactly what
// happened. A reviewer asked, after the pull request had merged, what a very
// long container command does to the display; the answer was that truncation
// belongs to the renderer, with a promise to open a follow-up issue. The promise
// lived in a comment on a merged pull request and nowhere else, and `close
// --finish` would have moved the issue to `merged` — terminal — without a word.
//
// So a deferral is a record, and it is DERIVED from the journal rather than
// stored, for the reasons lib/attempts.js gives for the attempt count: a stored
// copy is a second source of truth, storing it on the issue would need a second
// writer for state.json (invariant 1), and the journal is append-only, so an
// entry outlives the terminal state the issue ends in. That last property is the
// whole point — a promise that survives `merged` is the thing that was missing.
//
// Nothing here decides anything. Whether a thread is worth deferring, and
// whether the follow-up was the right one, is judgement; this module answers
// what was deferred, by whom, and whether anything has settled it.

import { append, read } from './journal.js';

/**
 * Journal events this module reads and writes.
 *
 * A closed vocabulary, exactly as `journal conflict` keeps one: a command that
 * could write any event would let `preflight-green` be typed beside the one
 * preflight measured, and six months later a reader cannot tell a typed event
 * from a produced one.
 */
export const EVENTS = {
  deferred: 'deferred',
  resolved: 'deferral-resolved',
  dropped: 'deferral-dropped',
};

/** `D1`, `D12` — a deferral as the follow-up issue and the journal cite it. */
export const DEFERRAL_ID = /^D\d+$/;

/** The leading `D<k>` of a journal detail, or null. */
function idOf(detail) {
  const match = /^(D\d+)\b/.exec(String(detail ?? '').trim());
  return match ? match[1] : null;
}

/** Everything after `D<k> — `, which is what a person wrote. */
function textOf(detail) {
  return String(detail ?? '')
    .trim()
    .replace(/^D\d+\s*(?:—|-)?\s*/, '')
    .trim();
}

/**
 * Split a `deferred` detail back into its parts.
 *
 * The entry is one line because the journal is one line per entry, and the
 * parts are separated again here because `close` prints this at the moment
 * somebody is deciding whether to act on it. A statement with a login, a pull
 * request number and a URL run together at the end is a statement people stop
 * reading before the end.
 *
 * @param {string} detail
 * @returns {{what: string, raisedBy: string, pr: number|null, url: string}}
 */
function partsOf(detail) {
  let text = textOf(detail);
  let url = '';
  let raisedBy = '';
  let pr = null;

  const link = /\s(https?:\/\/\S+)$/.exec(text);
  if (link) {
    url = link[1];
    text = text.slice(0, link.index).trim();
  }

  const source = /\s\(([^()]*)\)$/.exec(text);
  if (source) {
    for (const part of source[1].split(',').map((piece) => piece.trim())) {
      const number = /^#(\d+)$/.exec(part);
      if (number) pr = Number.parseInt(number[1], 10);
      else if (part) raisedBy = part;
    }
    text = text.slice(0, source.index).trim();
  }

  return { what: text, raisedBy, pr, url };
}

/**
 * Compose the detail of a `deferred` entry.
 *
 * Kept here rather than in the command so the reader and the writer agree on
 * one shape. `what` is required and the rest are not: a deferral raised while
 * planning has no pull request and no reviewer, and refusing it for that would
 * make the command useless in half the cases it exists for.
 *
 * @param {{id: string, what: string, pr?: number|null, raisedBy?: string|null, url?: string|null}} input
 * @returns {{ok: boolean, detail?: string, error?: string}}
 */
export function deferredEntry(input) {
  const id = String(input.id ?? '').trim();
  if (!DEFERRAL_ID.test(id)) return { ok: false, error: `${id || '(none)'}: expected an allocated D-ID such as D1` };

  const what = String(input.what ?? '').trim();
  if (!what) {
    return {
      ok: false,
      error: '--what <text> is required — a deferral with no statement of what was set aside is a note that it happened',
    };
  }

  const by = String(input.raisedBy ?? '').trim();
  const pr = Number.isInteger(input.pr) ? `#${input.pr}` : '';
  const source = [by, pr].filter(Boolean).join(', ');

  return {
    ok: true,
    detail: [`${id} — ${what}`, source ? ` (${source})` : '', input.url ? ` ${String(input.url).trim()}` : ''].join(''),
  };
}

/**
 * Something set aside on purpose, with enough of the original to settle it later.
 *
 * The `url` and the reviewer's own words are kept because a deferral is usually
 * read months later by somebody who was not there, and a paraphrase of a request
 * is an answer to a slightly different one. `status` closes three ways —
 * resolved into a follow-up issue, dropped with a reason, or still open — and a
 * dropped one keeps the reason, since that is the only record of why a
 * reviewer's point is not being acted on.
 *
 * @typedef {object} Deferral
 * @property {string} id
 * @property {string} what        what was set aside, as the person stated it
 * @property {string} raisedBy    who asked, when a person did
 * @property {number|null} pr     the pull request the thread was on, if it was on one
 * @property {string} url         the comment itself, so the words are one click away
 * @property {string} at          when it was raised
 * @property {'open'|'resolved'|'dropped'} status
 * @property {number|null} followUp   the issue that took it on, once there is one
 * @property {string} outcome     the reason it was dropped, or how it was resolved
 * @property {string|null} outcomeAt
 */

/**
 * Every deferral of an issue, oldest first, with what became of it.
 *
 * @param {{issue: number, home?: string}} input
 * @returns {Promise<Deferral[]>}
 */
export async function list(input) {
  const entries = await read({ issue: input.issue }, { home: input.home });

  /** @type {Map<string, Deferral>} */
  const found = new Map();

  for (const entry of entries) {
    const id = idOf(entry.detail);
    if (!id) continue;

    if (entry.event === EVENTS.deferred) {
      found.set(id, { id, ...partsOf(entry.detail), at: entry.at, status: 'open', followUp: null, outcome: '', outcomeAt: null });
      continue;
    }

    const known = found.get(id);
    if (!known) continue;

    if (entry.event === EVENTS.resolved) {
      const number = /#(\d+)/.exec(entry.detail);
      known.status = 'resolved';
      known.followUp = number ? Number.parseInt(number[1], 10) : null;
      known.outcome = textOf(entry.detail);
      known.outcomeAt = entry.at;
    }

    if (entry.event === EVENTS.dropped) {
      known.status = 'dropped';
      known.outcome = textOf(entry.detail);
      known.outcomeAt = entry.at;
    }
  }

  return [...found.values()];
}

/**
 * The deferrals nothing has settled yet.
 *
 * What `close` reports, and the reason this module exists at all.
 *
 * @param {{issue: number, home?: string}} input
 * @returns {Promise<Deferral[]>}
 */
export async function open(input) {
  return (await list(input)).filter((entry) => entry.status === 'open');
}

/**
 * Record that something was set aside.
 *
 * @param {{issue: number, id: string, what: string, pr?: number|null, raisedBy?: string|null, url?: string|null, home?: string}} input
 * @returns {Promise<{ok: boolean, entry?: object, error?: string}>}
 */
export async function defer(input) {
  const composed = deferredEntry(input);
  if (!composed.ok) return { ok: false, error: composed.error };

  const entry = await append({ issue: input.issue, event: EVENTS.deferred, detail: composed.detail }, { home: input.home });
  return { ok: true, entry };
}

/**
 * Record what settled a deferral: a follow-up issue, or a reason it is dropped.
 *
 * Both take a fact rather than a verdict. `--follow-up` is a number that either
 * exists or does not, and `--reason` on a drop is the only record of why
 * something a reviewer raised is not being done — the same rule as `task
 * unblock` and `issue adopt`.
 *
 * @param {{issue: number, id: string, followUp?: number|null, reason?: string|null, home?: string}} input
 * @returns {Promise<{ok: boolean, entry?: object, error?: string}>}
 */
export async function settle(input) {
  const id = String(input.id ?? '').trim().toUpperCase();
  if (!DEFERRAL_ID.test(id)) return { ok: false, error: `${id || '(none)'}: expected an allocated D-ID such as D1` };

  const known = (await list(input)).find((entry) => entry.id === id);
  if (!known) return { ok: false, error: `DESKTOP-${input.issue} has no ${id}` };
  if (known.status !== 'open') return { ok: false, error: `${id} is already ${known.status}` };

  const dropping = input.followUp === undefined || input.followUp === null;

  if (dropping) {
    const reason = String(input.reason ?? '').trim();
    if (!reason) {
      return {
        ok: false,
        error: '--reason <why> is required to drop a deferral — it is the only record of why something a reviewer raised is not being done',
      };
    }
    const entry = await append({ issue: input.issue, event: EVENTS.dropped, detail: `${id} — ${reason}` }, { home: input.home });
    return { ok: true, entry };
  }

  if (!Number.isInteger(input.followUp)) return { ok: false, error: '--follow-up takes the number of the issue that took this on' };

  const entry = await append(
    { issue: input.issue, event: EVENTS.resolved, detail: `${id} — taken on by #${input.followUp}` },
    { home: input.home },
  );
  return { ok: true, entry };
}
