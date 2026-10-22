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

// What an issue is waiting on.
//
// A reviewer asks for "a PR before this one" — on DESKTOP-18833, benoitf wanted
// the image checker API and the empty-RepoTags fix to land ahead of #19375.
// When that earlier change touches files this issue's slices already own, the
// slice model cannot hold both: a slice is the diff restricted to its files, so
// one file has one slice. The earlier work goes in an issue of its own, and
// this one waits for it.
//
// Nothing recorded the waiting. `next` kept printing `/pd:pr-sync`, `pr list`
// showed a pull request with open threads and no reason they stayed open, and
// the only place the dependency lived was a reply on GitHub.
//
// Derived from the journal, as lib/deferrals.js is and for the same reasons: a
// stored copy would be a second source of truth and a second writer for
// state.json, and an append-only entry outlives whatever state the issue ends
// in. The opposite direction to a deferral, and that is why it is not one: a
// deferral is work set aside for after this merges, a block is work that must
// merge before it.
//
// Nothing here decides whether the blocker has landed. `check` reads its state
// from GitHub and reports it; lifting the block is a separate, explicit entry,
// because "the issue closed" and "what this one waited for has merged" are not
// always the same thing, and the person is the one who knows which it was.

import { append, read } from './journal.js';

/** Journal events this module reads and writes. A closed vocabulary. */
export const EVENTS = {
  blocked: 'blocked',
  unblocked: 'unblocked',
};

/**
 * One thing an issue waits on.
 *
 * @typedef {object} Block
 * @property {number} by           the upstream issue that must land first
 * @property {string} reason       what it carries, as the person stated it
 * @property {string} at
 * @property {'open'|'lifted'} status
 * @property {string} liftReason
 * @property {string|null} liftedAt
 */

/** `#18950 — reason`, the one shape both entries are written in. */
function detailOf(by, reason) {
  return `#${by}${reason ? ` — ${reason}` : ''}`;
}

/** @param {string} detail */
function partsOf(detail) {
  const match = /^#(\d+)\s*(?:—\s*(.*))?$/s.exec(String(detail ?? '').trim());
  return match ? { by: Number.parseInt(match[1], 10), text: (match[2] ?? '').trim() } : null;
}

/**
 * Every block an issue has had, oldest first, with whether it was lifted.
 *
 * @param {{issue: number, home?: string}} input
 * @returns {Promise<Block[]>}
 */
export async function list(input) {
  const entries = await read({ issue: input.issue }, { home: input.home });
  /** @type {Map<number, Block>} */
  const found = new Map();

  for (const entry of entries) {
    if (entry.event !== EVENTS.blocked && entry.event !== EVENTS.unblocked) continue;
    const parts = partsOf(entry.detail);
    if (!parts) continue;

    if (entry.event === EVENTS.blocked) {
      // Blocking again on the same issue reopens it: the newest statement of
      // why is the one that holds.
      found.set(parts.by, { by: parts.by, reason: parts.text, at: entry.at, status: 'open', liftReason: '', liftedAt: null });
    } else {
      const block = found.get(parts.by);
      if (block && block.status === 'open') Object.assign(block, { status: 'lifted', liftReason: parts.text, liftedAt: entry.at });
    }
  }

  return [...found.values()];
}

/**
 * The blocks still in force.
 *
 * @param {{issue: number, home?: string}} input
 * @returns {Promise<Block[]>}
 */
export async function open(input) {
  return (await list(input)).filter((block) => block.status === 'open');
}

/**
 * Record that an issue waits on another.
 *
 * @param {{issue: number, by: number, reason: string, home?: string}} input
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function block(input) {
  if (!Number.isInteger(input.by) || input.by < 1) return { ok: false, error: '--by <issue> is required: the upstream issue that must land first' };
  if (input.by === input.issue) return { ok: false, error: `#${input.issue} cannot wait on itself` };

  const reason = String(input.reason ?? '').trim();
  if (!reason) {
    return {
      ok: false,
      error: '--reason <text> is required: what the other issue carries that this one needs. Without it the block reads as an arbitrary wait',
    };
  }

  if ((await open(input)).some((entry) => entry.by === input.by)) return { ok: false, error: `#${input.issue} already waits on #${input.by}` };

  await append({ issue: input.issue, event: EVENTS.blocked, detail: detailOf(input.by, reason) }, { home: input.home });
  return { ok: true };
}

/**
 * Record that what an issue waited on has landed, or no longer matters.
 *
 * @param {{issue: number, by: number, reason?: string, home?: string}} input
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function unblock(input) {
  if (!(await open(input)).some((entry) => entry.by === input.by)) return { ok: false, error: `#${input.issue} does not wait on #${input.by}` };

  await append({ issue: input.issue, event: EVENTS.unblocked, detail: detailOf(input.by, String(input.reason ?? '').trim()) }, { home: input.home });
  return { ok: true };
}

/**
 * One line for `next`, `state` and `pr list` to print.
 *
 * @param {Block[]} blocks
 * @returns {string}
 */
export function summary(blocks) {
  return blocks.map((entry) => `#${entry.by}`).join(', ');
}
